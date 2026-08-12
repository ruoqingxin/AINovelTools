"""Cooperative cancellation for AI requests and multi-stage AI operations."""
from __future__ import annotations

import contextvars
import queue
import threading
from typing import Callable, TypeVar


class OperationCancelled(BaseException):
    """Raised when the user cancels the active AI operation."""


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled:
            raise OperationCancelled("AI 操作已由用户中止")

    def wait(self, timeout: float) -> bool:
        return self._event.wait(timeout)


_current_token: contextvars.ContextVar[CancellationToken | None] = (
    contextvars.ContextVar("ai_cancellation_token", default=None)
)
T = TypeVar("T")


def set_current_token(token: CancellationToken):
    return _current_token.set(token)


def reset_current_token(context_token) -> None:
    _current_token.reset(context_token)


def get_current_token() -> CancellationToken | None:
    return _current_token.get()


def raise_if_cancelled() -> None:
    token = get_current_token()
    if token is not None:
        token.raise_if_cancelled()


def cancellable_sleep(seconds: float) -> None:
    token = get_current_token()
    if token is None:
        import time

        time.sleep(seconds)
        return
    if token.wait(seconds):
        token.raise_if_cancelled()


def run_cancellable_request(func: Callable[[], T]) -> T:
    """Return promptly on cancellation even when an SDK call cannot be interrupted."""
    token = get_current_token()
    if token is None:
        return func()
    token.raise_if_cancelled()

    result_queue: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)

    def request_worker() -> None:
        try:
            result_queue.put((True, func()))
        except BaseException as exc:
            result_queue.put((False, exc))

    threading.Thread(
        target=request_worker,
        daemon=True,
        name="ai-novel-sdk-request",
    ).start()

    while True:
        token.raise_if_cancelled()
        try:
            succeeded, value = result_queue.get(timeout=0.1)
            break
        except queue.Empty:
            continue

    token.raise_if_cancelled()
    if succeeded:
        return value  # type: ignore[return-value]
    raise value  # type: ignore[misc]


class CancellableAdapter:
    """Apply cancellation to both text-generation and embedding adapter calls."""

    def __init__(self, adapter) -> None:
        self._adapter = adapter

    def __getattr__(self, name):
        attribute = getattr(self._adapter, name)
        if name not in {"invoke", "embed_query", "embed_documents"} or not callable(attribute):
            return attribute
        return lambda *args, **kwargs: run_cancellable_request(
            lambda: attribute(*args, **kwargs)
        )
