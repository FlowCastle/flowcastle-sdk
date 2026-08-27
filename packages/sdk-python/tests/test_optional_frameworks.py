"""No-network smoke tests against real optional framework update models."""

from __future__ import annotations

import pytest

from flowcastle import FlowCastleCore, FlowCastleOptions
from flowcastle.adapters.aiogram import AiogramAdapter
from flowcastle.adapters.python_telegram_bot import PythonTelegramBotAdapter

from test_sdk import FakeHttp, update


async def test_aiogram_middleware_invokes_real_handler_only_when_unmatched() -> None:
    aiogram = pytest.importorskip('aiogram')
    adapter = AiogramAdapter(FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), FakeHttp()))
    await adapter.ready()
    seen: list[str] = []

    async def handler(_event: object, data: dict[str, object]) -> str:
        assert 'flowcastle' in data
        seen.append('handler')
        return 'handled'

    middleware = adapter.middleware()
    start = aiogram.types.Update.model_validate(update('/start'))
    plain = aiogram.types.Update.model_validate(update('plain'))
    assert await middleware(handler, start, {}) is None
    assert await middleware(handler, plain, {}) is None
    assert seen == ['handler']


async def test_ptb_process_update_with_real_update_model() -> None:
    telegram = pytest.importorskip('telegram')
    adapter = PythonTelegramBotAdapter(FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), FakeHttp()))
    await adapter.ready()
    seen: list[str] = []

    async def handler(_update: object, context: object, application: object) -> None:
        assert context is not None
        assert application == 'application'
        seen.append('handler')

    start = telegram.Update.de_json(update('/start'), None)
    plain = telegram.Update.de_json(update('plain'), None)
    assert await adapter.process_update(start, 'application', handler)
    assert not await adapter.process_update(plain, 'application', handler)
    assert seen == ['handler']


async def test_ptb_installer_consumes_matches_and_continues_unmatched_application_handlers() -> None:
    telegram = pytest.importorskip('telegram')
    telegram_ext = pytest.importorskip('telegram.ext')
    adapter = PythonTelegramBotAdapter(FlowCastleCore(FlowCastleOptions('key', runtime_enabled=True), FakeHttp()))
    await adapter.ready()
    application = telegram_ext.ApplicationBuilder().token('42:TEST').build()
    seen: list[str] = []

    async def customer_handler(_update: object, context: object) -> None:
        assert getattr(context, 'flowcastle', None) is not None
        seen.append('customer')

    adapter.install(application)
    application.add_handler(telegram_ext.TypeHandler(telegram.Update, customer_handler), group=0)
    setattr(application, '_initialized', True)

    await application.process_update(telegram.Update.de_json(update('/start'), application.bot))
    await application.process_update(telegram.Update.de_json(update('plain'), application.bot))

    assert seen == ['customer']
    await adapter.stop()
