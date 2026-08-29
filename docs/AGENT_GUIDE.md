# FlowCastle SDK — setup guide for AI coding agents

This is a single-file, self-contained reference for installing the FlowCastle SDK into an
existing Telegram bot. It is written for AI coding agents (Claude Code, Cursor, Codex,
Copilot) and for humans who want the whole contract on one page. Everything here is
verified against the SDK source in this repository.

**What the SDK does:** middleware that observes a Telegram bot's updates and outgoing Bot
API calls and ships sanitized events to FlowCastle, which provides a contact CRM, Live
Chat with human handoff, broadcasts, goals/funnel analytics, and (optionally) runs
no-code flows built in the FlowCastle editor through the bot's own process.

**What it never does:** it never receives the Telegram bot token, never starts polling
or webhooks, never mutates the framework's update objects, and never blocks ordinary
handlers on the network.

---

## 0. Decision table — which package

| Bot framework | Language | Install | Import |
| --- | --- | --- | --- |
| grammY ≥ 1.20 | Node.js ≥ 18 | `npm i @flowcastle/grammy @flowcastle/sdk-runtime` | `import { flowcastle } from '@flowcastle/grammy'` |
| Telegraf ≥ 4.16 | Node.js ≥ 18 | `npm i @flowcastle/telegraf @flowcastle/sdk-runtime` | `import { flowcastle } from '@flowcastle/telegraf'` |
| aiogram 3.x | Python ≥ 3.10 | `pip install 'flowcastle[aiogram]'` | `from flowcastle.adapters.aiogram import AiogramAdapter` |
| python-telegram-bot 21–22 | Python ≥ 3.10 | `pip install 'flowcastle[python-telegram-bot]'` | `from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter` |

`@flowcastle/sdk-runtime` is a peer dependency of both Node packages; npm ≥ 7 installs it
automatically, but list it explicitly to be safe. Node packages have zero runtime
dependencies. The Python core uses only the standard library; the framework is an extra.

If the bot uses another framework or language, stop and tell the user: there is no
adapter yet. Do not try to build one ad hoc — see `CROSS_FRAMEWORK_TELEGRAM_SDK_PLAN.md`
in this folder for the adapter recipe.

## 1. Credentials

The SDK needs exactly one secret: a FlowCastle SDK key, format `fc_sdk_` + 48 hex chars.

How the user obtains it: sign in at https://dashboard.flowcastle.ai (free plan, no card)
→ open (or create) an application → **Add bot** → choose platform **Code SDK** → copy the
key. Creating the SDK bot does NOT ask for a Telegram token.

Store it as `FLOWCASTLE_API_KEY` next to the existing `BOT_TOKEN`. Never hard-code it.
Never send `BOT_TOKEN` to FlowCastle; the SDK has no option for it.

Ingest base URL defaults to `https://my.flowcastle.ai`. Only override (`apiUrl` /
`api_url`) for a self-hosted FlowCastle.

## 2. Minimal integration (copy exactly, then adapt)

Ordering rule for every framework: **install FlowCastle before registering handlers** so
it observes every update, and call `ready()` before polling/webhook start when
`runtime` is enabled.

### grammY

```ts
import { Bot, Context } from 'grammy';
import { flowcastle, FlowCastleFlavor } from '@flowcastle/grammy';

type BotContext = FlowCastleFlavor<Context>;           // adds ctx.flowcastle
const bot = new Bot<BotContext>(process.env.BOT_TOKEN!);

const fc = flowcastle<BotContext>({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {},                                          // see §4
  runtime: { enabled: true },                           // only if no-code flows should run through this bot
  onError: (e) => console.error('[flowcastle]', e),
});
bot.use(fc);                                            // BEFORE other handlers

// ...existing handlers unchanged...

await fc.ready();
bot.start();
// on shutdown: await bot.stop(); await fc.flush(); fc.destroy();
```

If the bot already composes `Context` with other flavors (e.g. `SessionFlavor`), wrap:
`type BotContext = FlowCastleFlavor<Context & SessionFlavor<S>>`.

### Telegraf

```ts
import { Context, Telegraf } from 'telegraf';
import { flowcastle, FlowCastleFlavor } from '@flowcastle/telegraf';

type BotContext = FlowCastleFlavor<Context>;
const bot = new Telegraf<BotContext>(process.env.BOT_TOKEN!);

const fc = flowcastle<BotContext>({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {},
  runtime: { enabled: true },
  onError: (e) => console.error('[flowcastle]', e),
});
fc.wrapTelegram(bot.telegram);                          // observe bot.telegram.* calls made outside middleware
bot.use(fc);                                            // BEFORE other handlers

// ...existing handlers unchanged...

await fc.ready();
bot.launch();
// on shutdown: bot.stop(); await fc.flush(); fc.destroy();
```

### aiogram 3

