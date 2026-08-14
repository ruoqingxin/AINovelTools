import json
import tempfile
import unittest
from pathlib import Path

from novel_generator.outline_workflow import OutlineWorkflow, OUTLINE_STEPS, extract_step_content, normalize_step_content, outline_adapter_kwargs


class OutlineWorkflowTest(unittest.TestCase):
    def test_outline_adapter_ignores_config_metadata(self):
        kwargs = outline_adapter_kwargs({
            "interface_format": "OpenAI", "base_url": "url", "model_name": "model",
            "api_key": "key", "temperature": 0.5, "max_tokens": 100,
            "timeout": 10, "updated_at": "metadata",
        })
        self.assertNotIn("updated_at", kwargs)
        self.assertEqual("model", kwargs["model_name"])

    def test_file_extraction_selects_matching_section(self):
        source = "# 题材类型\n玄幻冒险\n# 核心主题\n寻找自我"
        self.assertEqual("玄幻冒险", extract_step_content(source, "题材类型"))
        self.assertEqual("玄幻冒险", normalize_step_content("## 1. 题材类型\n玄幻冒险", "题材类型"))
    def test_confirmation_is_independent_and_ai_sees_confirmed_context_only(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = OutlineWorkflow(directory)
            workflow.confirm(2, "先确认第二步")
            self.assertEqual("confirmed", workflow.step(2)["status"])
            workflow.confirm(1, "玄幻")
            captured = {}
            def generator(title, prior):
                captured["prior"] = list(prior)
                return "主题"
            workflow.set_from_ai(2, generator)
            self.assertEqual([1], [item["index"] for item in captured["prior"]])

    def test_ai_context_includes_saved_custom_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = OutlineWorkflow(directory)
            custom = workflow.add_custom_section("补充设定", "自定义世界规则")
            workflow.confirm_custom_section(custom["id"])
            captured = {}

            def generator(title, prior):
                captured["prior"] = list(prior)
                return "核心主题"

            workflow.set_from_ai(1, generator)
            self.assertEqual(custom["id"], captured["prior"][0]["index"])
            self.assertEqual("custom", captured["prior"][0]["source"])

    def test_custom_section_can_be_confirmed_and_written(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = OutlineWorkflow(directory)
            custom = workflow.add_custom_section("补充设定", "自定义正文")
            confirmed = workflow.confirm_custom_section(custom["id"])
            self.assertEqual("confirmed", confirmed["status"])
            architecture = Path(directory, "Novel_architecture.txt").read_text(encoding="utf-8")
            self.assertIn("## 补充设定", architecture)
            self.assertIn("自定义正文", architecture)

    def test_changing_a_confirmed_section_reopens_later_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = OutlineWorkflow(directory)
            workflow.confirm(1, "玄幻")
            workflow.confirm(2, "成长")
            workflow.update(1, "科幻")
            self.assertEqual("draft", workflow.step(1)["status"])
            self.assertEqual("draft", workflow.step(2)["status"])
            self.assertFalse(workflow.data["finalized"])

    def test_saving_unchanged_confirmed_section_keeps_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = OutlineWorkflow(directory)
            workflow.confirm(1, "玄幻")
            workflow.update(1, "玄幻", "manual")
            self.assertEqual("confirmed", workflow.step(1)["status"])

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
