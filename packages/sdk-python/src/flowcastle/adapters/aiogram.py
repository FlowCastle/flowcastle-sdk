"""aiogram 3.x adapter, deliberately importable without aiogram installed."""

from __future__ import annotations

from typing import Awaitable, Callable

from ..core import RuntimeJobExecutor
from .base import TelegramAdapter


class AiogramAdapter(TelegramAdapter):
    framework = 'aiogram'

    async def start(self, bot: object, executor: RuntimeJobExecutor | None = None) -> None:
        await super().start(bot, executor or self._executor())

    def middleware(self) -> Callable[[Callable[..., Awaitable[object]], object, dict[str, object]], Awaitable[object]]:
        """Return an aiogram BaseMiddleware-compatible callable without a hard import."""
        async def invoke(handler: Callable[..., Awaitable[object]], event: object, data: dict[str, object]) -> object:
            bot = data.get('bot')
            if bot is not None:
                await self.start(bot)
            async def next_handler(update: object, context: object) -> object:
                data['flowcastle'] = context
                return await handler(update, data)
            consumed = await self.handle_update(event, next_handler)
            return None if consumed else None
        return invoke

    def install(self, dispatcher: object) -> None:
        """Convenience registration for a real aiogram Dispatcher."""
        update = getattr(dispatcher, 'update', None)
        outer_middleware = getattr(update, 'outer_middleware', None)
        if not callable(outer_middleware):
            raise TypeError('AiogramAdapter.install() requires an aiogram 3 Dispatcher')
        outer_middleware(self.middleware())

    def _executor(self) -> RuntimeJobExecutor:
        try:
            from aiogram.types import BufferedInputFile
        except ImportError as error:
            raise RuntimeError("Install flowcastle[aiogram] to execute aiogram runtime jobs") from error
        return RuntimeJobExecutor(lambda data, filename, _content_type: BufferedInputFile(data, filename))
