# FlowCastle grammY SDK: Proxy Flow Runtime Plan

**Status:** Accepted direction (2026-08-25) — supersedes `SDK_GRAMMY_LOCAL_FLOW_RUNTIME_PLAN.md`
**Scope:** `PlatformType.SDK` / `@flowcastle/grammy`
**Related:** `SDK_GRAMMY_PLUGIN_PLAN.md` (Phases 1–2.5 done; this doc is Phase 4)

## 1. One-paragraph summary

FlowCastle flows run for SDK bots **on the FlowCastle server, with the existing
`FlowExecutor`**. The customer's grammY process does two small things: (1) decide
locally, from a compiled *trigger manifest*, whether an update belongs to a FlowCastle
flow or to the customer's own handlers; (2) act as the Telegram transport — it ships
matched updates to the server and executes the server's outgoing calls
(`sendMessage`, `editMessageText`, `answerCallbackQuery`, …) through its own `bot.api`.
Nothing is compiled into a new runtime graph and no second interpreter exists.

```text
Telegram ──update──► customer grammY process
                       │  trigger manifest says "ours"?  no ──► next() (customer code)
                       │  yes
                       ▼
                 POST /api/sdk/v1/events            (already exists)
                       │
                       ▼
             FlowCastle runtime (bots pod)
             Bot + FlowExecutor + SdkProxyAdapter    ← same engine as hosted bots
                       │
                       ▼
                 SdkOutboundJob queue                (already exists: Live Chat)
                       │
                       ▼
             customer process long-polls GET /jobs  (already exists)
                       │
                       ▼
                 bot.api.sendMessage(...) ──► Telegram
```

## 2. Why this and not the local interpreter

The local-interpreter proposal (`SDK_GRAMMY_LOCAL_FLOW_RUNTIME_PLAN.md`) was reviewed
on 2026-08-25 and rejected because:

| Local interpreter | Proxy (this doc) |
|---|---|
| New AST→graph compiler + new interpreter. Runtime today is ~10.9k lines (`FlowExecutor` 4.5k, `NodeProcessor` 2.3k, `ActionProcessor` 3.3k) + CEL + template tokens + 24 `ActionKind`s. Parity must be proven feature by feature. | Zero new engine. Full parity on day one: AI, delays, broadcasts, sequences, CEL conditions, templates, i18n, all actions. |
| Still needs a synchronous `POST /interactions` per matched update, then session GET/PUT, then remote actions → 2–4 round trips. | 1 round trip in (`/events`) + 1 out (`/jobs`). Roughly equal latency. |
| First release supports only "/start → menu → save email" — the part a grammY dev can write in 20 lines. Everything valuable (AI, sequences, broadcasts) is remote/deferred anyway. | The valuable parts work first. |
| Every silent compile-mismatch bug class we already have (dropped MESSAGE-block actions, lost FLOW_LINK continuation, deep-link shadowing) gets a second surface. | One compile path. |
| Implies an eventual rewrite of the hosted runtime onto the new interpreter. | No change to hosted bots. |

The one thing the local design does better — zero network for *unmatched* updates and
deterministic precedence against customer handlers — is kept, via the trigger manifest.

## 3. Reused as-is

| Piece | Where | Note |
|---|---|---|
| Ingest endpoint + BullMQ worker | `api/src/controllers/SdkIngest.controller.ts`, `api/src/services/SdkIngest.service.ts`, `api/src/queues/sdk-event.queue.ts` | Updates already arrive here. Add a fast path to the runtime (§5.2). |
| Outbound job channel | `api/src/entities/SdkOutboundJob.entity.ts`, `api/src/services/SdkOutbox.service.ts`, `packages/sdk-grammy/src/jobs.ts` | Lease + ack, `FOR UPDATE SKIP LOCKED`, method allowlist on both sides. Extend the allowlist (§6). |
| Flow engine | `api/common-bot-module/src/core/*` | Untouched. |
| Runtime hosting model | `WebChatAdapter` + `RedisWebChatSubscriber` | Precedent for "a Bot in the bots pod whose inbound is not Telegram". |
| Sessions | `SessionStore` (Redis) | Unchanged; SDK bots get sessions exactly like hosted ones. |
| Deploy pipeline | `BotDeploymentService`, `LocalBotRunner` | Today both early-return on `PlatformType.SDK` (`BotDeployment.service.ts:125`, `LocalBotRunner.ts:114`). Change: compile + host, but with the proxy adapter. |

## 4. New pieces

### 4.1 `SdkProxyAdapter` (runtime)

