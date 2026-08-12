import pathlib
import tempfile
import unittest
from unittest.mock import patch

from novel_generator.architecture import revise_architecture_section
from novel_generator.architecture_sections import (
    append_architecture_subsection,
    parse_architecture_sections,
    replace_architecture_section,
)


SAMPLE_ARCHITECTURE = """前言保持原样
#=== 1) 核心种子 ===
核心内容
#=== 2) 世界观 ===
世界观概述
# 三维交织世界观构建
## 一、物理维度
物理说明
### 1.1 空间结构
空间说明
### 1.2 法则体系
法则说明
## 二、社会维度
社会说明
#=== 3) 主线 ===
主线内容
"""


class FakeAdapter:
    def __init__(self, response):
        self.response = response
        self.prompt = ""

    def invoke(self, prompt):
        self.prompt = prompt
        return self.response


class ArchitectureSectionTest(unittest.TestCase):
    def test_parses_special_and_standard_headings_as_hierarchy(self):
        sections = parse_architecture_sections(SAMPLE_ARCHITECTURE)
        by_title = {section.title: section for section in sections}

        self.assertIn("2) 世界观", by_title)
        world_detail = next(
            item for item in sections if item.heading == "# 三维交织世界观构建"
        )
        self.assertEqual(world_detail.parent_index, by_title["2) 世界观"].index)
        self.assertEqual(by_title["一、物理维度"].parent_index, world_detail.index)
        self.assertEqual(
            by_title["1.2 法则体系"].parent_index,
            by_title["一、物理维度"].index,
        )
        world_text = by_title["2) 世界观"].content_from(SAMPLE_ARCHITECTURE)
        self.assertIn("### 1.2 法则体系", world_text)
        self.assertIn("## 二、社会维度", world_text)
        self.assertNotIn("#=== 3) 主线 ===", world_text)

    def test_replacement_preserves_everything_outside_selected_section(self):
        section = next(
            item
            for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
            if item.title == "1.2 法则体系"
        )
        replacement = "### 1.2 法则体系\n新的境界划分\n"
        merged = replace_architecture_section(
            SAMPLE_ARCHITECTURE, section, replacement
        )

        self.assertEqual(
            merged,
            SAMPLE_ARCHITECTURE[:section.start]
            + replacement
            + SAMPLE_ARCHITECTURE[section.end:],
        )
        self.assertIn("空间说明", merged)
        self.assertIn("主线内容", merged)

    def test_can_add_a_targeted_child_section(self):
        world = next(
            item
            for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
            if item.title == "2) 世界观"
        )
        merged, heading = append_architecture_subsection(
            SAMPLE_ARCHITECTURE, world, "境界划分"
        )

        self.assertEqual("# 境界划分", heading)
        self.assertIn("# 境界划分\n#=== 3) 主线 ===", merged)

    def test_ai_rewrites_only_selected_section_and_saves_merged_document(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            section = next(
                item
                for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
                if item.title == "1.2 法则体系"
            )
            adapter = FakeAdapter("## 错误标题\n炼体、筑基、金丹")

            with patch(
                "novel_generator.architecture.create_llm_adapter",
                return_value=adapter,
            ):
                merged, replacement = revise_architecture_section(
                    interface_format="OpenAI",
                    api_key="key",
                    base_url="https://example.com/v1",
                    llm_model="model",
                    filepath=temp_dir,
                    current_architecture=SAMPLE_ARCHITECTURE,
                    section=section,
                    revision_guidance="增加清晰的境界划分",
                )

            self.assertTrue(replacement.startswith(section.heading))
            self.assertIn("增加清晰的境界划分", adapter.prompt)
            self.assertIn("完整小说架构", adapter.prompt)
            self.assertIn("主线内容", merged)
            self.assertNotIn("法则说明", merged)
            self.assertEqual(
                (project / "Novel_architecture.txt").read_text(encoding="utf-8"),
                merged,
            )


if __name__ == "__main__":
    unittest.main()
