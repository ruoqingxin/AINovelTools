# -*- coding: utf-8 -*-
"""统一管理后台任务、取消令牌和任务互斥。"""
from __future__ import annotations

import threading
import time
import logging
from dataclasses import dataclass
from typing import Callable, Any


class TaskAlreadyRunning(RuntimeError):
    """已有后台任务运行时拒绝启动第二个任务。"""


class TaskCancelled(RuntimeError):
    """后台任务收到取消请求。"""


@dataclass
class TaskHandle:
    task_id: str
    cancel_event: threading.Event
    thread: threading.Thread


class TaskController:
    """单进程单任务控制器；worker 不应直接操作 Tk 控件。"""

    def __init__(self, main_window=None):
        self._main_window = main_window
        self._lock = threading.RLock()
        self._active: TaskHandle | None = None

    @property
    def active_task(self) -> TaskHandle | None:
        with self._lock:
            return self._active

    def is_running(self) -> bool:
        active = self.active_task
        return active is not None and active.thread.is_alive()

    def run(
        self,
        task_id: str,
        worker: Callable[[threading.Event], Any],
        button=None,
        cancellable: bool = True,
        on_success: Callable[[Any], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
        on_finally: Callable[[], None] | None = None,
    ) -> TaskHandle:
        with self._lock:
            if self.is_running():
                raise TaskAlreadyRunning("已有后台任务正在运行")
            cancel_event = threading.Event()
            context = self._log_context(task_id)

            def invoke_callback(callback, *args):
                if callback is None:
                    return
                if self._main_window is not None:
                    self._main_window.master.after(0, lambda: callback(*args))
                else:
                    callback(*args)

            def target():
                result = None
                logging.info("task_started %s", context)
                try:
                    result = worker(cancel_event)
                    if cancellable and cancel_event.is_set():
                        raise TaskCancelled(task_id)
                    logging.info("task_completed %s", context)
                    invoke_callback(on_success, result)
                except TaskCancelled as exc:
                    logging.info("task_cancelled %s", context)
                    invoke_callback(on_error, exc)
                except Exception as exc:
                    logging.error("task_failed %s error_type=%s", context, type(exc).__name__)
                    invoke_callback(on_error, exc)
                finally:
                    with self._lock:
                        if self._active is handle:
                            self._active = None
                    invoke_callback(on_finally)

            if button is not None and self._main_window is not None:
                self._main_window.disable_button_safe(button)
            thread = threading.Thread(target=target, name=f"task:{task_id}", daemon=True)
            handle = TaskHandle(task_id=task_id, cancel_event=cancel_event, thread=thread)
            self._active = handle
            thread.start()
            return handle

    def _log_context(self, task_id: str) -> str:
        project_id, chapter = "none", "none"
        window = self._main_window
        if window is not None:
            manager = getattr(window, "project_manager", None)
            project = getattr(manager, "project", None) or {}
            project_id = str(project.get("name") or "none")
            chapter_var = getattr(window, "chapter_num_var", None)
            if chapter_var is not None:
                try:
                    chapter = str(chapter_var.get())
                except Exception:
                    chapter = "none"
        return f"task_id={task_id} project_id={project_id} chapter={chapter}"

    def cancel(self, task_id: str | None = None) -> bool:
        active = self.active_task
        if active is None or (task_id is not None and active.task_id != task_id):
            return False
        active.cancel_event.set()
        return True

    def wait_for_idle(self, timeout: float | None = None) -> bool:
        started = time.monotonic()
        while self.is_running():
            if timeout is not None and time.monotonic() - started >= timeout:
                return False
            time.sleep(0.01)
        return True
