# For AI coding agents

**Integrating this SDK into someone's bot?** Read `docs/AGENT_GUIDE.md` — one file with
the package matrix, credential flow, exact install order per framework, every option,
runtime semantics, a verification checklist and troubleshooting. Adapt the matching
project in `examples/` rather than writing from scratch. `llms.txt` is the link index.

**Working on this repository?**

- Node: `pnpm install && pnpm build && pnpm test:node`. Python: `pip install -e './packages/sdk-python[dev,aiogram,python-telegram-bot]' && pnpm test:python && pnpm typecheck:python` (strict mypy).
- `packages/sdk-runtime` is the framework-neutral protocol/privacy core; adapters in `sdk-grammy`, `sdk-telegraf`, `sdk-python/src/flowcastle/adapters` must stay thin and behaviourally identical — `packages/sdk-conformance/fixtures` is the shared contract.
- Privacy is fail-closed. Any change to `privacy.ts` / `privacy.py` needs a test in both languages.
- Never add a Bot API method to the runtime allowlist that changes token, webhook, polling or bot lifecycle.
- Public behaviour changes → update `README.md`, the package README, and `docs/AGENT_GUIDE.md` together.
