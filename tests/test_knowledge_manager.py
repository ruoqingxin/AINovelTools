import unittest

from ui.knowledge_manager import parse_extracted_planning


class KnowledgeManagerTest(unittest.TestCase):
    def test_parses_structured_planning_result(self):
        result = parse_extracted_planning(
            '{"topic":"成长与复仇","genre":"玄幻","num_chapters":120,'
            '"planning_guidance":"保留世界规则；主线围绕真相展开。"}'
        )

        self.assertEqual(result["topic"], "成长与复仇")
        self.assertEqual(result["genre"], "玄幻")
        self.assertEqual(result["num_chapters"], 120)

    def test_rejects_incomplete_planning_result(self):
        with self.assertRaises(ValueError):
            parse_extracted_planning('{"genre":"科幻"}')


if __name__ == "__main__":
    unittest.main()
