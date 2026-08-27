# FlowCastle SDK conformance fixtures

Language and framework adapters consume the fixtures in this directory to
prove that they implement the same wire behavior. This directory is not a
runtime package and is not published.

An adapter is conformant when it:

- produces the expected normalized update fields and routing decision;
- accepts canonical protocol-v2 transport jobs and preserves lease tokens;
- independently refuses Telegram lifecycle operations such as `setWebhook`;
- sends canonical acknowledgements, including the structured `error` envelope;
- applies privacy before matching, buffering, spooling, ingest, or `runFlow`.

Compatibility aliases from the original grammY beta may be accepted, but new
adapters and server fixtures use the canonical `transport_call` / `control`
and `operation` vocabulary.

Run the complete credential-free matrix from the repository root:

```bash
pnpm sdk:e2e
```

This builds the TypeScript SDKs, runs the shared/runtime and real framework
dispatcher tests for grammY, Telegraf, aiogram, and python-telegram-bot, checks
the Python package with strict mypy, and drives the real Express ingest/runtime
controllers with infrastructure leaves stubbed. It is intentionally hermetic:
it does not claim to exercise live Telegram, Postgres, Redis, or a deployed
`FlowExecutor`. Those full-stack and credentialed layers are tracked separately
in `docs/CROSS_FRAMEWORK_TELEGRAM_SDK_PLAN.md`.