`api/common-bot-module/src/adapters/SdkProxyAdapter.ts`, implements `PlatformAdapter`.

- `start()` subscribes to the inbound channel for this bot (Redis pub/sub or BullMQ,
  same shape as `RedisWebChatSubscriber`), maps raw Telegram `Update` → the adapter's
  incoming-message/callback/event shapes. Reuse `TelegramAdapter`'s update mapping by
  extracting the pure mapping functions; do not duplicate them.
- Every outgoing method (`sendMessage`, `sendMenu`, `sendMessageWithMedia`,
  `sendMenuWithMedia`, `sendWebAppButton`, edit/delete/answerCallback/chatAction,
  `getChatMember` where flows need it) becomes an `SdkOutboundJob` with
  `origin: 'flowcastle_runtime'` and correlation ids (`flowId`, `blockId`, `executionId`).
- Return value: the job row is created synchronously; the Telegram `message_id` arrives
  with the ack. Flows that need the id (edit-in-place, ephemeral delete) await the ack
  with a bounded timeout (default 10 s) — same classification as a Telegram transient
  error on timeout.
- Wire in `common-bot-module/src/Bot.ts` factory: `case PlatformType.SDK`.

### 4.2 Trigger manifest

Compiled at deploy time by the API from the same AST the runtime gets
(`FlowAstBuilder.service.ts` output), stored on the bot, served by
`GET /api/sdk/v1/manifest` with `ETag`/`If-None-Match` and long-poll `waitMs`.

```ts
interface SdkTriggerManifest {
  version: string;            // deploy id / etag
  commands: string[];         // '/start', '/help' — with chat-type scoping
  keywords: Array<{ match: 'equals' | 'contains' | 'starts_with' | 'regex'; value: string }>;
  deepLinkPrefixes: string[]; // /start payloads
  callbackPrefixes: string[]; // 'fc:' + any authored callback data namespaces
  catchAll: boolean;          // flow has an unfiltered message trigger
  chatTypes: Array<'private' | 'group' | 'supergroup' | 'channel'>;
}
```

Plus a per-chat **flow-active** flag: the server sets it when a session opens
(message listener, menu waiting, wait-reply) and clears it on session end. Delivered to
the SDK as `session_state` jobs on the existing channel, and mirrored in the SDK's
in-memory map. While active, every update for that chat is "ours".

SDK routing rule per update:

1. Chat flow-active → ours.
2. Manifest matches (command / keyword / deep link / callback prefix / catchAll) → ours.
3. Otherwise → `next()`; still observed for analytics (existing behaviour).

"Ours" = ship to `/events` with `handled: true`, do **not** call `next()`.

Middleware placement keeps precedence deterministic (unchanged from plugin plan):
plugin first → flows win; plugin last → customer handlers win; `mode: 'observe'` never
intercepts.

### 4.3 Runtime fast path

`SdkIngest.service` currently persists asynchronously. Matched updates need to reach
the running `Bot` instance promptly: the controller publishes them to the bot's inbound
channel **before** enqueuing the persistence job. Contact upsert stays where it is; the
runtime's own `SyncContact` gRPC path handles contact creation on first flow touch
exactly as for hosted bots.

### 4.4 Identity binding

Unchanged from the local plan §13: on startup the SDK reports `getMe` (`bot id`,
`username`) with a customer-generated `instanceId`; first bind sticks, later mismatch →
`409`, rebind only from FlowCastle settings. Heartbeats drive the dashboard states
connected / stale / mismatch.

### 4.5 Origin tagging for Flow Map

Outgoing calls executed from `flowcastle_runtime` jobs are reported back with
`correlationJobId` (already the case for Live Chat) and are **excluded** from
observed-flow mining in `SdkFlowProjection.service.ts` and counted against the authored
`flowId`/`blockId` in `MessageDelivery`/`ButtonClick`. Handwritten sends stay
`customer_code`.

## 5. Update lifecycle (matched update)

1. grammY middleware: manifest says ours → `POST /events` (`{type:'update', handled:true}`), no `next()`.
2. Controller: publish to `sdk:inbound:<botId>`; enqueue persistence job; return `202`.
3. `SdkProxyAdapter.start()` subscriber → `Bot.handleUpdate` → `FlowExecutor`.
4. Sends → `SdkOutboundJob` rows.
5. SDK long-poll `GET /jobs` → executes via `bot.api` → `POST /jobs/ack` with result (`message_id`, or Telegram error).
6. Runtime resolves awaited sends; `MessageDelivery` written with authored ids.