```python
from aiogram import Bot, Dispatcher
from flowcastle import FlowCastleContext, FlowCastleCore, FlowCastleOptions
from flowcastle.adapters.aiogram import AiogramAdapter

core = FlowCastleCore(FlowCastleOptions(
    api_key=os.environ['FLOWCASTLE_API_KEY'],
    privacy={},
    runtime_enabled=True,
))
adapter = AiogramAdapter(core)
dp = Dispatcher()

# handlers receive the context by argument name `flowcastle`:
@dp.message(CommandStart())
async def start(message: Message, flowcastle: FlowCastleContext) -> None:
    await flowcastle.identify({'displayName': message.from_user.full_name})

async def main() -> None:
    bot = Bot(os.environ['BOT_TOKEN'])
    await adapter.ready()
    adapter.install(dp)                                 # registers an outer middleware on dp.update
    dp.shutdown.register(adapter.stop)                  # final flush
    await dp.start_polling(bot)
```

### python-telegram-bot 21/22

```python
from telegram.ext import Application
from flowcastle import FlowCastleContext, FlowCastleCore, FlowCastleOptions
from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter

core = FlowCastleCore(FlowCastleOptions(
    api_key=os.environ['FLOWCASTLE_API_KEY'],
    privacy={},
    runtime_enabled=True,
))
adapter = PythonTelegramBotAdapter(core)

async def post_init(app: Application) -> None:  await adapter.ready()
async def post_shutdown(app: Application) -> None: await adapter.stop()

application = Application.builder().token(os.environ['BOT_TOKEN']) \
    .post_init(post_init).post_shutdown(post_shutdown).build()
adapter.install(application)                            # handler group -100, BEFORE add_handler calls

# handlers read the context from `context.flowcastle`:
async def start(update, context):
    fc: FlowCastleContext = context.flowcastle
    await fc.identify({'displayName': update.effective_user.full_name})

application.run_polling()
```

Webhooks: identical. The SDK is middleware; it does not care how updates arrive.

## 3. Using it from handlers

| Purpose | Node (`ctx.flowcastle.`) | Python (`flowcastle.` / `context.flowcastle.`) | Blocking? |
| --- | --- | --- | --- |
| Record a conversion / funnel step | `goal(key, props?)` | `await goal(key, props=None)` | no (queued) |
| Set contact traits shown in the CRM | `identify(props)` | `await identify(props)` | no (queued) |
| Hand the chat to a human in Live Chat | `requestLiveAgent({ note? })` | `await request_live_agent(note=None)` | no (queued) |
| Is a human currently handling this chat? | `isLiveAgentActive` (boolean, optimistic 30-min window) | **not available** | — |
| Start a flow built in the FlowCastle editor | `await runFlow(flowKey, { inputs? })` → `{ executionId }` | `await run_flow(flow_key, inputs=None)` → dict | **yes** (returns execution id) |

Rules:
- `goal`/`identify`/`requestLiveAgent` need a sender (`ctx.from`); otherwise they are skipped and reported to `onError`.
- `runFlow`/`run_flow` throws unless `runtime.enabled` / `runtime_enabled=True`, and the target flow must be **deployed** and marked **callable from SDK** with that key in the dashboard. Wrap it in try/catch; never let it crash the handler.
- Goal keys are free-form snake_case strings (`lead_qualified`, `subscription_started`). Props are a flat JSON object; a numeric `value` is conventional for revenue.
- `identify` props are developer-authored and NOT passed through the privacy filter — do not put raw message text in them.
- Typical guard in an echo/fallback handler (Node only): `if (ctx.flowcastle.isLiveAgentActive) return;`

## 4. Privacy — choose deliberately, then tell the user what you chose

Filtering happens inside the bot process before anything is buffered or sent.

| Option | Node key | Python key | Values | Default when `privacy: {}` / `privacy={}` |
| --- | --- | --- | --- | --- |
| Profile fields shared | `privacy.contactFields` | `contact_fields` | Node: `username firstName lastName languageCode isPremium addedToAttachmentMenu`; Python: `username first_name last_name language_code is_premium added_to_attachment_menu` | none (Telegram user id only) |
| Message content | `privacy.messageContent` | `message_content` | `'routing'` (commands + callback ids, no free text), `'full'`, `'none'` | `'routing'` |
| Local redaction | `privacy.messageContent.transformText` | `transform_text` | sync or async `(ctx) => string \| null`; `null` drops the field; throw/timeout drops the field (fail-closed) | — |
| Redaction timeout | `…transformTimeoutMs` | `transform_timeout_ms` | ms | 1000 |

Decision rule:
- Bot only needs CRM/analytics/broadcasts → `privacy: {}` (routing). Optionally add `contactFields: ['username', 'languageCode']` so contacts are recognizable in the CRM.
- FlowCastle flows must read what users type (AI answers, keyword triggers, wait-for-reply) → `messageContent: 'full'`, and add a `transformText` that strips emails/phones/cards if the domain warrants it.
- **Omitting `privacy` entirely keeps legacy full-content behaviour.** Always pass it explicitly in new integrations.

## 5. Full option reference

