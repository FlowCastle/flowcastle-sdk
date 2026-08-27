# FlowCastle Cross-Framework Telegram SDK Plan

**Status:** Cross-framework baseline implemented; live infrastructure E2E and release hardening remain (2026-08-27)

**Scope:** library adapters for server-authored FlowCastle flows:
`@flowcastle/grammy`, `@flowcastle/telegraf`, aiogram (Python), and
python-telegram-bot (Python).

**Related:** [grammY proxy runtime plan](SDK_GRAMMY_PROXY_FLOW_RUNTIME_PLAN.md),
`packages/sdk-runtime`.

## 1. Product position

FlowCastle adds contacts, analytics, Live Chat, broadcasts, and authored flows to
an existing Telegram bot without taking ownership of the bot token, polling,
webhook, or customer handlers. The customer chooses the Telegram library and
continues to own its Telegram transport. FlowCastle authors and executes flow
logic on its server with the existing `FlowExecutor`; an adapter only routes
updates and safely performs server-requested Telegram API calls through the
customer's already-configured client.

This deliberately does not introduce a local AST compiler or a second flow
interpreter in each SDK. One server runtime keeps parity for conditions,
templates, AI, delayed work, sequences, broadcasts, and action kinds; adapters
remain small, auditable transport integrations.

The product supports both ownership models in one Automation workspace:

- **Code-owned observed flows** are automatically reconstructed from sanitized
  SDK traffic and remain read-only because the customer's repository is their
  source of truth.
- **FlowCastle-authored flows** are built, edited, and deployed in the no-code
  editor. They can claim matching updates or be invoked explicitly by callable
  key from customer code.

They are complementary, not migration stages. A customer can keep specialized
logic in its framework handlers, give product and operations teams visual flows
for journeys they own, and run both through the same bot process. Unmatched
updates always continue to customer code.

## 2. Supported targets and delivery status

| Target | Distribution / runtime | Status | Initial responsibility |
| --- | --- | --- | --- |
| grammY | `@flowcastle/grammy`, Node.js >= 18 | Baseline implemented and tested | Reference Node adapter and conformance subject |
| Telegraf | `@flowcastle/telegraf`, Node.js >= 18 | Baseline implemented and tested | Telegraf middleware, observation, proxy routing, and Telegram dispatch |
| aiogram | `flowcastle[aiogram]`, Python >= 3.10 | Baseline implemented and tested against aiogram 3 | Async middleware plus aiogram Bot dispatch |
| python-telegram-bot | `flowcastle[python-telegram-bot]`, Python >= 3.10 | Baseline implemented and tested against PTB 21/22 | Early handler integration plus async Bot dispatch |

No target is presented as more popular or preferred. A customer selects the
adapter that matches its existing application; protocol support, not framework
choice, determines feature availability.

## 3. Architecture and ownership boundaries

```text
Telegram update
  -> customer process and framework dispatcher
  -> FlowCastle adapter: sanitize, normalize, claims/manifest match
       unmatched -> customer handler chain
       matched   -> POST /api/sdk/v1/events (handled: true)
  -> FlowCastle server: existing Bot + FlowExecutor + SdkProxyAdapter
  -> leased outbound job
  -> same customer process: framework's typed Telegram client
  -> Telegram API; result/error acked to FlowCastle
```

| Concern | Owner | Non-goal / boundary |
| --- | --- | --- |
| Bot token, webhook/polling lifecycle, framework setup, customer handlers | Customer application | Adapter must not call lifecycle methods or replace the dispatcher |
| Flow AST, sessions, waits, conditions, delivery attribution, retries | FlowCastle server | Adapters do not compile or interpret flows |
| Trigger matching, claim enforcement, update normalization, local privacy filter | Adapter using protocol contract | Original framework update remains available to customer handlers |
| Telegram execution for outbound jobs | Adapter via the customer's bot client | Only explicitly permitted, typed methods can be dispatched |
| SDK identity/availability | Adapter and server heartbeat | Identity binding prevents an unexpected bot from serving a configured SDK bot |

Middleware/handler installation keeps the framework's native precedence: when the
adapter is registered before customer handlers, a matched flow consumes the
update; when registered after them, existing handlers can win. `observe` mode
never consumes. A server-authored active conversation claim always routes the
claimed conversation to FlowCastle before a new manifest trigger is considered.

## 4. Framework-neutral protocol contract

`packages/sdk-runtime` is the TypeScript reference contract. Python adapters
must reproduce its JSON wire format and semantics rather than importing Node
code. The server endpoints and JSON shapes are framework-neutral:

