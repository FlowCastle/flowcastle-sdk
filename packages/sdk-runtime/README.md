# @flowcastle/sdk-runtime

Library-neutral protocol and privacy primitives used by FlowCastle Telegram SDK
adapters. It contains no grammY context types and is the reference contract for
Node.js adapters and the mirrored Python implementation.

Implemented adapters are `@flowcastle/grammy`, `@flowcastle/telegraf`, and the
Python `flowcastle` package with optional aiogram and python-telegram-bot extras.
All consume the versioned fixtures in `packages/sdk-conformance`; the rollout
and future-adapter checklist lives in
`docs/CROSS_FRAMEWORK_TELEGRAM_SDK_PLAN.md`.

## Privacy contract

`TelegramPrivacyOptions` controls the automatic Telegram data an adapter may
send to FlowCastle:

```ts
import { TelegramPrivacyFilter } from '@flowcastle/sdk-runtime';

const privacy = new TelegramPrivacyFilter({
  contactFields: ['username'],
  messageContent: {
    mode: 'full',
    transformText: ({ value }) => value.replaceAll('secret', '[REDACTED]'),
  },
});

const safeUpdate = await privacy.sanitizeUpdate(rawTelegramUpdate);
```

- Contact fields are an allowlist of `username`, `firstName`, `lastName`,
  `languageCode`, `isPremium`, and `addedToAttachmentMenu`. User, chat, update,
  and message ids remain operational.
- Message modes are `full`, `routing`, and `none`.
- `transformText` may return a string, `null`, or a promise of either.
- Transformation failures and timeouts drop the field. The raw value is never a
  fallback.
- The sanitizer deep-clones its input and never mutates the host framework's
  update.

Omitting privacy options preserves the original full-content SDK behavior.
Passing `{}` selects the privacy-first defaults: no optional contact profile
fields and routing-only message content.

## Adapter requirements

Every Telegram adapter must sanitize before buffering, outage spooling, runtime
matching, event ingest, or explicit flow execution. It must use the same
sanitized update throughout those paths while leaving the framework's original
update untouched for customer handlers.

Explicit application values—goal properties, identify properties, escalation
notes, and explicit flow inputs—are outside automatic Telegram sanitization.
Adapters must document that boundary.

Python implementations should mirror the exported option names, content modes,
text-field context values, null/drop behavior, default timeout, and fail-closed
semantics even though they cannot import this TypeScript package directly.
