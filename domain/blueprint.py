# -*- coding: utf-8 -*-
"""分卷规划和章节蓝图的结构化校验。"""
from __future__ import annotations


BLUEPRINT_VERSION = 1
VOLUME_PLAN_VERSION = 1
REQUIRED_BLUEPRINT_FIELDS = (
    "chapter_number",
    "chapter_title",
    "chapter_role",
    "chapter_purpose",
    "suspense_level",
    "foreshadowing",
    "plot_twist_level",
    "chapter_summary",
)


class BlueprintValidationError(ValueError):
    pass


def empty_blueprint() -> dict:
    return {"version": BLUEPRINT_VERSION, "chapters": []}


def empty_volume_plan() -> dict:
    return {"version": VOLUME_PLAN_VERSION, "mode": "none", "volume_count": 0, "volumes": []}


def validate_blueprint_entries(entries: list[dict], start: int, end: int, total: int) -> list[str]:
    errors = []
    if not (1 <= start <= end <= total):
        errors.append(f"章节范围无效: {start}-{end}，总章节数为 {total}")
        return errors
    expected = set(range(start, end + 1))
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("蓝图包含非对象条目")
            continue
        number = entry.get("chapter_number")
        if not isinstance(number, int):
            errors.append("章节号必须是整数")
            continue
        if number in seen:
            errors.append(f"章节号重复: {number}")
        seen.add(number)
        if number not in expected:
            errors.append(f"章节号超出目标范围: {number}")
        for field in REQUIRED_BLUEPRINT_FIELDS:
            if field == "chapter_number":
                continue
            if not str(entry.get(field, "")).strip():
                errors.append(f"第 {number} 章缺少字段: {field}")
    missing = expected - seen
    if missing:
        errors.append("缺少章节: " + ", ".join(map(str, sorted(missing))))
    return errors


def validate_volume_plan(plan: dict, total_chapters: int) -> list[str]:
    errors = []
    mode = plan.get("mode", "none")
    volumes = plan.get("volumes", [])
    if mode == "none":
        if volumes:
            errors.append("不分卷模式不能包含分卷数据")
        return errors
    if mode not in {"manual_count", "auto"}:
        return [f"未知分卷模式: {mode}"]
    if not volumes:
        return ["分卷规划不能为空"]
    expected_start = 1
    for index, volume in enumerate(volumes, 1):
        if volume.get("number") != index:
            errors.append(f"卷号不连续: 预期 {index}")
        start = volume.get("start_chapter")
        end = volume.get("end_chapter")
        if not isinstance(start, int) or not isinstance(end, int) or start > end:
            errors.append(f"第 {index} 卷章节范围无效")
            continue
        if start != expected_start:
            errors.append(f"第 {index} 卷起始章节应为 {expected_start}，实际为 {start}")
        expected_start = end + 1
    if expected_start - 1 != total_chapters:
        errors.append(f"最后一卷必须结束于第 {total_chapters} 章")
    return errors