| Contract | Purpose | Required semantics |
| --- | --- | --- |
| `GET /manifest` | Fetch versioned trigger rules | ETag-aware cache; deterministic priority matching; no manifest means no new trigger claim |
| `GET /claims` | Fetch active conversation ownership | Generation-safe upsert/clear, expiry, chat and chat-actor scopes; a valid claim wins routing |
| `POST /events` | Send observed or handled sanitized updates | Matched flow event uses `handled: true`; `update_id` is stable when Telegram supplies it |
| `GET /jobs` and `POST /jobs/ack` | Lease, execute, and report outbound work | Lease token is returned in ack; execute per-chat FIFO; error acks retain Telegram code/description where available |
| `POST /runtime/heartbeat` | Bind/report runtime identity | Reports instance id, library/version, bot identity, capabilities, and protocol version |
| `POST /runtime-runs` | Explicit customer-code flow start | Only deployed `sdkCallable` flows with stable callable keys may run |

All adapters normalize framework updates into the runtime update fields
(`updateId`, chat/actor ids and type, command/payload, callback data, addressed
state, event type, and sanitized raw JSON). The canonical matcher evaluates
command, deep-link, message, callback, and event rules in descending priority.
Adapters must apply the same command-addressing and claim-scoping interpretation
as the reference fixtures; no framework-specific matching shortcuts.

### Job semantics

Jobs are the only server-to-bot execution channel. Each adapter must:

1. Lease only jobs compatible with its declared capabilities.
2. Dispatch through explicit framework-native calls, never dynamic invocation
   from a server-provided method name.
3. Preserve order for a chat, while allowing independent chats to progress in
   parallel where the framework permits it.
4. Ack success with a JSON-safe result (including a message id when returned),
   or ack a classified Telegram failure. Expired/crashed leases are eligible for
   server re-lease.
5. Tag calls made for a job with its correlation job id so observed outbound
   traffic cannot be re-ingested as customer-code output.

The runtime requires a result only for methods whose following flow action needs
one. Awaiting such a result is bounded; timeout is treated as the existing
transient delivery failure path. Duplicate inbound Telegram updates are
idempotent server-side by `(botId, update_id)`.

## 5. Privacy and data boundary

Each adapter sanitizes before manifest matching, background buffering, event
ingest, or `runFlow`. The sanitized representation is used consistently; the
native framework update is never mutated.

The shared privacy contract has the same public meanings in every adapter:

| Setting | Cross-language requirement |
| --- | --- |
| Contact fields | Allowlist only: `username`, `firstName`, `lastName`, `languageCode`, `isPremium`, `addedToAttachmentMenu`; operational ids remain available |
| `full` message content | Send supported text and structured content, applying the optional transform to enumerated text fields |
| `routing` message content | Retain operational data, command names, and callback identifiers; remove free text, command payloads, captions, and structured content |
| `none` message content | Retain operational shape/ids only; remove commands and callback values too |
| Async transform | Same field context, null/drop result, default 1000 ms timeout, and fail-closed behavior: errors, invalid values, and timeouts drop the field, never leak the original |

Application-authored values passed to goals, identify, live-agent notes, or
explicit flow inputs are outside automatic Telegram sanitization. Adapter README
files must document that distinction. Observation transports use a bounded
500-event in-memory queue, batch network delivery outside unmatched customer
handlers, drop oldest when full, and report delivery failures without throwing
into customer handler execution.

Matched updates are the deliberate exception: once a manifest or active claim
assigns ownership to FlowCastle, the adapter awaits ingest before consuming the
update. A failed hand-off is retained in a separate bounded runtime outage spool
for replay and never falls through to customer handlers. Explicit `runFlow`
calls also await server acceptance. Async privacy transformers remain on the
local hot path because raw content must not race past redaction.

## 6. Package and repository layout

```text
packages/
  sdk-runtime/                 # protocol types/parser, matcher/claims, privacy,
                               # capability negotiation, client, leased-job loop
  sdk-grammy/                  # existing grammY flavor, normalizer and dispatcher
  sdk-telegraf/                # Telegraf adapter; depends on sdk-runtime
  sdk-python/                  # Python protocol core and optional thin aiogram /
                               # python-telegram-bot adapters
  sdk-conformance/             # language-neutral JSON fixtures and expectations
api/src/test/controllers/      # real HTTP controller contract tests
```

The Python distribution is one dependency-light package with a framework-neutral
core and two optional extras. This avoids duplicating protocol and privacy logic
while keeping both Telegram libraries optional at import time. Adapters depend
outward on their Telegram library and inward on the Python core; they do not
depend on one another.

`sdk-runtime` remains the source of truth for the wire contract and TypeScript
behavior. Its exported JSON fixtures become the cross-language compatibility
artifact, not a requirement that Python use TypeScript implementation details.

