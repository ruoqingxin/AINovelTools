import tempfile
import unittest
import sys
import types
from unittest.mock import ANY, patch

if "llm_adapters" not in sys.modules:
    llm_adapters = types.ModuleType("llm_adapters")
    llm_adapters.create_llm_adapter = lambda **kwargs: None
    sys.modules["llm_adapters"] = llm_adapters
if "embedding_adapters" not in sys.modules:
    embedding_adapters = types.ModuleType("embedding_adapters")
    embedding_adapters.create_embedding_adapter = lambda *args, **kwargs: None
    sys.modules["embedding_adapters"] = embedding_adapters

from novel_generator.finalization import finalize_chapter
from novel_generator.storage import NovelProjectRepository


class FakeLLMAdapter:
    def invoke(self, prompt):
        if "前文摘要" in prompt:
            return "updated summary"
        if "角色状态文档" in prompt:
            return "updated character state"
        if "剧情追踪文档" in prompt:
            return "updated plot arcs"
        raise AssertionError("unexpected prompt")


class FinalizationTest(unittest.TestCase):
    def test_finalization_commits_all_state_and_indexes_with_chapter_number(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = NovelProjectRepository(temp_dir)
            repository.write_chapter(2, "chapter body")

            with (
                patch("novel_generator.finalization.create_llm_adapter", return_value=FakeLLMAdapter()),
                patch("novel_generator.finalization.create_embedding_adapter", return_value=object()),
                patch("novel_generator.finalization.update_vector_store", return_value=True) as update_store,
            ):
                result = finalize_chapter(
                    novel_number=2,
                    word_number=1000,
                    api_key="key",
                    base_url="url",
                    model_name="model",
                    temperature=0.3,
                    filepath=temp_dir,
                    embedding_api_key="embedding-key",
                    embedding_url="embedding-url",
                    embedding_interface_format="OpenAI",
                    embedding_model_name="embedding-model",
                    interface_format="OpenAI",
                    max_tokens=2000,
                )

            self.assertTrue(result)
            self.assertTrue(result.data["indexed"])
            self.assertEqual(repository.read(repository.GLOBAL_SUMMARY), "updated summary")
            self.assertEqual(repository.read(repository.CHARACTER_STATE), "updated character state")
            self.assertEqual(repository.read(repository.PLOT_ARCS), "updated plot arcs")
            update_store.assert_called_once_with(
                embedding_adapter=ANY,
                new_chapter="chapter body",
                filepath=temp_dir,
                chapter_number=2,
            )

    def test_empty_chapter_returns_failure_without_calling_model(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("novel_generator.finalization.create_llm_adapter") as create_adapter:
                result = finalize_chapter(
                    novel_number=1,
                    word_number=1000,
                    api_key="",
                    base_url="",
                    model_name="",
                    temperature=0.3,
                    filepath=temp_dir,
                    embedding_api_key="",
                    embedding_url="",
                    embedding_interface_format="OpenAI",
                    embedding_model_name="",
                    interface_format="OpenAI",
                    max_tokens=2000,
                )

            self.assertFalse(result)
            create_adapter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
