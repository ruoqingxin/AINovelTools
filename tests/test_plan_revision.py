import pathlib
import tempfile
import unittest
from unittest.mock import patch

from novel_generator.architecture import revise_novel_architecture
from novel_generator.blueprint import (
    revise_chapter_blueprint,
    Chapter_blueprint_generate,
    generate_volume_plan,
    blueprint_stage_guardrail,
)


class FakeAdapter:
    def __init__(self, response):
        self.response = response
        self.prompt = ""

    def invoke(self, prompt):
        self.prompt = prompt
        return self.response


class PlanRevisionTest(unittest.TestCase):
    def test_blueprint_stage_guardrails_change_across_novel_progress(self):
        self.assertIn("立足期", blueprint_stage_guardrail(1000, 51, 100))
        self.assertIn("成长扩张期", blueprint_stage_guardrail(1000, 151, 300))
        self.assertIn("中段展开期", blueprint_stage_guardrail(1000, 351, 500))
        self.assertIn("主线汇聚期", blueprint_stage_guardrail(1000, 601, 750))
        self.assertIn("终局准备期", blueprint_stage_guardrail(1000, 801, 900))
        self.assertIn("尚未覆盖最后一章", blueprint_stage_guardrail(1000, 951, 999))
        self.assertIn("最后一章", blueprint_stage_guardrail(1000, 991, 1000))

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
            self.assertIn("局部蓝图防剧透规则", adapter.prompt)
            self.assertIn("不得提前确认上述终局答案", adapter.prompt)
            self.assertIn("全书前5%的开局期", adapter.prompt)
            self.assertIn("禁止自行创造近似名称", adapter.prompt)
            self.assertIn("不得在一个短范围内跨越大域", adapter.prompt)
            self.assertIn("逐章核对伤亡人数", adapter.prompt)
            self.assertIn("不得用终局答案给未知线索命名", adapter.prompt)

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

    def test_existing_range_can_be_replaced(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text("小说架构内容", encoding="utf-8")
            (project / "Novel_directory.txt").write_text(
                "第1章 - 旧内容\n\n第2章 - 旧内容\n\n第20章 - 后续", encoding="utf-8"
            )
            adapter = FakeAdapter("第1章 - 新内容\n\n第2章 - 新内容")
            with patch("novel_generator.blueprint.create_llm_adapter", return_value=adapter):
                result = Chapter_blueprint_generate(
                    interface_format="OpenAI", api_key="key", base_url="https://example.com/v1",
                    llm_model="model", filepath=temp_dir, number_of_chapters=20,
                    start_chapter=1, end_chapter=2, replace_range=True,
                )
            saved = (project / "Novel_directory.txt").read_text(encoding="utf-8")
            self.assertTrue(result)
            self.assertIn("第1章 - 新内容", saved)
            self.assertNotIn("第1章 - 旧内容", saved)
            self.assertIn("第20章 - 后续", saved)

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
