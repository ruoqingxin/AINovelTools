import pathlib
import tempfile
import unittest
from unittest.mock import Mock

from ui.main_window import NovelGeneratorGUI


class StartupTest(unittest.TestCase):
    def test_architecture_page_callbacks_are_bound_to_main_window(self):
        for callback_name in (
            "update_architecture_workflow_state",
            "update_architecture_input_visibility",
            "toggle_architecture_input_panel",
        ):
            self.assertTrue(callable(getattr(NovelGeneratorGUI, callback_name, None)))

    def test_service_config_requires_key_only_for_cloud_services(self):
        self.assertTrue(NovelGeneratorGUI._service_config_ready({
            "interface_format": "Ollama",
            "base_url": "http://localhost:11434/api",
            "model_name": "bge-m3",
            "api_key": "",
        }))
        self.assertFalse(NovelGeneratorGUI._service_config_ready({
            "interface_format": "SiliconFlow",
            "base_url": "https://api.siliconflow.cn/v1/embeddings",
            "model_name": "BAAI/bge-m3",
            "api_key": "",
        }))

    def test_restore_project_files_loads_generated_content(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            (project / "Novel_architecture.txt").write_text("架构内容", encoding="utf-8")
            (project / "chapters").mkdir()
            (project / "chapters" / "chapter_2.txt").write_text("第二章正文", encoding="utf-8")
            (project / "chapters" / "revisions").mkdir()
            (project / "chapters" / "revisions" / "chapter_2_before.txt").write_text(
                "第二章修改前正文", encoding="utf-8"
            )

            gui = object.__new__(NovelGeneratorGUI)
            gui.filepath_var = Mock()
            gui.filepath_var.get.return_value = temp_dir
            gui.chapter_num_var = Mock()
            gui.chapter_num_var.get.return_value = "2"
            gui.setting_text = Mock()
            gui.directory_text = Mock()
            gui.character_text = Mock()
            gui.summary_text = Mock()
            gui.chapter_result = Mock()
            gui.chapter_before_result = Mock()
            gui.setting_word_count_label = Mock()
            gui.directory_word_count_label = Mock()
            gui.character_wordcount_label = Mock()
            gui.word_count_label = Mock()
            gui.chapter_label = Mock()
            gui.chapter_before_label = Mock()

            restored = NovelGeneratorGUI._restore_project_files(gui)

            self.assertEqual(restored, 3)
            gui.setting_text.insert.assert_called_once_with("0.0", "架构内容")
            gui.chapter_result.insert.assert_called_once_with("0.0", "第二章正文")
            gui.chapter_before_result.insert.assert_called_once_with(
                "0.0", "第二章修改前正文"
            )


if __name__ == "__main__":
    unittest.main()
