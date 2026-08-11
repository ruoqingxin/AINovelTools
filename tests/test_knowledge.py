import tempfile
import unittest
from pathlib import Path

from novel_generator.knowledge import collect_knowledge_files, read_knowledge_file


class KnowledgeFileTest(unittest.TestCase):
    def test_reads_utf8_markdown_with_bom(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "设定.md"
            path.write_text("# 世界观\n\n这是设定。", encoding="utf-8-sig")

            content = read_knowledge_file(str(path))

        self.assertEqual(content, "# 世界观\n\n这是设定。")

    def test_reads_gb18030_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "资料.txt"
            path.write_bytes("中文参考资料".encode("gb18030"))

            content = read_knowledge_file(str(path))

        self.assertEqual(content, "中文参考资料")

    def test_collects_supported_files_recursively(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            nested = root / "子目录"
            nested.mkdir()
            (root / "世界观.md").write_text("world", encoding="utf-8")
            (nested / "人物.TXT").write_text("role", encoding="utf-8")
            (nested / "忽略.json").write_text("{}", encoding="utf-8")

            files = collect_knowledge_files(temp_dir)

        self.assertEqual({Path(path).name for path in files}, {"世界观.md", "人物.TXT"})


if __name__ == "__main__":
    unittest.main()
