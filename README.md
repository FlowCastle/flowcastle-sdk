# FlowCastle SDKs

Official, framework-friendly SDKs for connecting an existing Telegram bot to
[FlowCastle](https://flowcastle.ai). Your application keeps ownership of its bot
token, polling or webhook lifecycle, Telegram client, and ordinary handlers.
FlowCastle receives only the data allowed by the SDK's local privacy policy.

This public monorepo contains every supported adapter and the shared protocol
conformance suite:

| Framework | Package | Runtime |
| --- | --- | --- |
| grammY | `@flowcastle/grammy` | Node.js 18+ |
| Telegraf | `@flowcastle/telegraf` | Node.js 18+ |
| aiogram 3 | `flowcastle[aiogram]` | Python 3.10+ |
| python-telegram-bot 21/22 | `flowcastle[python-telegram-bot]` | Python 3.10+ |

The packages are currently in release-hardening. Review the adapter README
before using a source build in production.

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

## Privacy and transport boundary

Telegram user id is required for stable contact identity. Optional contact
fields and message content are controlled locally when initializing an adapter.
Async text transformers may redact or remove individual values before they
enter a buffer, outage spool, or network request. Transform failures are
fail-closed.

Runtime jobs use a hardcoded Bot API allowlist and a lease token. Webhook,
polling, token, and bot-lifecycle operations are refused locally regardless of
server input. Inline files are validated and decoded to each framework's native
upload type; the SDK never opens a server-provided filesystem path.

See the [grammY](packages/sdk-grammy/README.md),
[Telegraf](packages/sdk-telegraf/README.md), and
[Python](packages/sdk-python/README.md) guides for configuration examples.

## Development

Install Node dependencies:

```bash
pnpm install
```

Install Python test dependencies:

```bash
python3 -m pip install -e './packages/sdk-python[dev,aiogram,python-telegram-bot]'
```

Run the complete credential-free suite:

```bash
pnpm test
```

The suite builds all TypeScript packages, exercises real grammY, Telegraf,
aiogram, and python-telegram-bot dispatchers without Telegram credentials, runs
the shared conformance fixtures, and checks the Python package with strict
mypy. Live Telegram testing is intentionally separate and requires dedicated
test credentials.

## Documentation

The [cross-framework SDK plan](docs/CROSS_FRAMEWORK_TELEGRAM_SDK_PLAN.md)
documents the stable architecture, capability model, privacy contract, E2E
layers, and recipe for adding another Telegram framework or language.

## Security

Please do not report vulnerabilities in a public issue. Follow
[`SECURITY.md`](SECURITY.md) and use GitHub's private vulnerability reporting.

## License

[MIT](LICENSE)
