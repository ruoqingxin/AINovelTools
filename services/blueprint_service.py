# -*- coding: utf-8 -*-
"""结构化蓝图和分卷规划的迁移、校验、渲染与范围替换。"""
from __future__ import annotations

from chapter_directory_parser import parse_chapter_blueprint
from domain.blueprint import (
    BlueprintValidationError,
    empty_blueprint,
    empty_volume_plan,
    validate_blueprint_entries,
    validate_volume_plan,
)


class BlueprintService:
    def __init__(self, repository):
        self.repository = repository

    def load_blueprint(self) -> dict:
        existing = self.repository.read_json("blueprint.json")
        if isinstance(existing, dict) and isinstance(existing.get("chapters"), list):
            return existing
        entries = parse_chapter_blueprint(self.repository.read_text("Novel_directory.txt"))
        blueprint = empty_blueprint()
        blueprint["chapters"] = entries
        if not self.repository.write_json("blueprint.json", blueprint):
            raise RuntimeError("无法迁移 blueprint.json")
        return blueprint

    def get_chapter(self, chapter_number: int) -> dict | None:
        for entry in self.load_blueprint()["chapters"]:
            if entry.get("chapter_number") == chapter_number:
                return entry
        return None

    def save_full(self, entries: list[dict], total_chapters: int) -> None:
        errors = validate_blueprint_entries(entries, 1, total_chapters, total_chapters)
        if errors:
            raise BlueprintValidationError("; ".join(errors))
        self._write_blueprint(entries)

    def replace_range(self, start: int, end: int, entries: list[dict], total_chapters: int) -> None:
        errors = validate_blueprint_entries(entries, start, end, total_chapters)
        if errors:
            raise BlueprintValidationError("; ".join(errors))
        current = self.load_blueprint()["chapters"]
        remaining = [entry for entry in current if not start <= entry.get("chapter_number", 0) <= end]
        combined = sorted(remaining + entries, key=lambda item: item["chapter_number"])
        numbers = [entry["chapter_number"] for entry in combined]
        if len(numbers) != len(set(numbers)):
            raise BlueprintValidationError("替换后存在重复章节号")
        self._write_blueprint(combined)

    def import_generated_text(self, text: str, total_chapters: int) -> None:
        entries = parse_chapter_blueprint(text)
        self.save_full(entries, total_chapters)

    def save_legacy_text(self, text: str, total_chapters: int) -> None:
        self.import_generated_text(text, total_chapters)

    def load_volume_plan(self) -> dict:
        existing = self.repository.read_json("volume_plan.json")
        if isinstance(existing, dict):
            return existing
        plan = empty_volume_plan()
        if not self.repository.write_json("volume_plan.json", plan):
            raise RuntimeError("无法初始化 volume_plan.json")
        return plan

    def save_volume_plan(self, plan: dict, total_chapters: int) -> None:
        errors = validate_volume_plan(plan, total_chapters)
        if errors:
            raise BlueprintValidationError("; ".join(errors))
        plan = dict(plan)
        plan["version"] = 1
        if not self.repository.write_json("volume_plan.json", plan):
            raise RuntimeError("无法保存 volume_plan.json")

    def _write_blueprint(self, entries: list[dict]) -> None:
        payload = {"version": 1, "chapters": sorted(entries, key=lambda item: item["chapter_number"])}
        if not self.repository.write_json("blueprint.json", payload):
            raise RuntimeError("无法保存 blueprint.json")
        if not self.repository.write_text("Novel_directory.txt", self.render(payload["chapters"])):
            raise RuntimeError("无法渲染 Novel_directory.txt")

    @staticmethod
    def render(entries: list[dict]) -> str:
        blocks = []
        for entry in entries:
            blocks.append(
                "\n".join(
                    [
                        f"第{entry['chapter_number']}章 - {entry['chapter_title']}",
                        f"章节定位：{entry['chapter_role']}",
                        f"核心作用：{entry['chapter_purpose']}",
                        f"悬念密度：{entry['suspense_level']}",
                        f"伏笔设计：{entry['foreshadowing']}",
                        f"转折程度：{entry['plot_twist_level']}",
                        f"章节简述：{entry['chapter_summary']}",
                    ]
                )
            )
        return "\n\n".join(blocks) + ("\n" if blocks else "")
