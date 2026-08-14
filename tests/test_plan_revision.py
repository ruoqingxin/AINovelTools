import pathlib
import tempfile
import unittest
from unittest.mock import patch

from novel_generator.architecture import revise_novel_architecture
from novel_generator.blueprint import revise_chapter_blueprint, Chapter_blueprint_generate, generate_volume_plan


class FakeAdapter:
    def __init__(self, response):
        self.response = response
        self.prompt = ""

    def invoke(self, prompt):
        self.prompt = prompt
        return self.response


class PlanRevisionTest(unittest.TestCase):
    def test_volume_plan_generation_is_bounded(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            pathlib.Path(temp_dir, "Novel_architecture.txt").write_text("小说架构内容", encoding="utf-8")
            adapter = FakeAdapter("第一卷：入局\n第二卷：升级")
            with patch("novel_generator.blueprint.create_llm_adapter", return_value=adapter):
                result = generate_volume_plan(
                    interface_format="OpenAI", api_key="key", base_url="https://example.com/v1",
                    llm_model="model", filepath=temp_dir, number_of_chapters=1000,
                    volume_count=5,
                )
            self.assertEqual(result, adapter.response)
            self.assertIn("最多20卷", adapter.prompt)

    def test_volume_plan_rejects_more_than_twenty_volumes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            pathlib.Path(temp_dir, "Novel_architecture.txt").write_text("小说架构内容", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "1-20"):
                generate_volume_plan(
                    interface_format="OpenAI", api_key="key", base_url="https://example.com/v1",
                    llm_model="model", filepath=temp_dir, number_of_chapters=1000,
                    volume_count=21,
                )

    def test_blueprint_range_keeps_whole_novel_length(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text("小说架构内容", encoding="utf-8")
            adapter = FakeAdapter("第1章 - 开端\n第2章 - 线索")
            with patch("novel_generator.blueprint.create_llm_adapter", return_value=adapter):
                result = Chapter_blueprint_generate(
                    interface_format="OpenAI", api_key="key", base_url="https://example.com/v1",
                    llm_model="model", filepath=temp_dir, number_of_chapters=1000,
                    start_chapter=1, end_chapter=10, max_tokens=4096,
                )
            self.assertTrue(result)
            self.assertIn("总计1000章", adapter.prompt)
            self.assertIn("第1章到第10章", adapter.prompt)
            self.assertNotIn("第10章大结局", adapter.prompt)

    def test_later_existing_chapters_do_not_skip_requested_range(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text("小说架构内容", encoding="utf-8")
            (project / "Novel_directory.txt").write_text("第100章 - 后续记录", encoding="utf-8")
            adapter = FakeAdapter("第1章 - 开端\n第2章 - 线索")
            with patch("novel_generator.blueprint.create_llm_adapter", return_value=adapter):
                Chapter_blueprint_generate(
                    interface_format="OpenAI", api_key="key", base_url="https://example.com/v1",
                    llm_model="model", filepath=temp_dir, number_of_chapters=1000,
                    start_chapter=1, end_chapter=10, max_tokens=4096,
                )
            self.assertIn("第1章到第10章", adapter.prompt)

    def test_non_contiguous_existing_range_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text("小说架构内容", encoding="utf-8")
            (project / "Novel_directory.txt").write_text("第1章 - 开端\n第3章 - 跳跃", encoding="utf-8")
            with patch("novel_generator.blueprint.create_llm_adapter"):
                result = Chapter_blueprint_generate(
                    interface_format="OpenAI", api_key="key", base_url="https://example.com/v1",
                    llm_model="model", filepath=temp_dir, number_of_chapters=10,
                    start_chapter=1, end_chapter=3, max_tokens=4096,
                )
            self.assertFalse(result)
            self.assertIn("不连续", result.message)

    def test_architecture_rewrite_uses_feedback_and_saves_complete_result(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            adapter = FakeAdapter("重新编写后的完整架构")

            with patch(
                "novel_generator.architecture.create_llm_adapter",
                return_value=adapter,
            ):
                result = revise_novel_architecture(
                    interface_format="OpenAI",
                    api_key="key",
                    base_url="https://example.com/v1",
                    llm_model="model",
                    filepath=temp_dir,
                    topic="东方奇幻",
                    genre="玄幻",
                    number_of_chapters=20,
                    word_number=3000,
                    current_architecture="原架构",
                    revision_guidance="弱化升级体系，加强人物关系",
                )

            self.assertEqual(result, "重新编写后的完整架构")
            self.assertIn("弱化升级体系", adapter.prompt)
            self.assertIn("原架构", adapter.prompt)
            self.assertEqual(
                (project / "Novel_architecture.txt").read_text(encoding="utf-8"),
                result,
            )

    def test_blueprint_can_rewrite_from_empty_editor(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text(
                "小说架构内容", encoding="utf-8"
            )
            adapter = FakeAdapter("第1章：新开端\n第2章：新冲突")

            with patch(
                "novel_generator.blueprint.create_llm_adapter",
                return_value=adapter,
            ):
                result = revise_chapter_blueprint(
                    interface_format="OpenAI",
                    api_key="key",
                    base_url="https://example.com/v1",
                    llm_model="model",
                    filepath=temp_dir,
                    number_of_chapters=2,
                    current_blueprint="",
                    revision_guidance="从头规划，让冲突更早出现",
                )

            self.assertIn("当前内容为空", adapter.prompt)
            self.assertEqual(
                (project / "Novel_directory.txt").read_text(encoding="utf-8"),
                result,
            )

    def test_empty_ai_result_does_not_overwrite_architecture(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            architecture_file = project / "Novel_architecture.txt"
            architecture_file.write_text("磁盘中的原架构", encoding="utf-8")

            with patch(
                "novel_generator.architecture.create_llm_adapter",
                return_value=FakeAdapter(""),
            ), self.assertRaisesRegex(RuntimeError, "返回空内容"):
                revise_novel_architecture(
                    interface_format="OpenAI",
                    api_key="key",
                    base_url="https://example.com/v1",
                    llm_model="model",
                    filepath=temp_dir,
                    topic="主题",
                    genre="类型",
                    number_of_chapters=10,
                    word_number=3000,
                    current_architecture="编辑区原架构",
                    revision_guidance="调整主线",
                )

            self.assertEqual(
                architecture_file.read_text(encoding="utf-8"),
                "磁盘中的原架构",
            )


if __name__ == "__main__":
    unittest.main()
