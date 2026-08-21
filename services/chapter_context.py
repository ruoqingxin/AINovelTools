# -*- coding: utf-8 -*-
"""统一构造章节生成所需的只读上下文。"""
from __future__ import annotations

from dataclasses import dataclass

from services.blueprint_service import BlueprintService
from services.outline_service import OutlineService


@dataclass(frozen=True)
class ChapterContext:
    chapter_number: int
    architecture: str
    current_blueprint: dict
    next_blueprint: dict | None
    global_summary: str
    character_state: str
    plot_arcs: str
    recent_chapters: tuple[str, ...]
    role_profiles: str
    writing_skills: str
    knowledge_context: str


class ChapterContextBuilder:
    def __init__(self, repository, skill_service=None):
        self.repository = repository
        self.skill_service = skill_service

    def build(self, project: dict, chapter_number: int, request: dict | None = None) -> ChapterContext:
        request = request or {}
        blueprint_service = BlueprintService(self.repository)
        current = blueprint_service.get_chapter(chapter_number) or {"chapter_number": chapter_number}
        next_info = blueprint_service.get_chapter(chapter_number + 1)
        recent = tuple(
            self.repository.read_chapter(number)
            for number in range(max(1, chapter_number - 3), chapter_number)
            if self.repository.read_chapter(number).strip()
        )
        names = request.get("character_names") or project.get("characters_involved", "")
        return ChapterContext(
            chapter_number=chapter_number,
            architecture=OutlineService(self.repository).render_to_string().strip(),
            current_blueprint=current,
            next_blueprint=next_info if next_info and any(
                next_info.get(key)
                for key in ("chapter_summary", "chapter_role", "chapter_purpose")
            ) else None,
            global_summary=self.repository.read_text("global_summary.txt"),
            character_state=self.repository.read_text("character_state.txt"),
            plot_arcs=self.repository.read_text("plot_arcs.txt"),
            recent_chapters=recent,
            role_profiles=self._load_roles(names),
            writing_skills=request.get("writing_skills") or (
                self.skill_service.resolve(project.get("selected_skill_ids", []))
                if self.skill_service else ""
            ),
            knowledge_context=request.get("knowledge_context", ""),
        )

    def _load_roles(self, names: str) -> str:
        wanted = {name.strip() for name in names.replace("\n", ",").split(",") if name.strip()}
        if not wanted:
            return ""
        role_dir = self.repository.path_for("角色库")
        if not role_dir.is_dir():
            return ""
        profiles = []
        for path in role_dir.rglob("*.txt"):
            if path.stem in wanted:
                profiles.append(path.read_text(encoding="utf-8"))
        return "\n\n".join(profiles)
