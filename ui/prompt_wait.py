# -*- coding: utf-8 -*-
"""可取消的 UI 等待辅助函数。"""
import threading


class PromptWaitCancelled(Exception):
    """用户或全局任务取消了 Prompt 确认等待。"""


def wait_for_prompt_result(event: threading.Event,
                           cancel_event: threading.Event | None = None,
                           poll_interval: float = 0.1) -> None:
    """等待 Prompt 对话框完成，同时及时响应全局取消。"""
    while not event.wait(poll_interval):
        if cancel_event is not None and cancel_event.is_set():
            raise PromptWaitCancelled()
