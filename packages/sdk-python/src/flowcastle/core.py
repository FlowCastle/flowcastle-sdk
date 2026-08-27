"""Framework-neutral FlowCastle protocol-v2 core."""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections import deque
import inspect
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Mapping, Protocol

from .privacy import PrivacyFilter, PrivacyOptions
from .transport import EventTransport
from .types import ConversationClaim, JobAck, JsonObject, RuntimeJob, RuntimeManifest, RuntimeRule, RuntimeUpdate, object_value

TELEGRAM_OPERATION_METHODS = {
    'sendMessage': 'send_message', 'sendPhoto': 'send_photo', 'sendDocument': 'send_document',
    'sendVideo': 'send_video', 'sendVideoNote': 'send_video_note', 'sendAnimation': 'send_animation',
    'sendAudio': 'send_audio', 'sendVoice': 'send_voice', 'sendSticker': 'send_sticker',
    'sendMediaGroup': 'send_media_group', 'sendContact': 'send_contact', 'sendDice': 'send_dice',
    'sendLocation': 'send_location', 'sendPoll': 'send_poll', 'sendVenue': 'send_venue',
    'sendInvoice': 'send_invoice', 'createInvoiceLink': 'create_invoice_link',
    'editMessageText': 'edit_message_text', 'editMessageMedia': 'edit_message_media',
    'editMessageReplyMarkup': 'edit_message_reply_markup', 'editMessageCaption': 'edit_message_caption',
    'deleteMessage': 'delete_message', 'answerCallbackQuery': 'answer_callback_query',
    'answerPreCheckoutQuery': 'answer_pre_checkout_query', 'sendChatAction': 'send_chat_action',
    'restrictChatMember': 'restrict_chat_member', 'banChatMember': 'ban_chat_member',
    'unbanChatMember': 'unban_chat_member', 'getChatMember': 'get_chat_member',
    'pinChatMessage': 'pin_chat_message', 'unpinChatMessage': 'unpin_chat_message',
    'getMe': 'get_me', 'refundStarPayment': 'refund_star_payment',
}
SAFE_TELEGRAM_OPERATIONS = frozenset(TELEGRAM_OPERATION_METHODS)
REFUSED_LIFECYCLE_OPERATIONS = frozenset({'getUpdates', 'setWebhook', 'deleteWebhook', 'close', 'logOut'})
FileDecoder = Callable[[bytes, str, str | None], object]
RUNTIME_SPOOL_MAX_ITEMS = 1000
RUNTIME_SPOOL_MAX_AGE_SECONDS = 5 * 60


class AsyncHttpClient(Protocol):
    async def request(self, method: str, url: str, headers: Mapping[str, str], body: JsonObject | None = None) -> tuple[int, Mapping[str, str], JsonObject]: ...


