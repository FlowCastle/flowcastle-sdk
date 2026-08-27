# @flowcastle/grammy

Add FlowCastle — Contacts, Analytics, Goals, Live Chat, and Broadcasts — to your
existing [grammY](https://grammy.dev) bot with **one line**. The plugin observes
incoming updates and outgoing Bot API calls, batches them, and ships them to
FlowCastle. It never hosts your bot or takes over its logic. Observation and
transport failures are reported without being thrown into the middleware chain,
and analytics data is dropped when delivery cannot recover. Proxy-runtime
mode deliberately awaits delivery of updates it has claimed for a flow. A
configured async privacy transformer is awaited with a bounded timeout before
sanitized data continues through the FlowCastle middleware path.

## Install

```bash
npm install @flowcastle/grammy
# grammy is a peer dependency you already have
```

Requires Node.js ≥ 18 (uses native `fetch`). Zero runtime dependencies.

## Usage

```ts
import { Bot } from 'grammy';
import { flowcastle } from '@flowcastle/grammy';

const bot = new Bot(process.env.BOT_TOKEN!);

bot.use(flowcastle({ apiKey: 'fc_sdk_…' }));

bot.start();
```

That's it. Contacts, message analytics, blocked-user detection, and a live
"connected" indicator light up in your FlowCastle dashboard.

### Server-side FlowCastle flows (proxy runtime)

Enable the proxy runtime to let FlowCastle execute authored flows on its server
while your grammY process remains the Telegram transport. The same runtime
protocol is deliberately independent of grammY, so other Telegram libraries
(including Python clients) can implement it without reimplementing flows.

```ts
const runtime = flowcastle({
  apiKey: 'fc_sdk_…',
  runtime: { enabled: true },
});

// Optional: preload the trigger manifest before bot.start().
await runtime.ready();
bot.use(runtime);
```

Manifest-matched updates are consumed by FlowCastle; unmatched updates still
reach your handlers. Customer code can start a flow explicitly:

```ts
bot.command('onboard', async (ctx) => {
  const { executionId } = await ctx.flowcastle.runFlow('welcome-flow', {
    inputs: { source: 'customer-code' },
  });
  console.log(executionId);
});
```

The deployed flow must opt in with `sdkCallable: true` and a stable
`sdkCallableKey` (the value passed to `runFlow`). These fields are available on
the Flow GraphQL create/update inputs and are copied across flow versions.

Conversation ownership is server-authored. Waiting replies, menus, payments,
CAPTCHAs, and live-agent sessions are published as generation-safe claims and
polled by every SDK replica, so a reply does not fall through to customer
handlers just because another replica ran the preceding update.

Adapters for other libraries use the same JSON endpoints: manifest and claim
snapshots for routing, `/events` for matched updates, leased `/jobs` plus
`/jobs/ack` for transport calls, `/runtime/heartbeat` for identity/capabilities,
and `/runtime-runs` for explicit flow execution. No grammY objects appear in
that contract; a Python adapter only needs a Bot API dispatcher and JSON/file
marker decoding.

The proxy uses leased jobs with a lease token and full JSON result acknowledgements.
It executes only an explicit safe Telegram operation list (messages, media,
edits, payments, moderation and read helpers). Token/webhook lifecycle methods
such as `setWebhook`, `deleteWebhook`, `getUpdates`, `close`, and `logOut` are
hard-denied in the SDK regardless of server input. Binary payloads use a JSON
marker (`$flowcastleFile` with filename/base64) and are converted to grammY
`InputFile`; other SDKs provide their equivalent decoder.

## Privacy controls

Privacy filtering happens locally in the SDK before an update enters its
buffer, outage spool, or a network request. The same sanitized update is used
for observed events, proxy-runtime matching and ingest, and `runFlow()`. Your
grammY handlers still receive the original Telegram update.

Existing integrations that omit `privacy` keep the pre-policy behavior (all
supported profile fields and full message content). Explicitly passing
`privacy: {}` opts into the privacy-first defaults: no optional contact profile
fields and routing-only content.

```ts
bot.use(flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {
    // Telegram user id and operational chat/update ids are always retained.
    contactFields: ['username'],
    messageContent: 'routing',
  },
}));
```

### Contact fields

`privacy.contactFields` is an allowlist. Supported values are `username`,
`firstName`, `lastName`, `languageCode`, `isPremium`, and
`addedToAttachmentMenu`. Those optional Telegram user-profile fields are
removed when not listed. Telegram user id remains available so FlowCastle can
associate events with a stable contact; chat, update, and message ids remain
available for routing and idempotency. Restricted content modes also remove
chat/sender-chat titles and other descriptive content.

### Message content modes

| Mode | What FlowCastle receives |
| --- | --- |
| `full` | Message text, command arguments, captions, callback values, contact cards, locations, and media metadata. The enumerated text fields below are transformed when a callback is configured; structured values remain as received. |
| `routing` | Operational metadata, command names, and callback action identifiers. Free text, command arguments, captions, contact/location payloads, and media content are removed. |
| `none` | Operational ids, timestamps, and update shape only. Commands and callback values are also removed. |

`routing` supports command- and callback-driven flows. A flow that waits for a
free-text reply or evaluates message text requires `full`. With `none`,
content-based FlowCastle triggers do not claim the update.

### Transform or remove individual text values

With `mode: 'full'`, use `transformText` to run your own redaction locally. It
is invoked for message text, command arguments, captions, callback data, inline
queries, contact vCards, and inline-button labels. Return a string to replace
the value or `null` to remove it. In `routing`, only retained callback data is
passed through the transformer; in `none`, the transformer is not invoked.

The callback does not rewrite structured values such as phone numbers,
coordinates, payment amounts, or media identifiers in `full`. Choose `routing`
or `none` when those values must not be transmitted.

```ts
bot.use(flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {
    contactFields: [],
    messageContent: {
      mode: 'full',
      transformText: ({ value, field }) => {
        if (field === 'contactVCard') return null;

        return value
          .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, '[EMAIL]')
          .replace(/\b\d{16}\b/g, '[CARD]');
      },
    },
  },
}));
```

Async transformers are supported for local DLP services:

```ts
privacy: {
  messageContent: {
    mode: 'full',
    transformTimeoutMs: 750,
    transformText: async ({ value }) => localDlp.redact(value),
  },
}
```

Each async call has a 1000 ms default timeout. If the callback throws, rejects,
times out, or returns an invalid value, that individual field is dropped and
the error is sent to `onError`; the original value is never used as a fallback.
Changing text also removes Telegram entity offsets because they may no longer
match the transformed value. Incoming transformations finish before the update
enters the FlowCastle middleware path, so a slow async transformer adds the same
latency to update handling; prefer local, bounded work.

The policy covers automatically captured Telegram updates and observed Bot API
payloads. Values a developer explicitly supplies to `goal(props)`,
`identify(props)`, `requestLiveAgent({ note })`, or `runFlow({ inputs })` are
application-owned data and are not implicitly rewritten.

The policy types and sanitizer live in `@flowcastle/sdk-runtime`, independent of
grammY. The Telegraf and Python adapters expose the same modes, allowlist,
callback context, null/drop semantics, timeout, and fail-closed behavior.

### Goals & identify

Both are available on `ctx.flowcastle` inside your handlers:

```ts
bot.command('buy', async (ctx) => {
  ctx.flowcastle.goal('purchase', { value: 100 });
  ctx.flowcastle.identify({ plan: 'pro' });
  await ctx.reply('Thanks!');
});
```

### Escalate to a human (`requestLiveAgent` / `isLiveAgentActive`)

Hand the current conversation to a human agent in FlowCastle Live Chat, and let
your own handlers step aside while a human is engaged:

```ts
bot.command('support', async (ctx) => {
  ctx.flowcastle.requestLiveAgent({ note: 'User asked for a refund' });
  await ctx.reply('Connecting you to a human — one moment.');
});

bot.on('message', async (ctx) => {
  // Don't auto-reply over a human agent who's handling this chat.
  if (ctx.flowcastle.isLiveAgentActive) return;
  await ctx.reply(autoAnswer(ctx.message.text));
});
```

- **`requestLiveAgent(opts?: { note?: string })`** enqueues a `live_agent_request`
  event (with `telegramUserId`, `chatId`, and the optional `note`, clamped to 500
  chars) for FlowCastle. It is a no-op (reported via `onError`) if there is no
  `ctx.from`. Calling it also optimistically opens the local live-agent window
  for the chat (below).
- **`isLiveAgentActive`** is a **best-effort, optimistic** boolean. It is backed
  by a **local, per-plugin time window** — opened by `requestLiveAgent()` and
  refreshed whenever an agent reply is delivered through your bot (see
  `pullJobs`) — **not** by the authoritative server-side state (a future
  iteration may sync that down). Treat it as a hint that can be stale in either
  direction; it is `false` when there is no `ctx.chat`. The window length is
  controlled by `liveAgentWindowMs` (default 30 min).

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (required) | Your FlowCastle SDK key (`fc_sdk_…`). |
| `apiUrl` | `string` | `https://my.flowcastle.ai` | Ingest base URL. |
| `privacy` | `TelegramPrivacyOptions` | legacy-compatible when omitted | Local contact allowlist, message-content mode, and optional text transformer. Passing `{}` enables privacy-first defaults. |
| `redactText` | `boolean` | `false` | Deprecated compatibility shorthand. Use `privacy.messageContent`; any configured `privacy` policy wins. |
| `flushIntervalMs` | `number` | `3000` | How often buffered events are flushed. |
| `maxBatchSize` | `number` | `20` | Buffered events before an eager flush. Hard-clamped to `50`. |
| `pullJobs` | `boolean` | `true` | Pull and execute Live Chat delivery jobs through your bot. `false` disables it. |
| `liveAgentWindowMs` | `number` | `1800000` (30 min) | How long a chat stays `isLiveAgentActive` locally after a request or delivered agent reply. |
| `runtime` | `GrammyRuntimeOptions` | disabled | Enable server-side FlowCastle flow execution through the SDK bot. |
| `onError` | `(error: unknown) => void` | silent no-op | Observability hook for internal failures; never affects your bot. |

## Live Chat delivery (`pullJobs`)

When enabled (the default), the plugin also **pulls** outbound delivery jobs from
FlowCastle — e.g. replies a human agent types in the Live Chat inbox — and
executes them through your bot's own Telegram connection. It long-polls
`GET /api/sdk/v1/jobs`, executes each returned job, and acks the outcome to
`POST /api/sdk/v1/jobs/ack`. The loop is idle until your bot handles its first
update (so it only runs once it has a live Telegram connection), never throws
into your bot, and backs off on transport errors. Set `pullJobs: false` to opt
out entirely.

### Security: the plugin decides what may run

FlowCastle **cannot** make your bot do arbitrary things. The plugin enforces a
hardcoded allowlist of Bot API methods and refuses everything else, regardless
of what the server sends. The allowed surface covers messages, all runtime media
types (including stickers and video notes), edits, callbacks and checkout,
payments, chat actions, moderation, pins, and `getChatMember`/`getMe`.

Any job whose `method` is not in this list is **not executed** — it is acked
back as `ok: false, errorCode: 400` and reported via `onError`. Methods are
dispatched only through grammY's typed API (one explicit call per allowlisted
method), never by dynamically indexing an object with a server-supplied string.

## Typed context (`FlowCastleFlavor`)

Flavor your context type so `ctx.flowcastle` is typed everywhere:

```ts
import { Bot, Context } from 'grammy';
import { flowcastle, FlowCastleFlavor } from '@flowcastle/grammy';

type MyContext = FlowCastleFlavor<Context>;

const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);
bot.use(flowcastle({ apiKey: 'fc_sdk_…' }));

bot.on('message', (ctx) => {
  ctx.flowcastle.goal('message_received'); // fully typed
});
```

## License

MIT
