"""python-telegram-bot 21+ adapter, with no import-time PTB dependency."""

from __future__ import annotations

import importlib
import io
from typing import Awaitable, Callable

from ..core import RuntimeJobExecutor
from .base import TelegramAdapter, update_to_json


class PythonTelegramBotAdapter(TelegramAdapter):
    framework = 'python-telegram-bot'

    async def start(self, bot: object, executor: RuntimeJobExecutor | None = None) -> None:
        await super().start(bot, executor or self._executor())

    async def process_update(self, update: object, application: object, customer_handler: Callable[[object, object, object], Awaitable[object]]) -> bool:
        async def next_handler(current: object, context: object) -> object:
            return await customer_handler(current, context, application)
        return await self.handle_update(update, next_handler)

    def install(self, application: object, group: int = -100) -> None:
        """Install an early PTB handler that consumes only FlowCastle-owned updates.

        Unmatched updates continue through the application's normal handler
        groups with ``context.flowcastle`` attached. Matched updates raise PTB's
        native ``ApplicationHandlerStop`` so no customer handler can double reply.
        """
        try:
            telegram_ext = importlib.import_module('telegram.ext')
        except ImportError as error:
            raise RuntimeError("Install flowcastle[python-telegram-bot] to use install()") from error

        handler_stop = getattr(telegram_ext, 'ApplicationHandlerStop')

        async def callback(update: object, context: object) -> None:
            bot = getattr(context, 'bot', None)
            if bot is not None:
                await self.start(bot)
            handled, flowcastle_context = await self.core.process(
                update_to_json(update),
                self.identity,
            )
            if handled:
                raise handler_stop()
            setattr(context, 'flowcastle', flowcastle_context)

        add_handler = getattr(application, 'add_handler', None)
        if not callable(add_handler):
            raise TypeError('PythonTelegramBotAdapter.install() requires a PTB Application')
        type_handler = getattr(telegram_ext, 'TypeHandler')
        update_type = getattr(importlib.import_module('telegram'), 'Update')
        add_handler(type_handler(update_type, callback), group=group)

    def _executor(self) -> RuntimeJobExecutor:
        def decode(data: bytes, filename: str, _content_type: str | None) -> object:
            stream = io.BytesIO(data)
            stream.name = filename
            return stream
        return RuntimeJobExecutor(decode)
