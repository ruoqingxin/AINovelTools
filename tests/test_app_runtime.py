import logging
from pathlib import Path
import tempfile
import unittest

from app_runtime import APP_LOG_HANDLER_MARKER, configure_app_logging


class AppRuntimeLoggingTest(unittest.TestCase):
    def test_migrates_legacy_log_and_rotates_utf8_output(self):
        root_logger = logging.getLogger()
        original_level = root_logger.level
        with tempfile.TemporaryDirectory() as temp_dir:
            log_path = Path(temp_dir) / "app.log"
            log_path.write_bytes("旧日志\n".encode("gb18030"))
            handler = None
            try:
                configure_app_logging(log_path, max_bytes=180, backup_count=2)
                self.assertEqual("旧日志\n", log_path.read_text(encoding="utf-8"))
                handler = next(
                    item
                    for item in root_logger.handlers
                    if getattr(item, APP_LOG_HANDLER_MARKER, False)
                    and Path(item.baseFilename) == log_path
                )
                for index in range(20):
                    root_logger.info("UTF-8 日志内容 %s %s", index, "x" * 30)
                handler.flush()

                self.assertTrue((Path(temp_dir) / "app.log.1").exists())
                for candidate in Path(temp_dir).glob("app.log*"):
                    candidate.read_text(encoding="utf-8")
            finally:
                if handler is not None:
                    root_logger.removeHandler(handler)
                    handler.close()
                root_logger.setLevel(original_level)


if __name__ == "__main__":
    unittest.main()
