# @flowcastle/telegraf

[![npm](https://img.shields.io/npm/v/@flowcastle/telegraf)](https://www.npmjs.com/package/@flowcastle/telegraf) · Part of [flowcastle-sdk](https://github.com/FlowCastle/flowcastle-sdk). Get an API key: FlowCastle dashboard → your application → **Add bot → Code SDK**.

Privacy-first FlowCastle middleware for existing [Telegraf](https://telegraf.js.org)
bots. It observes incoming updates, exposes contacts/goals/Live Chat helpers,
and can opt into FlowCastle's proxy runtime without taking over unmatched bot
middleware.

## Install

```bash
npm install @flowcastle/telegraf telegraf
```

Node.js 18 or later is required.

## Use it

```ts
import { Telegraf } from 'telegraf';
import { flowcastle } from '@flowcastle/telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN!);
const flowcastleMiddleware = flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
});

// Recommended: this observes bot.telegram calls made before the first update.
flowcastleMiddleware.wrapTelegram(bot.telegram);
bot.use(flowcastleMiddleware);

bot.on('text', async (ctx) => {
  ctx.flowcastle.goal('message_received');
  await ctx.reply('Hello');
});

bot.launch();
```

Telegraf routes every Bot API request through `telegram.callApi`. The adapter
wraps that gateway without changing a call's result or error. Middleware
installs the wrapper lazily for `ctx.telegram`; call `wrapTelegram(bot.telegram)`
before `launch()` when the app sends through `bot.telegram` before its first
incoming update. Calls sent through a different `Telegram` instance must be
wrapped explicitly too.

## Use code and no-code flows together

Keep framework-native commands and custom business logic in this bot, and build
complementary onboarding, campaign, follow-up, or support automations in
FlowCastle's no-code editor. Both kinds appear in the same Automation workspace:

- **Observed flows** are read-only maps reconstructed from SDK traffic. They
  make code-owned behavior visible without pretending the canvas is its source
  of truth.
- **FlowCastle-authored flows** are editable and deployable from the no-code
  editor. They can claim matching updates or be started explicitly from code.

Unmatched updates continue through the normal Telegraf middleware chain, so one
bot can use both models without a rewrite.

## Privacy

Privacy filtering happens inside the process before data enters an event buffer,
outage spool, or network request. It applies consistently to incoming updates,
observed outgoing payloads, runtime matching, matched-update ingest, and
`runFlow`. Your Telegraf handlers still receive the original update.

```ts
flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {
    contactFields: ['username'],
    messageContent: 'routing',
  },
});
```

Omit `privacy` to preserve legacy full-content behavior. Passing `{}` opts into
no optional contact fields and routing-only content. See
`@flowcastle/sdk-runtime` for the full privacy contract and async transformers.

## Goals, identification, and Live Chat

`ctx.flowcastle` is available during each handled update:

```ts
ctx.flowcastle.identify({ plan: 'pro' });
ctx.flowcastle.goal('checkout_complete', { value: 49 });
ctx.flowcastle.requestLiveAgent({ note: 'Needs billing help' });

if (!ctx.flowcastle.isLiveAgentActive) {
  await ctx.reply('How can I help?');
}
```

`isLiveAgentActive` is a best-effort local time window, opened by an escalation
and refreshed when a Live Chat reply is delivered. It is not the server's
authoritative agent state.

## Proxy runtime

Enable the runtime to let FlowCastle own matched flow updates while this process
remains the Telegram transport:

```ts
const runtime = flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  runtime: { enabled: true },
});

await runtime.ready(); // preload manifest and conversation claims
runtime.wrapTelegram(bot.telegram);
bot.use(runtime);

bot.command('manual', async (ctx) => {
  await ctx.flowcastle.runFlow('welcome-flow', { inputs: { source: 'bot' } });
});
```

Manifest-matched updates and server-published conversation claims are consumed;
unmatched updates continue to downstream Telegraf middleware. Runtime jobs run
only through a hardcoded Bot API allowlist. Lifecycle/token/webhook methods
(`getUpdates`, `setWebhook`, `deleteWebhook`, `close`, and `logOut`) are always
refused locally, regardless of server input. The adapter supports canonical v2
`transport_call`/`control: conversation_claim` jobs and legacy runtime job
aliases during migration.

Call `destroy()` during application shutdown to stop timers and job polling.