Unmatched update: step 1 calls `next()` and ships the observation only (today's path).

## 6. Job channel extensions

`SERVER_ALLOWED_METHODS` (`SdkOutbox.service.ts`) and the plugin's hard allowlist
(`packages/sdk-grammy/src/jobs.ts`) gain: `editMessageText`, `editMessageReplyMarkup`,
`editMessageCaption`, `deleteMessage`, `answerCallbackQuery`, `sendChatAction`,
`sendPhoto/Document/Video/Audio/Voice/MediaGroup`, `sendInvoice`, `restrictChatMember`,
`banChatMember`, `getChatMember`, `pinChatMessage`. Each addition is one typed payload
in `jobs.ts` — the allowlist stays hardcoded on both sides.

New job kind `session_state` (`{chatId, active: boolean}`) for the flow-active flag.

Ordering: jobs for one chat are leased in insertion order and acked before the next is
leased (per-chat FIFO), so a two-message block never arrives reversed. Cross-chat jobs
stay parallel.

## 7. Failure behaviour

- API down at startup: keep last cached manifest (persisted to disk, opt-out); if none,
  fail open → all updates to customer handlers. `ready()` never blocks the host bot.
- API down mid-conversation: the update is queued in the SDK (bounded, 1 000 updates /
  5 min), then dropped with a telemetry event. Customer handlers are **not** called for
  updates we already claimed.
- Telegram error on a job: acked with the error; runtime applies the existing
  permanent/transient classification.
- Lease expiry / SDK crash: job re-leased (existing).
- Duplicate `update_id`: server dedups by `(botId, update_id)` for 24 h.
- Multiple customer replicas: manifest is identical everywhere; updates are shipped
  once by whichever replica received them; jobs are leased by exactly one replica
  (existing lease semantics). Flow-active flags fan out to all replicas.

## 8. Deploy changes

- `BotDeploymentService.deploy()` / `LocalBotRunner`: for SDK bots, compile the AST and
  start the `Bot` with `SdkProxyAdapter` (no Telegram polling/webhook). Remove the early
  returns.
- After compile, build and store the manifest; bump its etag so long-polling SDKs pick
  it up immediately.
- `runtimeStatus` continues to be driven by ingest activity; add `manifestVersion` and
  `sdkInstanceCount` to the bot for the dashboard.

## 9. Phases

**Phase A — proxy runtime (private beta)**
- `SdkProxyAdapter`, factory wiring, inbound channel, controller fast path.
- Deploy pipeline changes; SDK bot gets a running `Bot` in the bots pod.
- Allowlist extensions for text/menu/edit/callback/chat-action.
- Manifest compiler + endpoint; SDK routing rule + flow-active map.
- Identity binding.
- Acceptance: visual `/start` flow answers through the customer's `bot.api`; unmatched
  `/help` reaches the customer handler; message-listener flow survives SDK restart;
  no double reply when both a flow and a handler own `/start`.

**Phase B — analytics and attribution**
- Origin tagging, Flow Map exclusion, `MessageDelivery`/`ButtonClick` attribution.
- Dashboard states (connected / stale / identity mismatch / manifest version).

**Phase C — full method surface**
- Media, invoices, group moderation methods, `getChatMember`.
- Per-chat FIFO enforcement and ack-await for message ids.
- Real-Telegram smoke test bot in CI.

**Later, only if measured:** move the wait-for-input / menu-callback hot path into the
SDK as an optimisation. Not planned.

## 10. Testing

- Unit: manifest compiler snapshots from AST fixtures; SDK routing rule table tests.
- Runtime: `SdkProxyAdapter` against the existing `FlowSimulator` scenarios — same
  scenarios as hosted bots, assertions on emitted jobs instead of Telegram calls.
- Middleware tests: handled updates never reach customer handlers; unmatched always do;
  flow-active overrides manifest.
- Channel: duplicate update, expired lease, out-of-order ack, error ack.
- E2E: dedicated SDK bot, `startBotPreview`-style flow run through a real grammY process.

## 11. Open decisions

1. Inbound transport for the fast path: Redis pub/sub (lowest latency, at-most-once) vs
   BullMQ (durable, slower). Proposal: pub/sub with the persistence job as fallback
   replay if the bot pod was not subscribed.
2. Whether the manifest is per-bot or per-application (multi-bot apps).
3. Ack-await timeout default and whether flows may opt out of awaiting message ids.
4. Manifest cache persistence location in the SDK (disk vs memory-only).
