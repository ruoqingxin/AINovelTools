# -*- coding: utf-8 -*-
"""集中构造任务所需的 LLM/Embedding 配置，兼容当前 config.json。"""
from __future__ import annotations


LLM_CALL_KEYS = (
    "interface_format",
    "api_key",
    "base_url",
    "model_name",
    "temperature",
    "max_tokens",
    "timeout",
)


def get_task_llm_config(config: dict, task_key: str, selected_name: str | None = None) -> dict:
    """按任务读取 LLM 预设；selected_name 为空时读取 choose_configs。"""
    llm_configs = config.get("llm_configs", {})
    name = selected_name or config.get("choose_configs", {}).get(task_key)
    if name not in llm_configs:
        raise KeyError(f"任务 {task_key} 指向不存在的 LLM 配置: {name}")
    return dict(llm_configs[name])


def llm_call_kwargs(config: dict) -> dict:
    """只返回 create_llm_adapter 所需字段，忽略 UI 或预设的额外字段。"""
    missing = [key for key in LLM_CALL_KEYS if key not in config]
    if missing:
        raise ValueError(f"LLM 配置缺少字段: {', '.join(missing)}")
    return {key: config[key] for key in LLM_CALL_KEYS}


def get_task_embedding_config(config: dict, selected_name: str | None = None) -> dict:
    embedding_configs = config.get("embedding_configs", {})
    name = selected_name or config.get("last_embedding_interface_format")
    if name not in embedding_configs:
        raise KeyError(f"不存在的 Embedding 配置: {name}")
    return dict(embedding_configs[name])
