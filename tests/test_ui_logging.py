import logging
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from ui.main_window import NovelGeneratorGUI, compact_log_text, split_log_role_marker


class FakeLogText:
    def __init__(self):
        self.deleted = False

    def configure(self, **kwargs):
        pass

    def delete(self, start, end):
        self.deleted = (start, end) == ("0.0", "end")


class FakeTaggedLogText:
    def __init__(self):
        self.inserts = []
        self.tags = {}

    def insert(self, index, text, tags=None):
        self.inserts.append((index, text, tags))

    def tag_config(self, tag_name, **kwargs):
        self.tags[tag_name] = kwargs


class UiLoggingTest(unittest.TestCase):
    def test_compact_log_text_keeps_first_and_last_100_characters(self):
        value = "a" * 250
        compacted = compact_log_text(value)
        self.assertEqual(100, len(compacted.split("\n……\n")[0]))
        self.assertEqual(100, len(compacted.split("\n……\n")[1]))

    def test_ai_log_marker_is_colored_without_coloring_body(self):
        widget = FakeTaggedLogText()
        NovelGeneratorGUI._insert_colored_log(
            widget, "[发送给 AI]\n这是完整提示词"
        )

        self.assertEqual("◆ 我的请求", widget.inserts[0][1])
        self.assertEqual("log_ai_request", widget.inserts[0][2])
        self.assertEqual("这是完整提示词", widget.inserts[2][1])
        self.assertIsNone(widget.inserts[2][2])
        self.assertEqual("#1976d2", widget.tags["log_ai_request"]["foreground"])

    def test_ai_response_uses_separate_green_marker(self):
        marker = split_log_role_marker("[AI 返回]\n回答正文")
        self.assertEqual(
            ("◆ AI 返回", "log_ai_response", "#16803a", "回答正文"),
            marker,
        )

    def test_detail_history_recolors_displayed_role_markers(self):
        widget = FakeTaggedLogText()
        gui = object.__new__(NovelGeneratorGUI)
        gui._insert_log_history(
            widget,
            "普通日志\n◆ 我的请求\n提示词\n◆ AI 返回\n回答",
        )

        tagged = [(text, tag) for _, text, tag in widget.inserts if tag]
        self.assertEqual(
            [
                ("◆ 我的请求", "log_ai_request"),
                ("◆ AI 返回", "log_ai_response"),
            ],
            tagged,
        )

    def test_clear_app_log_clears_file_and_text_widget(self):
        original_directory = os.getcwd()
        with tempfile.TemporaryDirectory() as temp_dir:
            os.chdir(temp_dir)
            try:
                log_path = pathlib.Path(temp_dir) / "app.log"
                handler = logging.FileHandler(log_path, encoding="utf-8")
                root_logger = logging.getLogger()
                root_logger.addHandler(handler)
                root_logger.warning("需要清除的日志")

                gui = object.__new__(NovelGeneratorGUI)
                gui.log_text = FakeLogText()
                with (
                    patch("ui.main_window.messagebox.askyesno", return_value=True),
                    patch("ui.main_window.messagebox.showinfo") as showinfo,
                ):
                    NovelGeneratorGUI.clear_app_log(gui)

                self.assertEqual(log_path.read_text(encoding="utf-8"), "")
                self.assertTrue(gui.log_text.deleted)
                showinfo.assert_called_once()
            finally:
                if "handler" in locals():
                    logging.getLogger().removeHandler(handler)
                    handler.close()
                os.chdir(original_directory)


if __name__ == "__main__":
    unittest.main()
