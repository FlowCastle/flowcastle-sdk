from __future__ import annotations

import asyncio
import json
from pathlib import Path
import time
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

    # Assert
    update_event = next(body['events'][0] for method, url, body in http.calls if url.endswith('/events') and body and body['events'][0]['type'] == 'update')
    assert 'text' not in update_event['update']['message']
    assert errors
    assert result['executionId'] == 'run-1'
    live = next(body['events'][0] for method, url, body in http.calls if url.endswith('/events') and body and body['events'][0]['type'] == 'live_agent_request')
    assert len(live['note']) == 500


async def test_empty_privacy_mapping_uses_documented_privacy_first_defaults() -> None:
    http = FakeHttp()
    core = FlowCastleCore(FlowCastleOptions('key', privacy={}), http)

    await core.process(update('/help secret'))

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


async def test_matched_update_is_spooled_and_replayed_after_an_outage() -> None:
    # Arrange
    http = FakeHttp()
    http.fail_events = True
    core = FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), http)
    await core.ready()

    # Act
    matched, _context = await core.process(update('/start'))
    http.fail_events = False
    await core.flush_spool()

    # Assert
    delivered = [body for method, url, body in http.calls if url.endswith('/events') and body]
    assert matched
    assert len(delivered) == 2  # one failed HTTP attempt and one replay
    assert delivered[0] == delivered[1]
    assert delivered[1]['events'][0]['handled'] is True


async def test_outage_spool_drops_events_after_the_five_minute_boundary() -> None:
    errors: list[Exception] = []
    http = FakeHttp()
    core = FlowCastleCore(FlowCastleOptions('key', on_error=errors.append), http)
    core._spool.append((time.monotonic() - 301, {'type': 'goal', 'key': 'expired'}))

    await core.flush_spool()

    assert not any(url.endswith('/events') for _method, url, _body in http.calls)
    assert any('expired runtime event' in str(error) for error in errors)


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
