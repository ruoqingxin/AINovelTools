import pathlib
import tempfile
import unittest
from unittest.mock import patch

from novel_generator.architecture import (
    extract_architecture_section_from_material,
    revise_architecture_section,
)
from novel_generator.architecture_sections import (
    append_architecture_overview_section,
    append_architecture_subsection,
    architecture_section_body,
    delete_architecture_section,
    parse_architecture_sections,
    replace_architecture_section,
    replace_architecture_section_body,
    upsert_architecture_subsection_body,
    upsert_architecture_overview_section_body,
)
from ui.setting_tab import architecture_section_tree_key


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
    def test_tree_keys_survive_content_length_changes(self):
        original_sections = parse_architecture_sections(SAMPLE_ARCHITECTURE)
        original_law = next(
            item for item in original_sections if item.title == "1.2 法则体系"
        )
        changed = SAMPLE_ARCHITECTURE.replace("世界观概述", "更长的世界观概述内容")
        changed_sections = parse_architecture_sections(changed)
        changed_law = next(
            item for item in changed_sections if item.title == "1.2 法则体系"
        )

        self.assertNotEqual(original_law.start, changed_law.start)
        self.assertEqual(
            architecture_section_tree_key(original_law, original_sections),
            architecture_section_tree_key(changed_law, changed_sections),
        )

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

    def test_replacement_keeps_next_sibling_heading_parseable(self):
        section = next(
            item
            for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
            if item.title == "1.2 法则体系"
        )
        merged = replace_architecture_section(
            SAMPLE_ARCHITECTURE,
            section,
            "### 1.2 法则体系\n末尾手动增加内容",
        )

        self.assertIn("末尾手动增加内容\n## 二、社会维度", merged)
        titles = [item.title for item in parse_architecture_sections(merged)]
        self.assertIn("二、社会维度", titles)

    def test_delete_parent_removes_its_complete_subtree_only(self):
        world = next(
            item
            for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
            if item.title == "2) 世界观"
        )
        merged = delete_architecture_section(SAMPLE_ARCHITECTURE, world)

        self.assertNotIn("#=== 2) 世界观 ===", merged)
        self.assertNotIn("### 1.2 法则体系", merged)
        self.assertIn("#=== 1) 核心种子 ===\n核心内容", merged)
        self.assertIn("#=== 3) 主线 ===\n主线内容", merged)
        self.assertEqual(
            merged,
            SAMPLE_ARCHITECTURE[:world.start]
            + SAMPLE_ARCHITECTURE[world.end:],
        )

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

    def test_material_extraction_returns_candidate_without_writing_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project = pathlib.Path(temp_dir)
            section = next(
                item
                for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
                if item.title == "1.2 法则体系"
            )
            adapter = FakeAdapter("提炼后的五层境界与晋升限制")

            with patch(
                "novel_generator.architecture.create_llm_adapter",
                return_value=adapter,
            ):
                result = extract_architecture_section_from_material(
                    interface_format="OpenAI",
                    api_key="key",
                    base_url="https://example.com/v1",
                    llm_model="model",
                    current_architecture=SAMPLE_ARCHITECTURE,
                    target_location="法则体系正文",
                    target_content=architecture_section_body(
                        SAMPLE_ARCHITECTURE, section
                    ),
                    source_material="资料中的境界分为炼体、筑基、金丹。",
                )

            self.assertEqual("提炼后的五层境界与晋升限制", result)
            self.assertIn("炼体、筑基、金丹", adapter.prompt)
            self.assertIn("法则说明", adapter.prompt)
            self.assertFalse((project / "Novel_architecture.txt").exists())

    def test_body_update_preserves_all_child_headings_and_order(self):
        world = next(
            item
            for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
            if item.title == "2) 世界观"
        )
        merged = replace_architecture_section_body(
            SAMPLE_ARCHITECTURE, world, "更新后的世界观总述"
        )

        self.assertIn("#=== 2) 世界观 ===\n更新后的世界观总述", merged)
        self.assertLess(
            merged.index("# 三维交织世界观构建"),
            merged.index("## 一、物理维度"),
        )
        self.assertIn("### 1.2 法则体系\n法则说明", merged)

    def test_subsection_upsert_uses_fixed_location_and_reuses_same_title(self):
        world = next(
            item
            for item in parse_architecture_sections(SAMPLE_ARCHITECTURE)
            if item.title == "2) 世界观"
        )
        first, heading, created = upsert_architecture_subsection_body(
            SAMPLE_ARCHITECTURE, world, "境界体系", "炼体、筑基、金丹"
        )
        self.assertTrue(created)
        self.assertEqual("# 境界体系", heading)
        self.assertLess(first.index("# 境界体系"), first.index("#=== 3) 主线 ==="))
        first_sections = parse_architecture_sections(first)
        first_world = next(
            item for item in first_sections if item.title == "2) 世界观"
        )
        first_target = next(
            item for item in first_sections if item.heading == heading
        )
        self.assertEqual(first_world.index, first_target.parent_index)

        refreshed_world = next(
            item
            for item in first_sections
            if item.title == "2) 世界观"
        )
        second, second_heading, created = upsert_architecture_subsection_body(
            first, refreshed_world, "境界体系", "炼体、筑基、结丹、元婴"
        )
        self.assertFalse(created)
        self.assertEqual(heading, second_heading)
        self.assertEqual(1, second.count("# 境界体系"))
        self.assertNotIn("炼体、筑基、金丹\n", second)
        self.assertIn("炼体、筑基、结丹、元婴", second)

    def test_overview_can_add_and_update_top_level_sections(self):
        added, heading = append_architecture_overview_section(
            SAMPLE_ARCHITECTURE, "补充设定"
        )
        self.assertEqual("#=== 补充设定 ===", heading)
        self.assertTrue(added.rstrip().endswith("#=== 补充设定 ==="))

        first, heading, created = upsert_architecture_overview_section_body(
            SAMPLE_ARCHITECTURE, "境界体系", "炼体、筑基、金丹"
        )
        self.assertTrue(created)
        self.assertEqual("#=== 境界体系 ===", heading)
        second, second_heading, created = upsert_architecture_overview_section_body(
            first, "境界体系", "炼体、筑基、结丹、元婴"
        )
        self.assertFalse(created)
        self.assertEqual(heading, second_heading)
        self.assertEqual(1, second.count("#=== 境界体系 ==="))
        self.assertIn("炼体、筑基、结丹、元婴", second)


if __name__ == "__main__":
    unittest.main()
