from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Mapping

import pytest

from flowcastle import FlowCastleCore, FlowCastleOptions, PrivacyOptions, RuntimeJobExecutor
from flowcastle.adapters.aiogram import AiogramAdapter
from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter
from flowcastle.types import JsonObject, RuntimeJob, RuntimeUpdate


class FakeHttp:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, JsonObject | None]] = []
        self.manifest: JsonObject = {'protocolVersion': 2, 'version': 'v1', 'rules': [{'id': 'start', 'flowId': 'welcome', 'kind': 'command', 'command': 'start'}]}
        self.jobs: list[JsonObject] = []
        self.fail_events = False

    async def request(self, method: str, url: str, headers: Mapping[str, str], body: JsonObject | None = None) -> tuple[int, Mapping[str, str], JsonObject]:
        self.calls.append((method, url, body))
        if url.endswith('/manifest'):
            return 200, {'etag': 'v1'}, self.manifest
        if '/claims' in url:
            return 200, {}, {'cursor': 'cursor-1', 'claims': []}
        if '/jobs?' in url:
            return 200, {}, {'jobs': self.jobs}
        if url.endswith('/events') and self.fail_events:
            raise OSError('offline')
        if url.endswith('/runtime-runs'):
            return 202, {}, {'executionId': 'run-1', 'acceptedAt': 1}
        return 202, {}, {'ok': True}


class BlockingEventHttp(FakeHttp):
    def __init__(self) -> None:
        super().__init__()
        self.release_events = asyncio.Event()
        self.events_started = asyncio.Event()
        self.active_event_requests = 0
        self.max_active_event_requests = 0

    async def request(self, method: str, url: str, headers: Mapping[str, str], body: JsonObject | None = None) -> tuple[int, Mapping[str, str], JsonObject]:
        if url.endswith('/events'):
            self.active_event_requests += 1
            self.max_active_event_requests = max(self.max_active_event_requests, self.active_event_requests)
            try:
                self.events_started.set()
                await self.release_events.wait()
                return await super().request(method, url, headers, body)
            finally:
                self.active_event_requests -= 1
        return await super().request(method, url, headers, body)


class SequencedEventHttp(FakeHttp):
    def __init__(self, statuses: list[int | Exception]) -> None:
        super().__init__()
        self.statuses = statuses

    async def request(self, method: str, url: str, headers: Mapping[str, str], body: JsonObject | None = None) -> tuple[int, Mapping[str, str], JsonObject]:
        if url.endswith('/events') and self.statuses:
            self.calls.append((method, url, body))
            result = self.statuses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result, {}, {'ok': 200 <= result < 300}
        return await super().request(method, url, headers, body)


class FakeUpdate:
    def __init__(self, payload: JsonObject) -> None:
        self.payload = payload

    def model_dump(self) -> JsonObject:
        return self.payload

    def to_dict(self) -> JsonObject:
        return self.payload


class FakeBot:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_message(self, chat_id: int, text: str) -> JsonObject:
        self.sent.append(text)
        return {'message_id': 10}

    async def get_me(self) -> JsonObject:
        return {'id': 42, 'username': 'python_test_bot'}


class FakeMediaBot:
    def __init__(self) -> None:
        self.photo: object | None = None

    async def send_photo(self, chat_id: int, photo: object) -> JsonObject:
        assert chat_id == 4
        self.photo = photo
        return {'message_id': 11}


def update(text: str, user: int = 7) -> JsonObject:
    return {'update_id': 1, 'message': {'message_id': 2, 'date': 1, 'text': text, 'chat': {'id': 4, 'type': 'private'}, 'from': {'id': user, 'is_bot': False, 'first_name': 'Private', 'username': 'private'}}}


async def test_unmatched_update_does_not_wait_for_slow_event_ingest() -> None:
    # Arrange
    http = BlockingEventHttp()
    core = FlowCastleCore(FlowCastleOptions('key'), http)
    adapter = AiogramAdapter(core)
    called: list[str] = []

    async def customer(_update: object, _context: object) -> None:
        called.append('customer')

    # Act
    handling = asyncio.create_task(adapter.handle_update(FakeUpdate(update('plain')), customer))
    try:
        await asyncio.wait_for(asyncio.shield(handling), 0.05)
    finally:
        http.release_events.set()
        await handling

    await core.flush_events()

    # Assert
    assert called == ['customer']
    assert any(url.endswith('/events') for _method, url, _body in http.calls)


