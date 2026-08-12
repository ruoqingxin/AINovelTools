"""Cooperative cancellation for AI requests and multi-stage AI operations."""
from __future__ import annotations

import contextvars
import queue
import threading
import time
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
_progress_callback: contextvars.ContextVar[Callable[[str], None] | None] = (
    contextvars.ContextVar("ai_progress_callback", default=None)
)
T = TypeVar("T")


def set_current_token(token: CancellationToken):
    return _current_token.set(token)


def reset_current_token(context_token) -> None:
    _current_token.reset(context_token)


def set_progress_callback(callback: Callable[[str], None]):
    return _progress_callback.set(callback)


def reset_progress_callback(context_token) -> None:
    _progress_callback.reset(context_token)


def report_progress(message: str) -> None:
    callback = _progress_callback.get()
    if callback is not None:
        callback(message)


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


def run_cancellable_request(
    func: Callable[[], T],
    waiting_label: str = "AI",
    heartbeat_seconds: float = 10.0,
) -> T:
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

    started_at = time.monotonic()
    next_heartbeat = started_at + heartbeat_seconds
    while True:
        token.raise_if_cancelled()
        poll_timeout = 0.1
        if heartbeat_seconds > 0:
            poll_timeout = min(
                poll_timeout,
                max(0.001, next_heartbeat - time.monotonic()),
            )
        try:
            succeeded, value = result_queue.get(timeout=poll_timeout)
            break
        except queue.Empty:
            now = time.monotonic()
            if heartbeat_seconds > 0 and now >= next_heartbeat:
                elapsed = round(now - started_at)
                report_progress(f"[{waiting_label}] 仍在等待返回，已等待 {elapsed} 秒...")
                next_heartbeat = now + heartbeat_seconds
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

        def cancellable_call(*args, **kwargs):
            request_value = args[0] if args else kwargs.get(
                "prompt", kwargs.get("query", kwargs.get("texts", ""))
            )
            if name == "invoke":
                report_progress(f"[发送给 AI]\n{request_value}")
                label = "AI 请求"
            else:
                report_progress(f"[发送给 Embedding]\n{_format_embedding_input(request_value)}")
                label = "Embedding 请求"

            try:
                result = run_cancellable_request(
                    lambda: attribute(*args, **kwargs),
                    waiting_label=label,
                )
            except BaseException as exc:
                if not isinstance(exc, OperationCancelled):
                    report_progress(f"[{label}失败] {exc}")
                raise

            if name == "invoke":
                report_progress(f"[AI 返回]\n{result}")
            else:
                report_progress(f"[Embedding 返回] {_describe_embeddings(result)}")
            return result

        return cancellable_call


def _format_embedding_input(value) -> str:
    if isinstance(value, (list, tuple)):
        return "\n\n".join(f"#{index}\n{text}" for index, text in enumerate(value, 1))
    return str(value)


def _describe_embeddings(value) -> str:
    if not isinstance(value, (list, tuple)):
        return f"返回类型：{type(value).__name__}"
    if not value:
        return "未返回向量"
    if isinstance(value[0], (list, tuple)):
        dimensions = [len(vector) for vector in value]
        unique_dimensions = sorted(set(dimensions))
        dimension_text = "/".join(str(item) for item in unique_dimensions)
        return f"共 {len(value)} 个向量，维度：{dimension_text}"
    return f"共 1 个向量，维度：{len(value)}"
