import unittest
from unittest.mock import Mock, patch

from ui.config_tab import save_embedding_config


class EmbeddingConfigUiTest(unittest.TestCase):
    def test_save_embedding_config_only_updates_embedding_section(self):
        gui = Mock()
        gui.config_file = "config.json"
        gui.embedding_interface_format_var.get.return_value = "SiliconFlow"
        gui.embedding_api_key_var.get.return_value = "secret"
        gui.embedding_url_var.get.return_value = "https://api.siliconflow.cn/v1/embeddings"
        gui.embedding_model_name_var.get.return_value = "BAAI/bge-m3"
        gui.safe_get_int.return_value = 6
        existing = {"llm_configs": {"保留": {"model_name": "model"}}}

        with (
            patch("ui.config_tab.load_config", return_value=existing),
            patch("ui.config_tab.save_config", return_value=True) as save,
            patch("ui.config_tab.messagebox.showinfo"),
        ):
            result = save_embedding_config(gui)

        self.assertTrue(result)
        saved = save.call_args.args[0]
        self.assertEqual(saved["llm_configs"], existing["llm_configs"])
        self.assertEqual(saved["last_embedding_interface_format"], "SiliconFlow")
        self.assertEqual(saved["embedding_configs"]["SiliconFlow"]["retrieval_k"], 6)
        self.assertEqual(saved["embedding_configs"]["SiliconFlow"]["api_key"], "secret")


if __name__ == "__main__":
    unittest.main()
