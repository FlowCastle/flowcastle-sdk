"""Shared adapter mechanics; framework modules remain optional."""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable, Mapping

from ..core import FlowCastleContext, FlowCastleCore, RuntimeJobExecutor
from ..types import JsonObject, object_value

NextHandler = Callable[[object, FlowCastleContext], Awaitable[object] | object]


def update_to_json(update: object) -> JsonObject:
    """Support aiogram/PTB objects and tiny fakes without importing either SDK."""
    candidate: Any = update
    for name in ('model_dump', 'to_dict'):
        converter = getattr(update, name, None)
        if callable(converter):
            candidate = converter()
            break
    if not isinstance(candidate, dict):
        raise TypeError('FlowCastle adapter requires a serializable Telegram update')
    result = object_value(candidate)
    if result is None:
        raise TypeError('FlowCastle adapter update contains a non-JSON value')
    return result


class TelegramAdapter:
    framework = 'telegram'

    def __init__(self, core: FlowCastleCore, identity: Mapping[str, str | int] | None = None) -> None:
        self.core = core
        self.identity = identity

    async def ready(self) -> None:
        await self.core.ready()

    async def start(self, bot: object, executor: RuntimeJobExecutor | None = None) -> None:
        await self.core.start(bot, executor)

    async def stop(self) -> None:
        await self.core.stop()

    async def handle_update(self, update: object, next_handler: NextHandler) -> bool:
        """Consume proxy-owned updates; call customer code only for unmatched updates."""
        handled, context = await self.core.process(update_to_json(update), self.identity)
        if handled:
            return True
        assert context is not None
        result = next_handler(update, context)
        if inspect.isawaitable(result):
            await result
        return False