@pytest.mark.parametrize('adapter_type', [AiogramAdapter, PythonTelegramBotAdapter])
async def test_adapters_share_matched_and_unmatched_routing(adapter_type: type[AiogramAdapter | PythonTelegramBotAdapter]) -> None:
    # Arrange
    http = FakeHttp()
    adapter = adapter_type(FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http))
    called: list[str] = []
    await adapter.ready()

    async def customer(_update: object, _context: object, *_extra: object) -> None:
        called.append('customer')

    # Act / Assert: manifest-matched proxy update is consumed.
    if isinstance(adapter, PythonTelegramBotAdapter):
        assert await adapter.process_update(FakeUpdate(update('/start')), object(), customer)
        assert not await adapter.process_update(FakeUpdate(update('plain')), object(), customer)
    else:
        assert await adapter.handle_update(FakeUpdate(update('/start')), lambda current, context: customer(current, context))
        assert not await adapter.handle_update(FakeUpdate(update('plain')), lambda current, context: customer(current, context))
    assert called == ['customer']


async def test_privacy_transform_fail_closed_and_context_events() -> None:
    # Arrange
    errors: list[Exception] = []
    http = FakeHttp()

    async def broken_transform(_context: object) -> str:
        await asyncio.sleep(0.02)
        return 'never'

    core = FlowCastleCore(FlowCastleOptions('key', privacy=PrivacyOptions((), 'full', broken_transform, 1), runtime_enabled=True, on_error=errors.append), http)
    adapter = AiogramAdapter(core)
    received: list[object] = []

    async def customer(_update: object, context: object) -> None:
        received.append(context)

    # Act
    await adapter.handle_update(FakeUpdate(update('secret')), customer)
    context = received[0]
    await context.goal('signup', {'source': 'test'})  # type: ignore[attr-defined]
    await context.identify({'tier': 'free'})  # type: ignore[attr-defined]
    await context.request_live_agent('n' * 600)  # type: ignore[attr-defined]
    result = await context.run_flow('manual')  # type: ignore[attr-defined]
    await core.flush_events()

    # Assert
    events = [event for _method, url, body in http.calls if url.endswith('/events') and body for event in body['events']]
    update_event = next(event for event in events if event['type'] == 'update')
    assert 'text' not in update_event['update']['message']
    assert errors
    assert result['executionId'] == 'run-1'
    live = next(event for event in events if event['type'] == 'live_agent_request')
    assert len(live['note']) == 500


async def test_empty_privacy_mapping_uses_documented_privacy_first_defaults() -> None:
    http = FakeHttp()
    core = FlowCastleCore(FlowCastleOptions('key', privacy={}), http)

    await core.process(update('/help secret'))
    await core.flush_events()

    body = next(body for _method, url, body in http.calls if url.endswith('/events'))
    message = body['events'][0]['update']['message']
    assert message['text'] == '/help'
    assert 'first_name' not in message['from']


async def test_canonical_job_dispatch_ack_and_lifecycle_refusal() -> None:
    # Arrange
    http = FakeHttp()
    http.jobs = [
        {'protocolVersion': 2, 'id': 'one', 'leaseToken': 'lease', 'kind': 'transport_call', 'transport': 'telegram', 'operation': 'sendMessage', 'params': {'chat_id': 4, 'text': 'hello'}},
        {'protocolVersion': 2, 'id': 'two', 'leaseToken': 'lease2', 'kind': 'transport_call', 'transport': 'telegram', 'operation': 'setWebhook', 'params': {}},
        {'protocolVersion': 2, 'id': 'three', 'leaseToken': 'lease3', 'kind': 'control', 'transport': 'telegram', 'operation': 'session_state', 'params': {'conversationKey': '4:7', 'active': True, 'generation': 1}},
    ]
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    bot = FakeBot()

    # Act
    acks = await core.poll_and_dispatch(bot, RuntimeJobExecutor())

    # Assert
    assert bot.sent == ['hello']
    assert [ack.ok for ack in acks] == [True, False, True]
    ack_body = next(body for method, url, body in http.calls if url.endswith('/jobs/ack'))
    assert ack_body['results'][1]['error']['code'] == 400
    assert core.claims.get('4:7') is not None


