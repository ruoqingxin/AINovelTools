from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import utils


class AtomicUtilityWriteTest(unittest.TestCase):
    def test_failed_replace_preserves_existing_text_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "chapter.txt"
            target.write_text("原正文", encoding="utf-8")

            with patch.object(utils.os, "replace", side_effect=OSError("locked")):
                saved = utils.save_string_to_txt("新正文", str(target))

            self.assertFalse(saved)
            self.assertEqual("原正文", target.read_text(encoding="utf-8"))
            self.assertEqual([], list(Path(temp_dir).glob("*.tmp")))

    def test_json_save_creates_parent_and_valid_utf8(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "nested" / "state.json"

            saved = utils.save_data_to_json({"角色": "林舟"}, str(target))

            self.assertTrue(saved)
            self.assertIn("林舟", target.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
