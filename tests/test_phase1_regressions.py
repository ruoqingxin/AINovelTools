import threading
import time

from ui.prompt_wait import PromptWaitCancelled, wait_for_prompt_result
from utils import save_string_to_txt


def test_save_string_to_txt_returns_success_and_writes(tmp_path):
    target = tmp_path / "chapter.txt"

    assert save_string_to_txt("正文", str(target)) is True
    assert target.read_text(encoding="utf-8") == "正文"


def test_save_string_to_txt_returns_false_without_erasing_existing_file(tmp_path):
    target = tmp_path / "chapter.txt"
    target.write_text("原正文", encoding="utf-8")

    # 目录路径不能作为文件写入目标，函数应报告失败而不是抛出异常。
    assert save_string_to_txt("新正文", str(tmp_path)) is False
    assert target.read_text(encoding="utf-8") == "原正文"


def test_prompt_wait_can_be_cancelled():
    completed = threading.Event()
    cancelled = threading.Event()

    def cancel_later():
        time.sleep(0.02)
        cancelled.set()

    threading.Thread(target=cancel_later, daemon=True).start()

    started = time.monotonic()
    try:
        wait_for_prompt_result(completed, cancelled, poll_interval=0.01)
    except PromptWaitCancelled:
        elapsed = time.monotonic() - started
        assert elapsed < 1
    else:
        raise AssertionError("取消事件未终止 Prompt 等待")