async def test_protocol_v2_job_without_a_lease_is_ignored_before_dispatch() -> None:
    http = FakeHttp()
    http.jobs = [{
        'protocolVersion': 2,
        'id': 'unleased',
        'kind': 'transport_call',
        'transport': 'telegram',
        'operation': 'sendMessage',
        'params': {'chat_id': 4, 'text': 'must not send'},
    }]
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    bot = FakeBot()

    acks = await core.poll_and_dispatch(bot)

    assert acks == []
    assert bot.sent == []
    assert not any(url.endswith('/jobs/ack') for _method, url, _body in http.calls)


async def test_failed_matched_update_is_retried_by_background_transport() -> None:
    # Arrange
    http = FakeHttp()
    http.fail_events = True
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    await core.ready()

    # Act
    matched, _context = await core.process(update('/start'))
    http.fail_events = False
    await core.flush_runtime_spool()

    # Assert
    delivered = [body for method, url, body in http.calls if url.endswith('/events') and body]
    assert matched
    assert len(delivered) == 2  # one failed HTTP attempt and one replay
    assert delivered[0] == delivered[1]
    assert delivered[1]['events'][0]['handled'] is True


async def test_context_telemetry_is_fire_and_forget() -> None:
    # Arrange
    http = BlockingEventHttp()
    core = FlowCastleCore(FlowCastleOptions('key'), http)
    _handled, context = await core.process(update('plain'))
    assert context is not None

    # Act
    await asyncio.wait_for(context.goal('signup'), 0.05)
    await asyncio.wait_for(context.identify({'tier': 'free'}), 0.05)
    await asyncio.wait_for(context.request_live_agent('n' * 600), 0.05)
    http.release_events.set()
    await core.flush_events()

    # Assert
    events = [event for _method, url, body in http.calls if url.endswith('/events') and body for event in body['events']]
    assert [event['type'] for event in events] == ['update', 'goal', 'identify', 'live_agent_request']
    assert len(events[-1]['note']) == 500


async def test_background_transport_batches_and_caps_requests_at_fifty_events() -> None:
    # Arrange
    http = FakeHttp()
    core = FlowCastleCore(FlowCastleOptions('key'), http)

    # Act
    for index in range(51):
        core.enqueue_event({'type': 'goal', 'key': str(index)})
    await core.flush_events()

    # Assert
    batches = [body['events'] for _method, url, body in http.calls if url.endswith('/events') and body]
    assert [len(batch) for batch in batches] == [50, 1]
    assert [event['key'] for batch in batches for event in batch] == [str(index) for index in range(51)]


async def test_background_transport_drops_oldest_event_at_capacity() -> None:
    # Arrange
    errors: list[Exception] = []
    http = FakeHttp()
    core = FlowCastleCore(FlowCastleOptions('key', on_error=errors.append), http)

    # Act
    for index in range(501):
        core.enqueue_event({'type': 'goal', 'key': str(index)})
    await core.flush_events()

    # Assert
    events = [event for _method, url, body in http.calls if url.endswith('/events') and body for event in body['events']]
    assert len(events) == 500
    assert events[0]['key'] == '1'
    assert events[-1]['key'] == '500'
    assert any('dropped 1 buffered event' in str(error) for error in errors)


@pytest.mark.parametrize('first_failure', [OSError('offline'), 503])
async def test_background_transport_retries_one_transient_failure(first_failure: int | Exception) -> None:
    # Arrange
    http = SequencedEventHttp([first_failure, 202])
    core = FlowCastleCore(FlowCastleOptions('key'), http)
    core.enqueue_event({'type': 'goal', 'key': 'retry'})

    # Act
    await core.flush_events()

    # Assert
    calls = [body for _method, url, body in http.calls if url.endswith('/events')]
    assert len(calls) == 2
    assert calls[0] == calls[1]


async def test_background_transport_drops_after_two_transient_failures() -> None:
    # Arrange
    errors: list[Exception] = []
    http = SequencedEventHttp([503, 503, 202])
    core = FlowCastleCore(FlowCastleOptions('key', on_error=errors.append), http)
    core.enqueue_event({'type': 'goal', 'key': 'drop-after-retry'})

    # Act
    await core.flush_events()
    await core.flush_events()

    # Assert
    assert len([url for _method, url, _body in http.calls if url.endswith('/events')]) == 2
    assert any('ingest failed (503), dropping batch' in str(error) for error in errors)