Node (`flowcastle(options)`), both adapters:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | string | required | `fc_sdk_…` |
| `apiUrl` | string | `https://my.flowcastle.ai` | self-hosted only |
| `privacy` | object | legacy full | see §4 |
| `flushIntervalMs` | number | 3000 | |
| `maxBatchSize` | number | 20 | clamped to 1–50 |
| `onError` | `(e) => void` | silent | always set it during integration |
| `pullJobs` | boolean | true | pull Live Chat agent replies / flow sends and deliver them through this bot; only an allowlist of Bot API methods can run; `getUpdates/setWebhook/deleteWebhook/close/logOut` are always refused |
| `liveAgentWindowMs` | number | 1800000 | window for `isLiveAgentActive` |
| `runtime.enabled` | boolean | false | let FlowCastle-authored flows claim matching updates and run through this bot |
| `runtime.capabilities` | string[] | built-ins | extra capability tags advertised to the server |
| `runtime.instanceId` | string | random UUID | stable id for this process if you run replicas |

Python (`FlowCastleOptions`): `api_key`, `api_url`, `privacy` (`PrivacyOptions` or dict),
`runtime_enabled` (False), `instance_id`, `on_error`, `flush_interval_ms` (3000),
`max_batch_size` (20), `shutdown_flush_timeout_ms` (2000).

Adapter lifecycle (Python): `await adapter.ready()`, `adapter.install(dispatcher | application)`,
`await adapter.flush()`, `await adapter.stop()`. Node: `fc.ready()`, `fc.flush()`, `fc.destroy()`,
Telegraf-only `fc.wrapTelegram(telegram)`.

## 6. Runtime semantics you must not get wrong

- **Unmatched updates never wait on the network.** Observation is queued (cap 500, drop-oldest, one retry on network/5xx). Do not add your own `await fc.flush()` in handlers.
- **Matched updates are consumed.** When `runtime` is enabled and an update matches a deployed FlowCastle trigger (or an active conversation claim), FlowCastle owns the reply and the bot's own handlers do **not** run for that update. This is by design; tell the user which commands/keywords are claimed by their FlowCastle flows so they don't expect their code handler to fire too. Everything unmatched falls through unchanged.
- `ready()` loads the trigger manifest. Call it before polling starts, otherwise the first matching update may reach a code handler.
- A 401 from ingest stops delivery and is reported to `onError` — it means a wrong or revoked key.
- Nothing in the SDK opens server-provided file paths; media in flow jobs arrives inline (`$flowcastleFile`, ≤ 20 MiB) and is converted to the framework's upload type.

## 7. Verification checklist (do this, do not assume)

1. Type-check / import: `tsc --noEmit` or `python -c "import bot"` succeeds.
2. Set `onError` to log. Start the bot. No `[flowcastle]` errors within 10 s means the key was accepted (a bad key logs a 401 on first flush, ≈3 s after the first update).
3. Send `/start` to the bot in Telegram. Within ~5 s the user appears under **Contacts** in the FlowCastle dashboard, and the SDK bot's status shows connected.
4. If you added a `goal(...)`, trigger it and confirm it under **Analytics → Goals**.
5. If you enabled `runtime`, deploy a flow in FlowCastle with a `/command` trigger the bot's code does **not** handle, send that command, and confirm FlowCastle replies while code commands still work.
6. Stop the process with SIGINT and confirm it exits cleanly (flush is bounded; it must not hang).

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `onError`: ingest rejected api_key (401) | wrong/revoked key, or a Telegram token was passed by mistake | regenerate under Add bot → Code SDK |
| Contact never appears | `bot.use(fc)` registered after a handler that returned without `next()`; or events dropped because process exited before flush | move `bot.use(fc)` first; flush on shutdown |
| `runFlow() requires runtime.enabled` | runtime not enabled | set `runtime: { enabled: true }` / `runtime_enabled=True` |
| `runFlow` rejected | flow not deployed, or not marked callable from SDK, or key mismatch | fix in dashboard; keys are exact strings |
| Code handler stopped firing for a command | a deployed FlowCastle flow claims that trigger | intended; remove the trigger in FlowCastle or the handler in code |
| Free text missing in FlowCastle | routing-only privacy mode | `messageContent: 'full'` |
| `isLiveAgentActive` missing in Python | not implemented in the Python SDK | do not emulate it; skip the guard |
| TS error: `ctx.flowcastle` does not exist | context not typed with `FlowCastleFlavor` | `Bot<FlowCastleFlavor<Context>>` |

## 9. Do-not list

- Do not pass the Telegram bot token to FlowCastle in any form.
- Do not wrap `bot.use(fc)` in try/catch or register it conditionally — it never throws into the chain.
- Do not call `flush()` per update.
- Do not invent options; the tables above are complete for the current version.
- Do not claim `isLiveAgentActive` exists in Python.
- Do not leave `privacy` unset in a new integration.

## 10. Complete runnable examples

`examples/grammy-bot`, `examples/telegraf-bot`, `examples/aiogram-bot`,
`examples/python-telegram-bot-bot` in this repository — same product in each framework
(identify, goal button, code-owned `/qualify`, `/human` handoff, optional follow-up flow).
Prefer adapting the matching example over writing from scratch.
