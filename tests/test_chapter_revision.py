import pathlib
import tempfile
import unittest
from unittest.mock import patch

from novel_generator.chapter import revise_chapter_draft


class FakeAdapter:
    def __init__(self, response):
        self.response = response
        self.prompt = ""

    def invoke(self, prompt):
        self.prompt = prompt
        return self.response


class ChapterRevisionTest(unittest.TestCase):
    def test_revision_uses_feedback_and_writes_only_successful_result(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text("世界设定", encoding="utf-8")
            (project / "Novel_directory.txt").write_text(
                "第1章：雨夜来客\n章节简述：主角发现线索",
                encoding="utf-8",
            )
            adapter = FakeAdapter("修改后的完整正文")

            with patch(
                "novel_generator.chapter.create_llm_adapter", return_value=adapter
            ):
                result = revise_chapter_draft(
                    api_key="key",
                    base_url="https://example.com/v1",
                    model_name="model",
                    filepath=temp_dir,
                    novel_number=1,
                    word_number=3000,
                    chapter_text="用户手工调整后的草稿",
                    revision_guidance="加强雨夜的压迫感，保留结尾线索",
                )

            self.assertEqual(result, "修改后的完整正文")
            self.assertIn("加强雨夜的压迫感", adapter.prompt)
            self.assertIn("用户手工调整后的草稿", adapter.prompt)
            self.assertEqual(
                (project / "chapters" / "chapter_1.txt").read_text(encoding="utf-8"),
                "修改后的完整正文",
            )
            self.assertEqual(
                (
                    project
                    / "chapters"
                    / "revisions"
                    / "chapter_1_before.txt"
                ).read_text(encoding="utf-8"),
                "用户手工调整后的草稿",
            )

    def test_empty_revision_does_not_overwrite_existing_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            chapters = project / "chapters"
            chapters.mkdir()
            chapter_file = chapters / "chapter_1.txt"
            chapter_file.write_text("原文件正文", encoding="utf-8")

            with (
                patch(
                    "novel_generator.chapter.create_llm_adapter",
                    return_value=FakeAdapter(""),
                ),
                self.assertRaisesRegex(RuntimeError, "返回空内容"),
            ):
                revise_chapter_draft(
                    api_key="key",
                    base_url="https://example.com/v1",
                    model_name="model",
                    filepath=temp_dir,
                    novel_number=1,
                    word_number=3000,
                    chapter_text="编辑器中的现稿",
                    revision_guidance="调整对话",
                )

            self.assertEqual(chapter_file.read_text(encoding="utf-8"), "原文件正文")


if __name__ == "__main__":
    unittest.main()
