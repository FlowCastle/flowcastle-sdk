# FlowCastle Python SDK

`flowcastle` is a protocol-v2 SDK with a framework-neutral core and optional
thin adapters for aiogram 3.x and python-telegram-bot 21+.

```bash
pip install 'flowcastle[aiogram]'
# or
pip install 'flowcastle[python-telegram-bot]'
```

The package itself does not import either framework.  Its adapters receive the
framework update object, convert it to the Bot API JSON shape, and delegate all
routing, privacy and FlowCastle HTTP work to `FlowCastleCore`.

```python
from flowcastle import FlowCastleCore, FlowCastleOptions
from flowcastle.adapters.aiogram import AiogramAdapter

core = FlowCastleCore(FlowCastleOptions(api_key='fc_sdk_…', runtime_enabled=True))
adapter = AiogramAdapter(core)

# Run once before polling/webhook startup, then install the middleware.
await adapter.ready()
adapter.install(dispatcher)
```

For python-telegram-bot, install the adapter in an early handler group. Matched
updates stop before customer handlers; unmatched updates continue normally with
`context.flowcastle` available:

```python
from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter

adapter = PythonTelegramBotAdapter(core)
await adapter.ready()
adapter.install(application)
```

The installed framework middleware/handler starts continuous claim and manifest
refresh, heartbeat, outage-spool replay, and leased job delivery as soon as it
receives the framework Bot instance. If you call `handle_update` directly,
start it explicitly with `await adapter.start(bot)`. During graceful shutdown,
call `await adapter.stop()`.

`FlowCastleContext` exposes async `goal`, `identify`, `request_live_agent`, and
`run_flow` methods. `run_flow` is only available when `runtime_enabled=True`.

Privacy is fail-closed for transform failures/timeouts. Passing `privacy={}`
uses routing-only content and no optional contact fields; omitting privacy
retains full-content compatibility behavior. The runtime matches a local,
server-supplied manifest and consumes matched/claimed updates. It only executes
the documented Bot API allowlist; polling/webhook/token/lifecycle methods are
permanently refused.

```python
from flowcastle import PrivacyOptions

async def redact(context):
    return context['value'].replace('customer-secret', '[REDACTED]')

options = FlowCastleOptions(
    api_key='fc_sdk_…',
    runtime_enabled=True,
    privacy=PrivacyOptions(
        contact_fields=('username',),
        message_content='full',
        transform_text=redact,
        transform_timeout_ms=750,
    ),
)
```

Telegram user id and operational chat/update/message ids are always retained.
Application-authored values passed to `goal`, `identify`, live-agent notes, or
`run_flow(inputs=...)` are explicit developer inputs and are not transformed by
the automatic Telegram privacy policy.

Runtime media jobs accept only inline `$flowcastleFile` markers containing a
filename and validated base64 content, capped at 20 MiB. Each adapter converts
the bytes to its framework-native upload type; no server-supplied filesystem
path is opened and no arbitrary Bot method is invoked.

For testability, pass an `AsyncHttpClient` implementation to `FlowCastleCore`.
The default client uses only the standard library (`urllib`) in a worker thread.

From the repository root, run all Python adapter tests with:

```bash
pnpm sdk:test:python
python3 -m mypy --config-file packages/sdk-python/pyproject.toml packages/sdk-python/src/flowcastle
```
