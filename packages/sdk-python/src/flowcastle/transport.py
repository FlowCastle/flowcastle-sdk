"""Bounded, best-effort background delivery for observed SDK events."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable

from .types import JsonObject

EventBatchSender = Callable[[list[JsonObject]], Awaitable[None]]
ErrorReporter = Callable[[Exception], None]

BUFFER_CAPACITY = 500
MAX_EVENTS_PER_REQUEST = 50


class EventTransport:
    """Keep FlowCastle telemetry networking outside customer handler latency."""

    def __init__(
        self,
        sender: EventBatchSender,
        on_error: ErrorReporter,
        flush_interval_ms: int = 3000,
        max_batch_size: int = 20,
    ) -> None:
        self._sender = sender
        self._on_error = on_error
        self._flush_interval_seconds = max(1, flush_interval_ms) / 1000
        self._eager_batch_size = max(1, min(MAX_EVENTS_PER_REQUEST, max_batch_size))
        self._buffer: deque[JsonObject] = deque()
        self._dropped_since_flush = 0
        self._wake = asyncio.Event()
        self._flush_lock = asyncio.Lock()
        self._worker: asyncio.Task[None] | None = None
        self._stopping = False

    def start(self) -> None:
        self._stopping = False
        if self._buffer:
            self._ensure_worker()

    def enqueue(self, event: JsonObject) -> None:
        if self._stopping:
            self._report(RuntimeError('FlowCastle: dropped event after transport shutdown started'))
            return
        if len(self._buffer) >= BUFFER_CAPACITY:
            self._buffer.popleft()
            self._dropped_since_flush += 1
        self._buffer.append(event)
        self._ensure_worker()
        self._wake.set()

    async def flush(self) -> None:
        """Deliver everything currently buffered without leaking delivery errors."""
        async with self._flush_lock:
            self._report_dropped()
            while self._buffer:
                batch = [self._buffer.popleft() for _ in range(min(len(self._buffer), MAX_EVENTS_PER_REQUEST))]
                try:
                    await self._sender(batch)
                except asyncio.CancelledError:
                    self._restore_front(batch)
                    raise
                except Exception as error:
                    self._report(error)

    async def stop(self, timeout_ms: int = 2000) -> None:
        """Bound shutdown latency, then cancel the idle/background worker."""
        self._stopping = True
        self._wake.set()
        try:
            await asyncio.wait_for(self.flush(), max(1, timeout_ms) / 1000)
        except asyncio.TimeoutError:
            self._report(RuntimeError('FlowCastle: timed out flushing events during shutdown'))

        worker = self._worker
        if worker is not None and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        self._worker = None
        self._wake.clear()

    def _ensure_worker(self) -> None:
        if self._stopping or (self._worker is not None and not self._worker.done()):
            return
        self._worker = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            while not self._stopping:
                if not await self._wait_until_flush_due():
                    return
                await self.flush()
                if not self._buffer:
                    return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._report(error)

    async def _wait_until_flush_due(self) -> bool:
        while not self._buffer and not self._stopping:
            self._wake.clear()
            await self._wake.wait()
        if self._stopping:
            return False

        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._flush_interval_seconds
        while len(self._buffer) < self._eager_batch_size and not self._stopping:
            self._wake.clear()
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(self._wake.wait(), remaining)
            except asyncio.TimeoutError:
                break
        return not self._stopping and bool(self._buffer)

    def _restore_front(self, batch: list[JsonObject]) -> None:
        for event in reversed(batch):
            self._buffer.appendleft(event)
        while len(self._buffer) > BUFFER_CAPACITY:
            self._buffer.popleft()
            self._dropped_since_flush += 1

    def _report_dropped(self) -> None:
        if self._dropped_since_flush == 0:
            return
        dropped = self._dropped_since_flush
        self._dropped_since_flush = 0
        self._report(RuntimeError(f'FlowCastle: dropped {dropped} buffered event(s) (buffer full)'))

    def _report(self, error: Exception) -> None:
        try:
            self._on_error(error)
        except Exception:
            pass
