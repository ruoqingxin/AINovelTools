# -*- coding: utf-8 -*-
"""全局写作技能库读取和工程选择解析。"""
from __future__ import annotations

import json
from pathlib import Path


class SkillService:
    def __init__(self, config: dict):
        self.library_path = Path(config.get("skill_library_path", "写作技能库")).expanduser()

    def load(self) -> dict[str, dict]:
        result = {}
        if not self.library_path.is_dir():
            return result
        for path in self.library_path.glob("*.json"):
            try:
                skill = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            skill_id = str(skill.get("id") or path.stem).strip()
            content = str(skill.get("content", "")).strip()
            if skill_id and content:
                result[skill_id] = {"id": skill_id, "name": skill.get("name", skill_id), "content": content}
        return result

    def resolve(self, selected_ids: list[str]) -> str:
        skills = self.load()
        return "\n\n".join(skills[item]["content"] for item in selected_ids if item in skills)
