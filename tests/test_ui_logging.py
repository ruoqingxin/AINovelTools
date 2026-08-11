import logging
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from ui.main_window import NovelGeneratorGUI


class FakeLogText:
    def __init__(self):
        self.deleted = False

    def configure(self, **kwargs):
        pass

    def delete(self, start, end):
        self.deleted = (start, end) == ("0.0", "end")


class UiLoggingTest(unittest.TestCase):
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
