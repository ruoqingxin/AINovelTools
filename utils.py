# utils.py
# -*- coding: utf-8 -*-
import os
import json
import logging
from pathlib import Path
import tempfile


def _write_bytes_atomic(file_path: str, content: bytes) -> None:
    """Replace a file only after its complete content reaches disk."""
    target = Path(file_path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, target)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise

def read_file(filename: str) -> str:
    """读取文件的全部内容，若文件不存在或异常则返回空字符串。"""
    try:
        with open(filename, 'r', encoding='utf-8') as file:
            content = file.read()
        return content
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeError) as e:
        logging.warning("无法读取文件 %s: %s", filename, e)
        return ""

def append_text_to_file(text_to_append: str, file_path: str):
    """在文件末尾追加文本(带换行)。若文本非空且无换行，则自动加换行。"""
    if text_to_append and not text_to_append.startswith('\n'):
        text_to_append = '\n' + text_to_append

    try:
        with open(file_path, 'a', encoding='utf-8') as file:
            file.write(text_to_append)
    except IOError as e:
        logging.warning("无法追加文件 %s: %s", file_path, e)

def clear_file_content(filename: str) -> bool:
    """清空指定文件内容。"""
    try:
        _write_bytes_atomic(filename, b"")
        return True
    except OSError as e:
        logging.error("无法清空文件 %s: %s", filename, e)
        return False

def save_string_to_txt(content: str, filename: str) -> bool:
    """以原子替换方式保存 UTF-8 文本，返回是否成功。"""
    try:
        _write_bytes_atomic(filename, content.encode("utf-8"))
        return True
    except (OSError, UnicodeError) as e:
        logging.error("无法保存文本文件 %s: %s", filename, e)
        return False

def save_data_to_json(data: dict, file_path: str) -> bool:
    """以原子替换方式保存 JSON 文件。"""
    try:
        content = json.dumps(data, ensure_ascii=False, indent=4)
        _write_bytes_atomic(file_path, content.encode("utf-8"))
        return True
    except (OSError, TypeError, ValueError, UnicodeError) as e:
        logging.error("无法保存 JSON 文件 %s: %s", file_path, e)
        return False

def get_word_count(text: str) -> int:
    """
    根据 config_manager.IS_ENGLISH 计算字数。
    如果是英文模式，按单词（空格分隔）计算；
    如果是中文模式，按字符数计算。
    """
    try:
        import config_manager
        is_english = getattr(config_manager, 'IS_ENGLISH', False)
    except ImportError:
        is_english = False

    if not text:
        return 0
    if is_english:
        # 英文模式：按单词计算
        return len(text.split())
    else:
        # 中文模式：按字符计算
        return len(text)
