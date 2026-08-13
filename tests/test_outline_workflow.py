import json
import tempfile
import unittest
from pathlib import Path

from novel_generator.outline_workflow import OutlineWorkflow, OUTLINE_STEPS


class OutlineWorkflowTest(unittest.TestCase):
    def test_state_survives_reload_and_finalization(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = OutlineWorkflow(directory)
            workflow.update(1, "修仙", "manual")
            workflow.confirm(1)
            restored = OutlineWorkflow(directory)
            self.assertEqual(restored.step(1)["status"], "confirmed")
            self.assertEqual(restored.current_index(), 2)
            self.assertEqual(len(restored.step(1)["history"]), 2)

            for index, title in enumerate(OUTLINE_STEPS, 1):
                if index > 1:
                    restored.update(index, f"内容 {index}", "manual")
                    restored.confirm(index)
            output = restored.finalize()
            self.assertTrue(output.exists())
            self.assertIn("## 34. 章节大纲", output.read_text(encoding="utf-8"))
            saved = json.loads((Path(directory) / "outline_workflow.json").read_text(encoding="utf-8"))
            self.assertTrue(saved["finalized"])


if __name__ == "__main__":
    unittest.main()
