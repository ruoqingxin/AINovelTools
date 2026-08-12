#novel_generator/common.py
# -*- coding: utf-8 -*-
"""
通用重试、清洗、日志工具
"""
import logging
import os
import re
import random
import time
from ai_cancellation import cancellable_sleep, get_current_token, raise_if_cancelled


def _retry_delay(base_delay: float, attempt: int, max_delay: float) -> float:
    exponential_delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
    return exponential_delay * random.uniform(0.85, 1.15)


def _sleep_before_retry(delay: float) -> None:
    if get_current_token() is None:
        time.sleep(delay)
    else:
        cancellable_sleep(delay)


def call_with_retry(
    func,
    max_retries=3,
    sleep_time=2,
    fallback_return=None,
    max_sleep_time=15,
    **kwargs,
):
    """
    通用的重试机制封装。
    :param func: 要执行的函数
    :param max_retries: 最大重试次数
    :param sleep_time: 重试前的等待秒数
    :param fallback_return: 如果多次重试仍失败时的返回值
    :param kwargs: 传给func的命名参数
    :return: func的结果，若失败则返回 fallback_return
    """
    for attempt in range(1, max_retries + 1):
        raise_if_cancelled()
        try:
            return func(**kwargs)
        except Exception as exc:
            logging.warning(
                "[call_with_retry] Attempt %s/%s failed: %s",
                attempt,
                max_retries,
                exc,
                exc_info=True,
            )
            if attempt < max_retries:
                delay = _retry_delay(sleep_time, attempt, max_sleep_time)
                logging.info("Retrying in %.2f seconds", delay)
                _sleep_before_retry(delay)
            else:
                logging.error("Max retries reached, returning fallback_return.")
                return fallback_return

def remove_think_tags(text: str) -> str:
    """移除完整或未闭合的模型思考标签。"""
    cleaned = re.sub(
        r"<think>.*?</think>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return re.sub(r"<think>.*$", "", cleaned, flags=re.DOTALL | re.IGNORECASE)


def normalize_llm_text(content) -> str:
    """Normalize string and block-based SDK responses into plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        return "".join(normalize_llm_text(item) for item in content)
    if isinstance(content, dict):
        for key in ("text", "content", "output_text"):
            if key in content:
                return normalize_llm_text(content[key])
        return ""
    for attribute in ("text", "content", "output_text"):
        if hasattr(content, attribute):
            return normalize_llm_text(getattr(content, attribute))
    return str(content)


def strip_markdown_fence(text: str) -> str:
    """Remove a single outer Markdown code fence without leaving its language tag."""
    match = re.fullmatch(
        r"\s*```(?:[A-Za-z0-9_+.-]+)?[ \t]*\r?\n?(.*?)\r?\n?```\s*",
        text,
        flags=re.DOTALL,
    )
    return match.group(1).strip() if match else text.replace("```", "").strip()

def is_llm_io_debug_enabled() -> bool:
    return os.getenv("AI_NOVEL_DEBUG_LLM_IO", "").strip().lower() in {"1", "true", "yes", "on"}

def log_llm_io(label: str, content: str):
    """默认只记录长度，避免日志泄露完整提示词、正文或用户私有素材。"""
    content = content or ""
    if is_llm_io_debug_enabled():
        logging.info(
            f"\n[#########################################  {label}  #########################################]\n{content}\n"
        )
    else:
        logging.info("[LLM IO] %s length=%s", label, len(content))

def debug_log(prompt: str, response_content: str):
    log_llm_io("Prompt", prompt)
    log_llm_io("Response", response_content)

def invoke_with_cleaning(
    llm_adapter,
    prompt: str,
    max_retries: int = 3,
    retry_delay: float = 1.0,
    max_retry_delay: float = 8.0,
) -> str:
    """调用 LLM 并清理返回结果"""
    log_llm_io("Prompt", prompt)

    retry_count = 0

    while retry_count < max_retries:
        raise_if_cancelled()
        try:
            result = normalize_llm_text(llm_adapter.invoke(prompt))
            log_llm_io("Response", result)

            # 清理结果中的特殊格式标记
            result = strip_markdown_fence(remove_think_tags(result))
            if result:
                return result
            retry_count += 1
            logging.warning(f"LLM 返回空内容，重试 ({retry_count}/{max_retries})")
        except Exception as exc:
            retry_count += 1
            logging.error(
                "调用失败 (%s/%s): %s",
                retry_count,
                max_retries,
                exc,
                exc_info=True,
            )
            if retry_count >= max_retries:
                raise

        if retry_count < max_retries and retry_delay > 0:
            delay = _retry_delay(retry_delay, retry_count, max_retry_delay)
            logging.info("LLM request retrying in %.2f seconds", delay)
            _sleep_before_retry(delay)

    raise RuntimeError(f"LLM 在 {max_retries} 次重试后仍返回空内容")
