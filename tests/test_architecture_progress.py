from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from novel_generator.architecture import Novel_architecture_generate


class FakeLLMAdapter:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.prompts = []

    def invoke(self, prompt):
        self.prompts.append(prompt)
        return next(self.responses)


class ArchitectureProgressTest(unittest.TestCase):
    def test_reports_each_slow_stage_and_saves_final_files(self):
        adapter = FakeLLMAdapter([
            "核心故事种子",
            "角色体系",
            "初始角色状态",
            "世界观体系",
            "主线剧情架构",
        ])
        progress = []

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch(
                "novel_generator.architecture.create_llm_adapter",
                return_value=adapter,
            ):
                result = Novel_architecture_generate(
                    interface_format="OpenAI",
                    api_key="test-key",
                    base_url="https://example.test/v1",
                    llm_model="test-model",
                    topic="测试主题",
                    genre="玄幻",
                    number_of_chapters=10,
                    word_number=2000,
                    filepath=temp_dir,
                    progress_callback=progress.append,
                )

            self.assertTrue(result)
            self.assertEqual(5, len(adapter.prompts))
            for step in range(1, 6):
                stage_messages = [message for message in progress if f"[{step}/5]" in message]
                self.assertTrue(
                    any("正在请求大模型" in message for message in stage_messages),
                    f"missing start progress for step {step}",
                )
                self.assertTrue(
                    any("生成完成" in message for message in stage_messages),
                    f"missing completion progress for step {step}",
                )

            project = Path(temp_dir)
            self.assertTrue((project / "Novel_architecture.txt").exists())
            self.assertTrue((project / "character_state.txt").exists())
            self.assertFalse((project / "partial_architecture.json").exists())
            self.assertIn("全部阶段完成", progress[-1])


if __name__ == "__main__":
    unittest.main()