## 7. Method parity matrix

The following is a compatibility commitment, not a claim that every target is
implemented today. A method becomes available for a target only when it is in
that adapter's hardcoded dispatcher, declared capability set, conformance tests,
and end-to-end tests.

| Method family | grammY | Telegraf | aiogram | python-telegram-bot | Notes |
| --- | --- | --- | --- | --- | --- |
| `sendMessage`, `sendChatAction`, `answerCallbackQuery` | In progress | Planned | Planned | Planned | Baseline text/callback flow transport |
| Media: photo, document, video, audio, voice, media group | In progress | Planned | Planned | Planned | JSON file marker decoded locally; no arbitrary file access |
| Message edits/deletes and reply markup | In progress | Planned | Planned | Planned | Includes result/error acknowledgement semantics |
| Payments/invoices and checkout answers | In progress | Planned | Planned | Planned | Capability gated; callback/payment data obeys privacy mode |
| Moderation and pins | In progress | Planned | Planned | Planned | `restrictChatMember`, ban, pin; explicit safe payload validation |
| Read helpers: `getChatMember`, `getMe` | In progress | Planned | Planned | Planned | `getMe` supports identity checks; no lifecycle control |
| Token/webhook/polling lifecycle | Denied | Denied | Denied | Denied | Includes `setWebhook`, `deleteWebhook`, `getUpdates`, `close`, `logOut` |

Framework API naming differences are adapter details. The server capability name
and job method remain stable across languages; no adapter may silently emulate a
method with materially different Telegram behavior.

## 8. Shared conformance and E2E strategy

### Conformance suite

`tests/sdk-conformance` supplies JSON input/output fixtures consumed by both the
Jest suite and Python test runner. It covers:

- manifest parsing, invalid input rejection, ETag/cache behavior, priority,
  command/deep-link/callback/text matching, group addressing, and `catchAll`;
- claim snapshots/deltas, expiration, generation ordering, chat versus
  chat-actor keys, and active-claim precedence;
- update normalization from raw Telegram update fixtures;
- privacy defaults, every content mode, text-transform timeout/rejection,
  entity removal after changed text, and no mutation of the original update;
- protocol validation, capability negotiation, job lease/ack body encoding,
  disallowed methods, result values, file markers, FIFO, duplicate update, and
  retry/lease-expiry behavior.

Every fixture identifies its protocol version and is additive until a versioned
breaking change. A target cannot advertise a capability unless its relevant
fixtures pass.

### E2E layers

1. **Hermetic adapter E2E:** run each framework's real dispatcher against a
   FlowCastle SDK test server and a fake Telegram API. Verify handler
   precedence, consumed versus unconsumed updates, outbound execution and acks
   without live network dependencies.
2. **Server/runtime E2E:** deploy an SDK bot to the real `SdkProxyAdapter` /
   `FlowExecutor` path. Exercise `/start`, keyword, callback menu, a waiting
   reply, a delayed action, an explicit `runFlow`, media, edit, and an error ack.
3. **Real-Telegram smoke:** opt-in credentialed CI job per completed adapter.
   It uses a dedicated bot and isolated chat, never production customer tokens,
   and verifies inbound update -> server flow -> framework client send.

All E2E runs assert no duplicate reply, attribution contains the authored
`flowId`/`blockId`, and server-originated sends are excluded from observed-flow
mining. Unit and E2E tests use deterministic clocks where leases, claims, or
privacy timeouts are involved.

Current automated evidence covers real grammY and Telegraf dispatchers, real
aiogram update models, and a real python-telegram-bot `Application` dispatcher
without Telegram credentials. It also drives the real Express SDK ingest and
runtime controllers with only database/Redis leaf services replaced. A single
process chain through live Postgres, Redis, `FlowExecutor`, and Telegram remains
the next E2E milestone; the credentialed smoke remains opt-in and is not implied
by `pnpm sdk:e2e`.

## 9. Rollout phases

| Phase | Status | Deliverables and exit evidence |
| --- | --- | --- |
| 0. Contract baseline | Done / maintained | `sdk-runtime` protocol primitives, privacy contract, capabilities, claims, client/spool, and versioned shared fixtures |
| 1. grammY proxy runtime | Implemented; release hardening remains | Server proxy runtime, manifest/claims endpoints, identity binding, typed jobs, attribution, conformance, and hermetic dispatcher tests |
| 2. Telegraf adapter | Implemented baseline | Thin Node adapter, shared protocol semantics, capability-gated dispatcher, privacy, and hermetic dispatcher tests |
| 3. Python runtime + aiogram | Implemented baseline | Python protocol mirror, continuous sync/jobs/heartbeat, privacy, bounded background event transport, aiogram adapter, shared fixtures, and framework tests |
| 4. python-telegram-bot | Implemented baseline | Early handler integration, shared Python runtime, file decoding, shared fixtures, and real `Application` dispatcher tests |
| 5. Broad method surface and real-Telegram CI | Planned | Finish gated method families across targets and add credentialed smoke jobs |
| 6. General availability | Planned | Version/support policy, operational dashboards, upgrade guidance, and acceptance criteria satisfied for each supported target |