async def test_background_transport_drops_non_retryable_response() -> None:
    # Arrange
    errors: list[Exception] = []
    http = SequencedEventHttp([401, 202])
    core = FlowCastleCore(FlowCastleOptions('key', on_error=errors.append), http)
    core.enqueue_event({'type': 'goal', 'key': 'unauthorized'})

    # Act
    await core.flush_events()

    # Assert
    assert len([url for _method, url, _body in http.calls if url.endswith('/events')]) == 1
    assert any('rejected api_key (401)' in str(error) for error in errors)


async def test_background_transport_silently_drops_other_client_errors_like_node() -> None:
    # Arrange
    errors: list[Exception] = []
    http = SequencedEventHttp([422, 202])
    core = FlowCastleCore(FlowCastleOptions('key', on_error=errors.append), http)
    core.enqueue_event({'type': 'goal', 'key': 'invalid'})

    # Act
    await core.flush_events()

    # Assert
    assert len([url for _method, url, _body in http.calls if url.endswith('/events')]) == 1
    assert errors == []


async def test_background_transport_serializes_flushes_while_events_arrive() -> None:
    # Arrange
    http = BlockingEventHttp()
    core = FlowCastleCore(FlowCastleOptions('key'), http)
    for index in range(20):
        core.enqueue_event({'type': 'goal', 'key': str(index)})
    await asyncio.wait_for(http.events_started.wait(), 0.1)

    # Act
    core.enqueue_event({'type': 'goal', 'key': '20'})
    flushing = asyncio.create_task(core.flush_events())
    http.release_events.set()
    await flushing

    # Assert
    events = [event for _method, url, body in http.calls if url.endswith('/events') and body for event in body['events']]
    assert http.max_active_event_requests == 1
    assert [event['key'] for event in events] == [str(index) for index in range(21)]


async def test_matched_update_still_awaits_required_ingest() -> None:
    # Arrange
    http = BlockingEventHttp()
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    adapter = AiogramAdapter(core)
    called: list[str] = []
    await adapter.ready()

    async def customer(_update: object, _context: object) -> None:
        called.append('customer')

    # Act
    handling = asyncio.create_task(adapter.handle_update(FakeUpdate(update('/start')), customer))
    await asyncio.wait_for(http.events_started.wait(), 0.1)

    # Assert
    assert not handling.done()
    assert called == []

    http.release_events.set()
    assert await handling
    await core.stop()


async def test_stop_flushes_observed_events_below_the_eager_threshold() -> None:
    # Arrange
    http = FakeHttp()
    core = FlowCastleCore(FlowCastleOptions('key'), http)
    await core.process(update('plain'))

    # Act
    await core.stop()

    # Assert
    events = [event for _method, url, body in http.calls if url.endswith('/events') and body for event in body['events']]
    assert [event['type'] for event in events] == ['update']


async def test_stop_bounds_slow_shutdown_flush() -> None:
    # Arrange
    errors: list[Exception] = []
    http = BlockingEventHttp()
    core = FlowCastleCore(FlowCastleOptions('key', on_error=errors.append, shutdown_flush_timeout_ms=10), http)
    await core.process(update('plain'))

    # Act
    await asyncio.wait_for(core.stop(), 0.1)
    http.release_events.set()
    await core.start(FakeBot())
    await core.flush_events()

    # Assert
    assert any('timed out flushing events during shutdown' in str(error) for error in errors)
    events = [event for _method, url, body in http.calls if url.endswith('/events') and body for event in body['events']]
    assert [event['type'] for event in events] == ['update']


async def test_started_runtime_refreshes_and_delivers_jobs_in_the_background() -> None:
    # Arrange
    http = FakeHttp()
    http.jobs = [{
        'protocolVersion': 2,
        'id': 'background-job',
        'leaseToken': 'background-lease',
        'kind': 'transport_call',
        'transport': 'telegram',
        'operation': 'sendMessage',
        'params': {'chat_id': 4, 'text': 'background'},
    }]
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    bot = FakeBot()

    # Act
    await core.ready()
    await core.start(bot)
    await asyncio.sleep(0.05)
    await core.stop()

    # Assert
    assert bot.sent == ['background']
    assert any(url.endswith('/heartbeat') for _method, url, _body in http.calls)
    ack = next(body for _method, url, body in http.calls if url.endswith('/jobs/ack'))
    assert ack['results'][0]['leaseToken'] == 'background-lease'


