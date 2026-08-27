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

The installed framework middleware/handler starts background event delivery,
continuous claim and manifest refresh, heartbeat, and leased job delivery as
soon as it receives the framework Bot instance. If you call `handle_update`
directly, start it explicitly with `await adapter.start(bot)`. During graceful
shutdown, call `await adapter.stop()`.

## Performance boundary

Ordinary commands, callbacks, and other unmatched updates do not wait for a
FlowCastle network request. After local privacy filtering and manifest matching,
the SDK places the observed event in a bounded in-memory queue and immediately
continues to your framework handler. `goal`, `identify`, and
`request_live_agent` use the same fire-and-forget queue even though their async
method signatures remain unchanged for compatibility.

The queue holds at most 500 events, drops the oldest event if full, flushes every
three seconds or at 20 events, and sends at most 50 events per request. A
transient network or 5xx failure is retried once in the background and then
dropped. This prevents FlowCastle availability from creating latency or
unbounded memory growth in the host bot.

Two operations intentionally remain on the request path:

- A manifest- or claim-matched update awaits FlowCastle ingestion because the
  flow owns that update and the SDK must not let the customer handler reply too.
  If the hand-off fails, its sanitized event enters a separate bounded runtime
  outage spool for replay; it does not fall through and risk a duplicate reply.
- `run_flow` awaits server acceptance because its return value contains the new
  execution id.

Async privacy transformers are also awaited locally before enqueueing so raw
content can never race past redaction. Call `await adapter.flush()` when a test
or application checkpoint needs deterministic delivery. `adapter.stop()`
performs a bounded final flush; configure `shutdown_flush_timeout_ms` to change
its 2000 ms default. `flush_interval_ms` and `max_batch_size` default to 3000 and
20 respectively.

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