Each phase may ship a target with a deliberately smaller advertised capability
set. A missing method is refused and acknowledged as unsupported; it is never
passed through dynamically.

## 10. Acceptance criteria

For each adapter release:

- A matched server-authored flow runs through the server `FlowExecutor` and its
  response is sent by the customer's framework-owned Telegram client.
- An unmatched update reaches customer code exactly according to documented
  middleware placement; an adapter failure cannot throw into that chain.
- Observation networking for unmatched updates and telemetry helpers runs in a
  bounded background transport; a slow `/events` endpoint cannot delay customer
  code. Local privacy work and matched-flow ownership remain explicit exceptions.
- A current claim consumes a reply even if the manifest no longer matches; an
  expired or superseded claim does not.
- Privacy filtering occurs before every adapter-owned persistence/network path,
  preserves original framework objects, and passes common privacy fixtures.
- Identity mismatch is rejected by the server and observable; heartbeat reports
  library/version/capabilities and bot identity.
- Only hardcoded method/capability intersections are leased and dispatched;
  lifecycle methods remain denied.
- Per-chat ordering, lease retry, duplicate inbound idempotency, job correlation,
  message-id result acks, and Telegram error acks pass conformance/E2E tests.
- Authored-flow delivery is attributed to its flow/block and is not treated as
  customer-code analytics or a new observed-flow edge.

## 11. Security, privacy, and operations

SDK keys authenticate every protocol request and must be stored in the host
application's normal secret mechanism. Adapters log only redacted, operational
diagnostics and route internal errors to an opt-in error hook; they do not expose
raw update bodies or keys in errors. The endpoint must enforce tenant/bot
authorization for manifest, claims, ingest, jobs, acknowledgements, heartbeat,
and explicit runs.

The client allowlist is a security boundary independent of server authorization.
Payload decoding accepts only declared JSON values and documented file markers,
with size/type limits established per adapter; it never evaluates code, invokes
an arbitrary client attribute, or opens a server-supplied filesystem path.

Cache and outage behavior is fail-safe for ownership: without a manifest the
adapter does not newly claim updates; once it has claimed an update it does not
fall through to customer handlers during a transient server outage. The bounded
observation queue, lease expiry, duplicate-event key, and health telemetry make
this behavior observable without risking duplicate customer replies.

## 12. Versioning and compatibility

`protocolVersion` versions the JSON behavior independently from adapter package
versions. Adapters send their library version and capability set in heartbeat;
the server leases only compatible work. New optional fields and capabilities are
additive. A breaking field or semantic change requires a new protocol version,
dual-read/dual-write server rollout where necessary, versioned fixtures, and an
adapter release that declares support before it receives that version's jobs.

Adapter packages follow semantic versioning. Removing a supported capability,
changing default privacy behavior, or changing routing precedence is a breaking
adapter change and requires migration notes. A platform support table records
supported Node/Python and Telegram-library ranges per adapter release; unsupported
framework versions must fail installation or initialization clearly rather than
silently degrading routing.

## 13. Future adapter recipe

An additional Telegram library qualifies as an adapter only after it follows
this recipe:

1. Select the supported language runtime or implement the protocol/fixture
   contract faithfully in a new language runtime package.
2. Write a pure native-update -> `RuntimeUpdate` normalizer and retain the
   original update for customer code.
3. Install middleware/handlers with documented order and modes; sanitize first,
   apply claims then manifest, ingest matched updates, and preserve unmatched
   handler behavior.
4. Implement heartbeat, manifest/claim refresh, bounded background observation
   delivery, explicit `runFlow`, and capability negotiation.
5. Implement a typed, hardcoded Telegram dispatcher for the initial approved
   method set, job correlation, file-marker decoding, FIFO, and ack mapping.
6. Pass every language-neutral conformance fixture, add framework-native unit
   tests, hermetic E2E, and the opt-in real-Telegram smoke test before advertising
   the adapter or any capability.

The review checklist rejects local flow interpretation, dynamic server-method
dispatch, mutation of native updates, unbounded raw-data buffering, unversioned
protocol behavior, and undocumented precedence changes.