async def test_protocol_v2_conformance_fixture_routes_and_refuses_jobs() -> None:
    fixture_path = Path(__file__).parents[2] / 'sdk-conformance' / 'fixtures' / 'protocol-v2.json'
    if not fixture_path.exists():
        pytest.skip('cross-language fixture is not present')
    fixture = json.loads(fixture_path.read_text())
    http = FakeHttp()
    manifest = fixture.get('manifest') or fixture.get('runtimeManifest')
    if not isinstance(manifest, dict):
        pytest.skip('fixture does not expose a manifest case')
    http.manifest = manifest
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    await core.ready()
    cases = fixture.get('routingCases', fixture.get('manifestCases', []))
    for case in cases:
        if isinstance(case, dict) and isinstance(case.get('update'), dict) and isinstance(case.get('matched'), bool):
            source = case['update']
            assert core.matches(RuntimeUpdate(
                raw=source.get('raw', {}), chat_id=source.get('chatId'), actor_id=source.get('actorId'),
                chat_type=source.get('chatType'), command=source.get('command'), text=source.get('text'),
                callback_data=source.get('callbackData'), addressed=bool(source.get('addressed')),
            )) is case['matched']
    for job in fixture.get('jobsResponse', {}).get('jobs', []):
        if isinstance(job, dict) and job.get('operation') in {'setWebhook', 'getUpdates', 'deleteWebhook'}:
            parsed = core._job(job)
            assert parsed is not None
            ack = await RuntimeJobExecutor().execute(FakeBot(), parsed, core.claims)
            assert not ack.ok


async def test_group_replies_and_mentions_are_addressed_like_node_adapters() -> None:
    http = FakeHttp()
    http.manifest = {
        'protocolVersion': 2,
        'version': 'addressed-v1',
        'rules': [{
            'id': 'addressed',
            'flowId': 'support',
            'kind': 'message',
            'visibility': 'addressed',
            'chatTypes': ['supergroup'],
        }],
    }
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    adapter = AiogramAdapter(core, {'id': 42, 'username': 'test_bot'})
    await adapter.ready()
    group = update('hello @test_bot')
    group['message']['chat'] = {'id': -100, 'type': 'supergroup'}
    reply = update('reply')
    reply['message']['chat'] = {'id': -100, 'type': 'supergroup'}
    reply['message']['reply_to_message'] = {'message_id': 1, 'from': {'id': 42, 'is_bot': True}}

    mention_handled, _ = await core.process(group, adapter.identity)
    reply_handled, _ = await core.process(reply, adapter.identity)

    assert mention_handled
    assert reply_handled


@pytest.mark.parametrize('adapter_type', [AiogramAdapter, PythonTelegramBotAdapter])
async def test_framework_job_executors_decode_safe_inline_file_markers(
    adapter_type: type[AiogramAdapter | PythonTelegramBotAdapter],
) -> None:
    # Arrange
    adapter = adapter_type(FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), FakeHttp()))
    bot = FakeMediaBot()
    job = RuntimeJob(
        id='photo-job',
        lease_token='photo-lease',
        kind='transport_call',
        operation='sendPhoto',
        params={
            'chat_id': 4,
            'photo': {
                '$flowcastleFile': {
                    'filename': 'hello.txt',
                    'contentType': 'text/plain',
                    'base64': 'aGVsbG8=',
                },
            },
        },
    )

    # Act
    await adapter.start(bot)
    executor = adapter.core._executor
    await adapter.stop()
    assert executor is not None
    ack = await executor.execute(bot, job, adapter.core.claims)

    # Assert
    assert ack.ok
    assert ack.lease_token == 'photo-lease'
    if isinstance(adapter, AiogramAdapter):
        assert getattr(bot.photo, 'filename', None) == 'hello.txt'
        assert getattr(bot.photo, 'data', None) == b'hello'
    else:
        assert getattr(bot.photo, 'name', None) == 'hello.txt'
        assert bot.photo is not None
        assert bot.photo.read() == b'hello'  # type: ignore[attr-defined]


async def test_invalid_inline_file_marker_is_refused_before_the_bot_call() -> None:
    bot = FakeMediaBot()
    job = RuntimeJob(
        id='bad-photo',
        kind='transport_call',
        operation='sendPhoto',
        params={'chat_id': 4, 'photo': {'$flowcastleFile': {'filename': 'bad.txt', 'base64': 'not-base64'}}},
    )

    ack = await RuntimeJobExecutor().execute(bot, job, FlowCastleCore(FlowCastleOptions('key'), FakeHttp()).claims)

    assert not ack.ok
    assert bot.photo is None
    assert ack.error == {'description': 'FlowCastle: invalid base64 file marker'}