class StdlibHttpClient:
    """Small dependency-free HTTP implementation, run outside the event loop."""
    async def request(self, method: str, url: str, headers: Mapping[str, str], body: JsonObject | None = None) -> tuple[int, Mapping[str, str], JsonObject]:
        return await asyncio.to_thread(self._request, method, url, dict(headers), body)

    def _request(self, method: str, url: str, headers: dict[str, str], body: JsonObject | None) -> tuple[int, Mapping[str, str], JsonObject]:
        encoded = None if body is None else json.dumps(body).encode('utf-8')
        request = urllib.request.Request(url, data=encoded, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = response.read().decode('utf-8') or '{}'
                parsed = json.loads(payload)
                return response.status, dict(response.headers.items()), parsed if isinstance(parsed, dict) else {}
        except urllib.error.HTTPError as error:
            payload = error.read().decode('utf-8') or '{}'
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                parsed = {}
            return error.code, dict(error.headers.items()), parsed if isinstance(parsed, dict) else {}


@dataclass(frozen=True)
class FlowCastleOptions:
    api_key: str
    api_url: str = 'https://my.flowcastle.ai'
    privacy: PrivacyOptions | Mapping[str, object] | None = None
    runtime_enabled: bool = False
    instance_id: str | None = None
    on_error: Callable[[Exception], None] | None = None
    library_name: str = 'flowcastle-python'
    library_version: str = '0.1.0'
    flush_interval_ms: int = 3000
    max_batch_size: int = 20
    shutdown_flush_timeout_ms: int = 2000


class ConversationClaims:
    def __init__(self) -> None:
        self._values: dict[str, ConversationClaim] = {}

    def set(self, claim: ConversationClaim) -> None:
        prior = self._values.get(claim.conversation_key)
        if prior is None or claim.generation >= prior.generation:
            self._values[claim.conversation_key] = claim

    def clear(self, key: str, generation: float | None = None) -> None:
        current = self._values.get(key)
        if current and (generation is None or generation >= current.generation):
            self._values.pop(key, None)

    def get(self, key: str, now: float | None = None) -> ConversationClaim | None:
        claim = self._values.get(key)
        if claim and claim.expires_at <= (time.time() * 1000 if now is None else now):
            self._values.pop(key, None)
            return None
        return claim


def conversation_key(chat_id: int | str, actor_id: int | str | None = None, scope: str = 'chat_actor') -> str:
    return str(chat_id) if scope == 'chat' or actor_id is None else f'{chat_id}:{actor_id}'


def _parse_update(raw: JsonObject, identity: Mapping[str, str | int] | None = None) -> RuntimeUpdate:
    message = next((raw.get(key) for key in ('message', 'edited_message') if isinstance(raw.get(key), dict)), None)
    callback = raw.get('callback_query') if isinstance(raw.get('callback_query'), dict) else None
    chat = message.get('chat') if isinstance(message, dict) and isinstance(message.get('chat'), dict) else (callback.get('message', {}).get('chat') if isinstance(callback, dict) and isinstance(callback.get('message'), dict) and isinstance(callback['message'].get('chat'), dict) else None)
    sender = message.get('from') if isinstance(message, dict) and isinstance(message.get('from'), dict) else (callback.get('from') if isinstance(callback, dict) and isinstance(callback.get('from'), dict) else None)
    text = message.get('text') if isinstance(message, dict) and isinstance(message.get('text'), str) else None
    match = re.match(r'^/([^\s@]+)(?:@([^\s]+))?(?:\s+([\s\S]*))?$', text or '')
    chat_type = chat.get('type') if isinstance(chat, dict) and chat.get('type') in {'private', 'group', 'supergroup', 'channel'} else None
    bot_username = str(identity.get('username', '')).removeprefix('@').lower() if identity else ''
    bot_id = identity.get('id') if identity else None
    target = match.group(2).lower() if match and match.group(2) else ''
    reply = message.get('reply_to_message') if isinstance(message, dict) and isinstance(message.get('reply_to_message'), dict) else None
    reply_from = reply.get('from') if isinstance(reply, dict) and isinstance(reply.get('from'), dict) else None
    replies_to_bot = bot_id is not None and isinstance(reply_from, dict) and str(reply_from.get('id')) == str(bot_id)
    mentions_bot = bool(bot_username and isinstance(text, str) and f'@{bot_username}' in text.lower())
    command_addresses_bot = bool(match and (not target or not bot_username or target == bot_username))
    addressed = bool(chat_type == 'private' or callback or command_addresses_bot or replies_to_bot or mentions_bot)
    return RuntimeUpdate(
        raw=raw, update_id=raw.get('update_id') if isinstance(raw.get('update_id'), (int, str)) else None,
        chat_id=chat.get('id') if isinstance(chat, dict) and isinstance(chat.get('id'), (int, str)) else None,
        actor_id=sender.get('id') if isinstance(sender, dict) and isinstance(sender.get('id'), (int, str)) else None,
        chat_type=chat_type, text=text, command=match.group(1) if match else None,
        command_payload=match.group(3) if match and match.group(3) else None,
        callback_data=callback.get('data') if isinstance(callback, dict) and isinstance(callback.get('data'), str) else None,
        addressed=addressed,
    )


class FlowCastleContext:
    def __init__(self, core: 'FlowCastleCore', update: RuntimeUpdate) -> None:
        self._core = core
        self._update = update

    async def goal(self, key: str, props: JsonObject | None = None) -> None:
        self._core.enqueue_event({'type': 'goal', 'at': int(time.time() * 1000), 'key': key, 'telegramUserId': self._update.actor_id, 'chatId': self._update.chat_id, **({'props': props} if props else {})})

    async def identify(self, props: JsonObject) -> None:
        if self._update.actor_id is None:
            self._core.report(ValueError('FlowCastle: identify() called without a sender'))
            return
        self._core.enqueue_event({'type': 'identify', 'at': int(time.time() * 1000), 'telegramUserId': self._update.actor_id, 'props': props})

    async def request_live_agent(self, note: str | None = None) -> None:
        if self._update.actor_id is None:
            self._core.report(ValueError('FlowCastle: request_live_agent() called without a sender'))
            return
        event: JsonObject = {'type': 'live_agent_request', 'at': int(time.time() * 1000), 'telegramUserId': self._update.actor_id}
        if self._update.chat_id is not None:
            event['chatId'] = self._update.chat_id
        if note is not None:
            event['note'] = note[:500]
        self._core.enqueue_event(event)

    async def run_flow(self, flow_key: str, inputs: JsonObject | None = None) -> JsonObject:
        if not self._core.options.runtime_enabled:
            raise RuntimeError('FlowCastle: run_flow() requires runtime_enabled=True')
        if not flow_key:
            raise ValueError('FlowCastle: flow_key must be non-empty')
        return await self._core.request('POST', '/api/sdk/v1/runtime-runs', {'flowKey': flow_key, 'update': self._update.raw, **({'inputs': inputs} if inputs else {})}, required=True)


class RuntimeJobExecutor:
    """Explicit allowlist dispatcher; never uses a server supplied lifecycle API."""
    def __init__(self, file_decoder: FileDecoder | None = None) -> None:
        self._file_decoder = file_decoder

    async def execute(self, bot: object, job: RuntimeJob, claims: ConversationClaims) -> JobAck:
        if job.kind == 'control':
            return self._control(job, claims)
        operation = job.operation
        if operation not in SAFE_TELEGRAM_OPERATIONS or operation in REFUSED_LIFECYCLE_OPERATIONS:
            return JobAck(job.id, False, job.lease_token, error={'code': 400, 'description': 'method not allowed'})
        method_name = TELEGRAM_OPERATION_METHODS.get(operation)
        method = getattr(bot, method_name, None) if method_name is not None else None
        if not callable(method):
            return JobAck(job.id, False, job.lease_token, error={'code': 400, 'description': 'operation unavailable'})
        try:
            result = method(**self._decode_params(job.params))
            if inspect.isawaitable(result):
                result = await result
            return JobAck(job.id, True, job.lease_token, result=self._json_result(result))
        except Exception as error:
            return JobAck(job.id, False, job.lease_token, error={'description': str(error) or 'Telegram operation failed'})

    def _control(self, job: RuntimeJob, claims: ConversationClaims) -> JobAck:
        if job.operation not in {'conversation_claim', 'session_state', 'sessionState'}:
            return JobAck(job.id, False, job.lease_token, error={'code': 400, 'description': 'control operation not allowed'})
        key = job.params.get('conversationKey', job.chat_key)
        active = job.params.get('active')
        generation = job.params.get('generation', 0)
        if not isinstance(key, str) or not isinstance(active, bool) or not isinstance(generation, (int, float)):
            return JobAck(job.id, False, job.lease_token, error={'code': 400, 'description': 'invalid session state job'})
        if active:
            expiry = job.params.get('expiresAt')
            claims.set(ConversationClaim(key, generation, tuple(item for item in job.params.get('kinds', ['flow']) if isinstance(item, str)), expiry if isinstance(expiry, (int, float)) else time.time() * 1000 + 1800000))
        else:
            claims.clear(key, generation)
        return JobAck(job.id, True, job.lease_token)

    def _decode_params(self, params: JsonObject) -> dict[str, object]:
        return {key: self._decode_value(value) for key, value in params.items()}

    def _decode_value(self, value: object) -> object:
        if isinstance(value, dict):
            marker = value.get('$flowcastleFile')
            if isinstance(marker, dict) and isinstance(marker.get('filename'), str) and isinstance(marker.get('base64'), str):
                try:
                    data = base64.b64decode(marker['base64'], validate=True)
                except (binascii.Error, ValueError) as error:
                    raise ValueError('FlowCastle: invalid base64 file marker') from error
                if len(data) > 20 * 1024 * 1024:
                    raise ValueError('FlowCastle: file marker exceeds 20 MiB')
                content_type = marker.get('contentType') if isinstance(marker.get('contentType'), str) else None
                return self._file_decoder(data, marker['filename'], content_type) if self._file_decoder else data
            return {key: self._decode_value(entry) for key, entry in value.items()}
        if isinstance(value, list):
            return [self._decode_value(entry) for entry in value]
        return value

    def _json_result(self, result: object) -> JsonObject | str | int | float | bool | None:
        model_dump = getattr(result, 'model_dump', None)
        to_dict = getattr(result, 'to_dict', None)
        if callable(model_dump):
            result = model_dump()
        elif callable(to_dict):
            result = to_dict()
        value = object_value(result) if isinstance(result, dict) else result
        return value if isinstance(value, (dict, str, int, float, bool)) or value is None else str(value)


class FlowCastleCore:
    def __init__(self, options: FlowCastleOptions, http: AsyncHttpClient | None = None) -> None:
        self.options = options
        self.http = http or StdlibHttpClient()
        self.privacy = PrivacyFilter(options.privacy, self.report)
        self.claims = ConversationClaims()
        self.manifest: RuntimeManifest | None = None
        self._etag: str | None = None
        self._claim_cursor: str | None = None
        self._instance_id = options.instance_id or str(uuid.uuid4())
        self._event_transport = EventTransport(
            self._send_event_batch,
            self.report,
            options.flush_interval_ms,
            options.max_batch_size,
        )
        self._runtime_spool: deque[tuple[float, JsonObject]] = deque(maxlen=RUNTIME_SPOOL_MAX_ITEMS)
        self._runtime_spool_lock = asyncio.Lock()
        self._flushing_runtime_spool = False
        self._running = False
        self._bot: object | None = None
        self._executor: RuntimeJobExecutor | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def proxy_owns_jobs(self) -> bool:
        return self.options.runtime_enabled

    def report(self, error: Exception) -> None:
        if self.options.on_error:
            try:
                self.options.on_error(error)
            except Exception:
                pass

    async def request(self, method: str, path: str, body: JsonObject | None = None, required: bool = False) -> JsonObject:
        try:
            status, _headers, response = await self.http.request(method, self.options.api_url.rstrip('/') + path, {'Authorization': f'Bearer {self.options.api_key}', **({'Content-Type': 'application/json'} if body is not None else {})}, body)
            if not 200 <= status < 300:
                raise RuntimeError(f'FlowCastle request failed ({status})')
            return response
        except Exception as error:
            self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))
            if required:
                raise
            return {}

    async def ready(self) -> None:
        await self.refresh_manifest()
        await self.refresh_claims()

    async def start(self, bot: object, executor: RuntimeJobExecutor | None = None) -> None:
        """Start continuous synchronization, heartbeat, and leased-job delivery."""
        self._event_transport.start()
        if not self.options.runtime_enabled:
            return
        self._bot = bot
        self._executor = executor or RuntimeJobExecutor()
        if self._running:
            return
        self._running = True
        for coroutine in (self._sync_loop(), self._job_loop(), self._heartbeat_loop()):
            task = asyncio.create_task(coroutine)
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def stop(self) -> None:
        self._running = False
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        await self._event_transport.stop(self.options.shutdown_flush_timeout_ms)

    async def refresh_manifest(self) -> None:
        headers: dict[str, str] = {'Authorization': f'Bearer {self.options.api_key}'}
        if self._etag:
            headers['If-None-Match'] = self._etag
        try:
            status, response_headers, body = await self.http.request('GET', self.options.api_url.rstrip('/') + '/api/sdk/v1/manifest', headers)
            if status == 304:
                return
            if status != 200:
                raise RuntimeError(f'FlowCastle manifest request failed ({status})')
            manifest = self._manifest(body)
            if manifest is None:
                raise RuntimeError('FlowCastle: invalid runtime manifest')
            self.manifest = manifest
            self._etag = response_headers.get('etag') or manifest.version
        except Exception as error:
            self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))

    async def refresh_claims(self) -> None:
        await self.flush_runtime_spool()
        suffix = '' if not self._claim_cursor else f'?cursor={self._claim_cursor}'
        body = await self.request('GET', '/api/sdk/v1/claims' + suffix)
        cursor, entries = body.get('cursor'), body.get('claims')
        if not isinstance(cursor, str) or not isinstance(entries, list):
            return
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get('conversationKey'), str):
                continue
            generation, expiry, active = entry.get('generation'), entry.get('expiresAt'), entry.get('active')
            if not isinstance(generation, (int, float)) or not isinstance(expiry, (int, float)) or not isinstance(active, bool):
                continue
            if active:
                self.claims.set(ConversationClaim(entry['conversationKey'], generation, tuple(v for v in entry.get('kinds', []) if isinstance(v, str)), expiry))
            else:
                self.claims.clear(entry['conversationKey'], generation)
        self._claim_cursor = cursor

    def enqueue_event(self, event: JsonObject) -> None:
        self._event_transport.enqueue(event)

    async def ingest(self, event: JsonObject) -> bool:
        """Queue a best-effort observed event without awaiting network delivery."""
        self.enqueue_event(event)
        return True

    async def flush_events(self) -> None:
        await self._event_transport.flush()

    async def _ingest_required(self, event: JsonObject) -> bool:
        """Await the ownership hand-off for an update claimed by a FlowCastle flow."""
        delivered = await self._post_required_event(event)
        if not delivered:
            await self._spool_runtime_event(event)
        return delivered

    async def _post_required_event(self, event: JsonObject) -> bool:
        try:
            status, _headers, _body = await self.http.request(
                'POST',
                self.options.api_url.rstrip('/') + '/api/sdk/v1/events',
                {'Authorization': f'Bearer {self.options.api_key}', 'Content-Type': 'application/json'},
                {'sdkVersion': 'python-v2', 'events': [event]},
            )
            if not 200 <= status < 300:
                raise RuntimeError(f'FlowCastle event ingest failed ({status})')
            return True
        except Exception as error:
            self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))
            return False

    async def _spool_runtime_event(self, event: JsonObject) -> None:
        async with self._runtime_spool_lock:
            self._prune_runtime_spool(time.monotonic())
            if len(self._runtime_spool) == self._runtime_spool.maxlen:
                self.report(RuntimeError('FlowCastle: dropped oldest matched event from runtime outage spool'))
            self._runtime_spool.append((time.monotonic(), event))

    async def flush_runtime_spool(self) -> None:
        async with self._runtime_spool_lock:
            self._prune_runtime_spool(time.monotonic())
            if self._flushing_runtime_spool or not self._runtime_spool:
                return
            self._flushing_runtime_spool = True
            pending = list(self._runtime_spool)
            self._runtime_spool.clear()
        try:
            for index, (_created_at, event) in enumerate(pending):
                if await self._post_required_event(event):
                    continue
                async with self._runtime_spool_lock:
                    combined = pending[index:] + list(self._runtime_spool)
                    dropped = max(0, len(combined) - RUNTIME_SPOOL_MAX_ITEMS)
                    self._runtime_spool = deque(combined[dropped:], maxlen=RUNTIME_SPOOL_MAX_ITEMS)
                    if dropped:
                        self.report(RuntimeError(f'FlowCastle: dropped {dropped} matched event(s) from runtime outage spool'))
                    self._prune_runtime_spool(time.monotonic())
                return
        finally:
            async with self._runtime_spool_lock:
                self._flushing_runtime_spool = False

    def _prune_runtime_spool(self, now: float) -> None:
        dropped = 0
        while self._runtime_spool and now - self._runtime_spool[0][0] > RUNTIME_SPOOL_MAX_AGE_SECONDS:
            self._runtime_spool.popleft()
            dropped += 1
        if dropped:
            self.report(RuntimeError(f'FlowCastle: dropped {dropped} expired matched event(s) from runtime outage spool'))

    async def _send_event_batch(self, events: list[JsonObject]) -> None:
        for attempt in range(2):
            try:
                status, _headers, _body = await self.http.request(
                    'POST',
                    self.options.api_url.rstrip('/') + '/api/sdk/v1/events',
                    {'Authorization': f'Bearer {self.options.api_key}', 'Content-Type': 'application/json'},
                    {'sdkVersion': 'python-v2', 'events': events},
                )
            except Exception as error:
                if attempt == 0:
                    continue
                self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))
                return

            if 200 <= status < 300:
                return
            if status >= 500 and attempt == 0:
                continue
            if status == 401:
                self.report(RuntimeError('FlowCastle: ingest rejected api_key (401)'))
            elif status >= 500:
                self.report(RuntimeError(f'FlowCastle: ingest failed ({status}), dropping batch'))
            return

    async def process(self, raw: JsonObject, identity: Mapping[str, str | int] | None = None) -> tuple[bool, FlowCastleContext | None]:
        sanitized = await self.privacy.sanitize_update(raw)
        update = _parse_update(sanitized, identity)
        matched = self.matches(update)
        event: JsonObject = {'type': 'update', 'at': int(time.time() * 1000), 'handled': matched, 'update': sanitized}
        if matched:
            await self._ingest_required(event)
        else:
            self.enqueue_event(event)
        return matched, None if matched else FlowCastleContext(self, update)

    def matches(self, update: RuntimeUpdate) -> bool:
        if update.chat_id is not None and (self.claims.get(conversation_key(update.chat_id, update.actor_id)) or self.claims.get(conversation_key(update.chat_id, None, 'chat'))):
            return True
        if self.manifest is None:
            return False
        return any(self._rule_matches(rule, update) for rule in sorted(self.manifest.rules, key=lambda rule: rule.priority or 0, reverse=True))

    async def heartbeat(self, account_id: str | int, username: str | None = None) -> bool:
        body: JsonObject = {'instanceId': self._instance_id, 'client': {'name': self.options.library_name, 'version': self.options.library_version}, 'identity': {'platform': 'telegram', 'accountId': str(account_id), **({'username': username} if username else {})}, 'capabilities': self.capabilities(), 'protocolVersion': 2}
        return bool(await self.request('POST', '/api/sdk/v1/runtime/heartbeat', body))

    async def poll_and_dispatch(self, bot: object, executor: RuntimeJobExecutor | None = None) -> list[JobAck]:
        query = urllib.parse.urlencode([('waitMs', '0'), ('max', '10'), ('protocolVersion', '2'), *[('capability', capability) for capability in self.capabilities()]])
        body = await self.request('GET', '/api/sdk/v1/jobs?' + query)
        jobs = [self._job(item) for item in body.get('jobs', []) if isinstance(item, dict)]
        acks = [await (executor or RuntimeJobExecutor()).execute(bot, job, self.claims) for job in jobs if job]
        if acks:
            await self.request('POST', '/api/sdk/v1/jobs/ack', {'protocolVersion': 2, 'results': [self._ack(ack) for ack in acks]})
        return acks

    def capabilities(self) -> list[str]:
        aggregate = ['telegram.bot_api', 'telegram.send_message', 'telegram.inline_keyboard', 'telegram.media', 'telegram.payments']
        methods = [f'transport.telegram.bot_api.{operation}' for operation in sorted(SAFE_TELEGRAM_OPERATIONS)]
        return aggregate + methods

    async def _sync_loop(self) -> None:
        manifest_due = 0.0
        while self._running:
            try:
                now = time.monotonic()
                if now >= manifest_due:
                    await self.refresh_manifest()
                    manifest_due = now + 25
                await self.refresh_claims()
            except Exception as error:
                self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))
            await asyncio.sleep(2)

    async def _job_loop(self) -> None:
        while self._running:
            try:
                if self._bot is not None:
                    await self.poll_and_dispatch(self._bot, self._executor)
            except Exception as error:
                self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))
            await asyncio.sleep(0.25)

    async def _heartbeat_loop(self) -> None:
        while self._running:
            try:
                identity = await self._bot_identity()
                if identity is not None:
                    await self.heartbeat(identity[0], identity[1])
            except Exception as error:
                self.report(error if isinstance(error, Exception) else RuntimeError(str(error)))
            await asyncio.sleep(30)

    async def _bot_identity(self) -> tuple[str | int, str | None] | None:
        if self._bot is None:
            return None
        get_me = getattr(self._bot, 'get_me', None)
        if not callable(get_me):
            return None
        result = get_me()
        me = await result if inspect.isawaitable(result) else result
        if isinstance(me, dict):
            account_id = me.get('id')
            username = me.get('username')
        else:
            account_id = getattr(me, 'id', None)
            username = getattr(me, 'username', None)
        if not isinstance(account_id, (str, int)):
            return None
        return account_id, username if isinstance(username, str) else None

    def _rule_matches(self, rule: RuntimeRule, update: RuntimeUpdate) -> bool:
        if rule.chat_types and update.chat_type not in rule.chat_types or rule.visibility == 'addressed' and not update.addressed:
            return False
        if rule.kind == 'command':
            return update.command is not None and update.command.lstrip('/').split('@')[0] == (rule.command or '').lstrip('/')
        if rule.kind == 'deep_link':
            return update.command == 'start' and self._text_matches(rule, update.command_payload or '')
        if rule.kind == 'message':
            return update.text is not None and self._text_matches(rule, update.text)
        if rule.kind == 'callback':
            data = rule.callback_data or {}
            return update.callback_data is not None and (data.get('exact') == update.callback_data or isinstance(data.get('prefix'), str) and update.callback_data.startswith(data['prefix']))
        return rule.kind == 'event' and update.event_type == rule.event_type

    def _text_matches(self, rule: RuntimeRule, text: str) -> bool:
        if not rule.text:
            return rule.kind == 'message'
        operator, expected = rule.text.get('operator'), rule.text.get('value')
        if not isinstance(expected, str):
            return False
        source = text if rule.text.get('caseSensitive') else text.lower()
        target = expected if rule.text.get('caseSensitive') else expected.lower()
        try:
            outcomes = {'equals': source == target, 'contains': target in source, 'starts_with': source.startswith(target), 'regex': bool(re.search(expected, text, 0 if rule.text.get('caseSensitive') else re.I))}
            return outcomes.get(str(operator), False)
        except re.error:
            return False

    def _manifest(self, body: JsonObject) -> RuntimeManifest | None:
        if not isinstance(body.get('version'), str) or not isinstance(body.get('rules'), list):
            return None
        rules: list[RuntimeRule] = []
        for raw in body['rules']:
            if not isinstance(raw, dict) or not isinstance(raw.get('id'), str) or not isinstance(raw.get('flowId'), str) or raw.get('kind') not in {'command', 'message', 'deep_link', 'callback', 'event'}:
                continue
            rules.append(RuntimeRule(raw['id'], raw['flowId'], raw['kind'], tuple(raw['chatTypes']) if isinstance(raw.get('chatTypes'), list) else None, raw.get('visibility') if raw.get('visibility') in {'all', 'addressed'} else None, raw.get('command') if isinstance(raw.get('command'), str) else None, raw.get('text') if isinstance(raw.get('text'), dict) else None, raw.get('callbackData') if isinstance(raw.get('callbackData'), dict) else None, raw.get('eventType') if isinstance(raw.get('eventType'), str) else None, raw.get('claimScope') if raw.get('claimScope') in {'chat', 'chat_actor'} else None, raw.get('priority') if isinstance(raw.get('priority'), (int, float)) else None))
        return RuntimeManifest(int(body.get('protocolVersion', 1)), body['version'], tuple(rules), tuple(value for value in body.get('requiredCapabilities', []) if isinstance(value, str)))

    def _job(self, raw: JsonObject) -> RuntimeJob | None:
        kind = raw.get('kind')
        # `telegram_call`/`session_state` and `method` are intentionally accepted
        # only as legacy aliases while canonical v2 uses transport_call/control.
        canonical_kind: str | None = 'transport_call' if kind in {'transport_call', 'telegram_call'} else 'control' if kind in {'control', 'session_state'} else None
        operation = raw.get('operation', raw.get('method'))
        lease_token = raw.get('leaseToken')
        if not isinstance(raw.get('id'), str) or canonical_kind is None or not isinstance(raw.get('params'), dict) or not isinstance(operation, str) or not isinstance(lease_token, str) or not lease_token:
            return None
        job_kind: Literal['transport_call', 'control'] = 'transport_call' if canonical_kind == 'transport_call' else 'control'
        transport = raw.get('transport')
        return RuntimeJob(raw['id'], job_kind, raw['params'], int(raw.get('protocolVersion', 1)), lease_token, operation, transport if isinstance(transport, str) else 'telegram', raw.get('conversationKey') if isinstance(raw.get('conversationKey'), str) else None)

    def _ack(self, ack: JobAck) -> JsonObject:
        result: JsonObject = {'id': ack.id, 'ok': ack.ok}
        if ack.lease_token:
            result['leaseToken'] = ack.lease_token
        if ack.ok and ack.result is not None:
            result['result'] = ack.result
        if not ack.ok:
            result['error'] = ack.error or {'description': 'SDK transport call failed'}
        return result
