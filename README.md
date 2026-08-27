# FlowCastle SDKs

<p align="center">
  <strong>Keep building your Telegram bot in code. Add the growth and operating system around it.</strong>
</p>

<p align="center">
  <a href="https://github.com/FlowCastle/flowcastle-sdk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FlowCastle/flowcastle-sdk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2563eb"></a>
  <a href="https://flowcastle.ai"><img alt="FlowCastle" src="https://img.shields.io/badge/FlowCastle-website-0f172a"></a>
</p>

Writing bot code is fun. But code alone does not bring users, help a growth team
understand them, give support a shared inbox, or show which conversations
convert.

[FlowCastle](https://flowcastle.ai) is the layer around your bot that turns a
working program into a product people can distribute, operate, and improve. It
adds a contact CRM, Live Chat, broadcasts and marketing campaigns, goals,
conversion analytics, reusable modules, and a visual map of the conversations
already happening in your code.

You do **not** have to rewrite your bot. Keep the framework, handlers, deployment,
database, and Telegram token you already own. Connect the SDK and use code and
FlowCastle together, choosing the best tool for each part of the product.

> **Release status:** the SDK packages are currently in release-hardening and
> are not yet published to npm or PyPI. The examples below show the stable target
> API and can be run from a source checkout today.

## Who this is for

- **Bot developers** who want to keep their architecture and ship the commercial
  layer without rebuilding CRM, campaigns, analytics, and support tooling.
- **Product teams** that need developers, marketers, operators, and support
  agents to work on the same customer journey without every change becoming a
  deploy.
- **Agencies and platform teams** maintaining multiple bots across different
  frameworks or languages while keeping one operating model.
- **Existing bots** whose conversation logic has become hard to see, measure,
  explain, or safely change.

## Code is the engine. FlowCastle is the cockpit.

Your application remains authoritative for bot transport and custom behavior.
FlowCastle adds the parts that become expensive and repetitive once a bot has
real users:

| Build in your code | Add with FlowCastle |
| --- | --- |
| Custom business logic and integrations | Contact CRM and audience context |
| Framework-native handlers | Live Chat and human handoff |
| Your deployment and data stores | Broadcasts, campaigns, and automated sequences |
| Specialized algorithms and domain behavior | Goals, funnels, and conversion analytics |
| Anything that deserves source control | Visual flows, ready modules, and collaborative editing |

This is not a choice between code and a visual builder. A command can stay in
code, call a FlowCastle flow for onboarding, return to custom logic, record a
goal, and later hand the conversation to a human—all through the bot process
you already operate.

![A lead qualification conversation displayed on the FlowCastle visual canvas](docs/images/flow-canvas.png)

The SDK observes incoming updates and outgoing Telegram calls. FlowCastle can
use that activity to reconstruct an **observed, read-only conversation map** on
the visual canvas. The result gives the whole team a shared view of what the bot
does, makes legacy flows easier to maintain, and connects each path to real
analytics. Delete the observed map at any time and let FlowCastle rebuild it
from fresh activity.

## Integrate in minutes

Every adapter uses the same protocol and privacy model. Framework-specific code
stays deliberately thin.

### grammY

```ts
import { Bot } from 'grammy';
import { flowcastle } from '@flowcastle/grammy';

const bot = new Bot(process.env.BOT_TOKEN!);
const fc = flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {}, // routing-only content; no optional contact fields
  runtime: { enabled: true },
});

await fc.ready();
bot.use(fc);

bot.command('hello', (ctx) => ctx.reply('Still handled by my code'));
bot.start();
```

Start a FlowCastle-authored flow or record a business outcome directly from an
existing handler:

```ts
bot.command('onboard', (ctx) =>
  ctx.flowcastle.runFlow('welcome-flow', {
    inputs: { source: 'telegram-command' },
  }),
);

bot.command('paid', async (ctx) => {
  ctx.flowcastle.goal('subscription_started', { plan: 'pro', value: 49 });
  await ctx.reply('Welcome to Pro');
});
```

Only flows explicitly marked `sdkCallable` can be started from application
code. Updates that match a deployed FlowCastle trigger are handled by the flow;
unmatched updates continue to your normal handlers.

<details>
<summary><strong>Telegraf</strong></summary>

```ts
import { Telegraf } from 'telegraf';
import { flowcastle } from '@flowcastle/telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN!);
const fc = flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {},
  runtime: { enabled: true },
});

await fc.ready();
fc.wrapTelegram(bot.telegram);
bot.use(fc);

bot.command('support', async (ctx) => {
  ctx.flowcastle.requestLiveAgent({ note: 'Asked for a human' });
  await ctx.reply('A teammate will join here.');
});

bot.launch();
```

</details>

<details>
<summary><strong>Python · aiogram 3</strong></summary>

```python
import os
from aiogram import Bot, Dispatcher
from flowcastle import FlowCastleCore, FlowCastleOptions
from flowcastle.adapters.aiogram import AiogramAdapter

bot = Bot(os.environ['BOT_TOKEN'])
dispatcher = Dispatcher()
core = FlowCastleCore(FlowCastleOptions(
    api_key=os.environ['FLOWCASTLE_API_KEY'],
    privacy={},
    runtime_enabled=True,
))
adapter = AiogramAdapter(core)

await adapter.ready()
adapter.install(dispatcher)
await dispatcher.start_polling(bot)
```

</details>

<details>
<summary><strong>Python · python-telegram-bot 21/22</strong></summary>

```python
import os
from flowcastle import FlowCastleCore, FlowCastleOptions
from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter
from telegram.ext import Application

application = Application.builder().token(os.environ['BOT_TOKEN']).build()
core = FlowCastleCore(FlowCastleOptions(
    api_key=os.environ['FLOWCASTLE_API_KEY'],
    privacy={},
    runtime_enabled=True,
))
adapter = PythonTelegramBotAdapter(core)
adapter.install(application)

application.run_polling()
```

</details>

The framework-neutral protocol is the important part: adapters translate native
updates and Telegram calls, while matching, privacy, flow execution, leased
jobs, and acknowledgements remain consistent. That makes support for another
Telegram library—or another language—a small adapter project instead of a new
platform integration.

## Performance contract

FlowCastle network delivery stays outside the execution path of ordinary
commands, callbacks, and unmatched updates in **Node.js and Python**. After
local privacy filtering and trigger matching, the adapter places observation
events in a bounded in-memory queue and immediately continues to your existing
handler. Goals, identification, and Live Chat requests use the same
fire-and-forget transport.

Observation events flush every three seconds or at 20 queued events, with no
more than 50 events in one request. The queue holds at most 500 events and drops
the oldest under sustained pressure instead of growing without limit. Network
and 5xx failures receive one background retry and never throw into customer
handlers.

This is deliberately described as **network fire-and-forget**, not zero
overhead. Cloning, privacy filtering, and local manifest matching still use a
small amount of CPU. An async `transformText` callback is awaited because raw
content must never race past redaction. Two server operations are also
intentionally awaited:

- An update matched by a FlowCastle trigger or active conversation claim,
  because FlowCastle owns the response and customer handlers must not also run.
  Failed hand-offs enter a separate bounded runtime outage spool for replay
  instead of falling through and risking a duplicate reply.
- An explicit `runFlow` / `run_flow` call, because it returns the accepted flow
  execution id.

Both boundaries are covered by regression tests with a deliberately blocked
`/events` endpoint: unmatched customer handlers finish first, while matched
flow updates remain pending until ownership is accepted.

## What your team gets

<table>
  <tr>
    <td width="50%">
      <img alt="FlowCastle modules marketplace" src="docs/images/modules-marketplace.png"><br>
      <sub><strong>Build faster.</strong> Add ready modules and integrations instead of rebuilding commodity features. The <a href="https://github.com/FlowCastle/telegram-bot-templates">FlowCastle MCP and bot templates</a> also let AI coding agents help draft and maintain bots and flows.</sub>
    </td>
    <td width="50%">
      <img alt="FlowCastle analytics dashboard" src="docs/images/analytics-dashboard.png"><br>
      <sub><strong>Know what works.</strong> Connect conversations, subscriber growth, orders, revenue, and campaign activity in one analytics view.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img alt="FlowCastle broadcast effectiveness report" src="docs/images/broadcast-effectiveness.png"><br>
      <sub><strong>Improve distribution.</strong> Send targeted broadcasts and see their real effect on engagement, goals, and unsubscribes.</sub>
    </td>
    <td width="50%" align="center">
      <img alt="A FlowCastle contact record with variables, tags, orders, sequences, and goals" src="docs/images/contact-details.png" width="420"><br>
      <sub><strong>Understand each contact.</strong> Give growth and support teams useful context without exposing fields your application has chosen not to share.</sub>
    </td>
  </tr>
</table>

FlowCastle shortens both development and feedback loops: launch with ready
modules, let non-developers operate the customer journey, and bring the results
back to developers as visible paths and measurable outcomes. Distribution stops
being an afterthought attached to finished code; it becomes part of how the
product is built.

## Privacy is configured in your process

Trust should come from enforceable boundaries, not a promise on a landing page.
The SDK filters Telegram data **inside your bot process**, before an event can
enter its bounded in-memory buffer or a FlowCastle network request.

- **Your Telegram bot token stays with your application.** You do not pass it to
  FlowCastle, and the SDK does not take over polling, webhooks, or shutdown.
- **Telegram user ID is the only mandatory contact field.** It provides the
  stable identity needed to associate events with a contact. Optional profile
  fields—username, first name, last name, language, Premium status, and
  attachment-menu status—use a local allowlist.
- **Message content has three modes.** `full` supports text-dependent flows;
  `routing` keeps commands and callback action identifiers but removes free
  text and structured content; `none` retains only operational IDs, timestamps,
  and update shape.
- **You can redact with your own code.** A synchronous or asynchronous callback
  can replace or remove selected text before it leaves the process. A thrown
  error or timeout fails closed: that field is dropped, never sent unredacted.
- **Your handlers still receive the original update.** Sanitization happens on a
  copy used by the FlowCastle path and does not mutate framework objects.
- **Runtime access is constrained locally.** FlowCastle flow jobs can call only
  a hardcoded Telegram operation allowlist. Token, webhook, polling, and bot
  lifecycle methods are refused regardless of server input. Inline file data is
  validated; server-provided filesystem paths are never opened.

For new integrations, pass `privacy: {}` explicitly. That selects no optional
contact fields and `routing` message content. Omitting `privacy` currently keeps
legacy full-content behavior for compatibility.

### Share only the contact data you need

```ts
const fc = flowcastle({
  apiKey: process.env.FLOWCASTLE_API_KEY!,
  privacy: {
    contactFields: ['username', 'languageCode'],
    messageContent: 'routing',
  },
});
```

### Redact sensitive text locally

```ts
const fc = flowcastle({
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
});
```

The automatic policy covers captured Telegram updates and observed outgoing
Bot API payloads. Values your application explicitly passes to `goal`,
`identify`, Live Chat notes, or flow inputs are developer-authored data and are
not implicitly transformed.

Read the complete contract in the [grammY privacy guide](packages/sdk-grammy/README.md#privacy-controls),
[Telegraf guide](packages/sdk-telegraf/README.md#privacy), and
[Python guide](packages/sdk-python/README.md).

## Supported adapters

| Framework | Package | Runtime |
| --- | --- | --- |
| [grammY](https://grammy.dev) | `@flowcastle/grammy` | Node.js 18+ |
| [Telegraf](https://telegraf.js.org) | `@flowcastle/telegraf` | Node.js 18+ |
| [aiogram 3](https://docs.aiogram.dev) | `flowcastle[aiogram]` | Python 3.10+ |
| [python-telegram-bot 21/22](https://python-telegram-bot.org) | `flowcastle[python-telegram-bot]` | Python 3.10+ |

The [cross-framework SDK plan](docs/CROSS_FRAMEWORK_TELEGRAM_SDK_PLAN.md)
documents the shared protocol, capability model, privacy contract, E2E layers,
and recipe for adding another framework or language.

## Repository layout

- [`packages/sdk-runtime`](packages/sdk-runtime) — TypeScript protocol, privacy,
  claims, matching, attachments, spooling, and leased-job primitives.
- [`packages/sdk-grammy`](packages/sdk-grammy) — grammY middleware and transport.
- [`packages/sdk-telegraf`](packages/sdk-telegraf) — Telegraf middleware and
  transport.
- [`packages/sdk-python`](packages/sdk-python) — dependency-light Python core
  with optional aiogram and python-telegram-bot adapters.
- [`packages/sdk-conformance`](packages/sdk-conformance) — language-neutral
  protocol-v2 fixtures.
- [`docs`](docs) — architecture, parity, rollout, and runtime design notes.

## Develop and test

```bash
pnpm install
python3 -m pip install -e './packages/sdk-python[dev,aiogram,python-telegram-bot]'
pnpm test
```

The credential-free suite builds every TypeScript package, exercises real
grammY, Telegraf, aiogram, and python-telegram-bot dispatchers without Telegram
credentials, runs the shared conformance fixtures, and checks the Python package
with strict mypy. Live Telegram testing is separate and requires dedicated test
credentials.

## Security

Please do not report vulnerabilities in a public issue. Follow
[`SECURITY.md`](SECURITY.md) and use GitHub's private vulnerability reporting.

## License

[MIT](LICENSE)
