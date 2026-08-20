# -*- coding: utf-8 -*-
"""章节草稿保存、清单读取和连续性校验。"""
from __future__ import annotations

from domain.chapter_state import (
    active_chapter_numbers,
    find_max_contiguous_chapter,
    migrate_manifest,
    save_draft,
    validate_chapter_target,
)


class ChapterService:
    def __init__(self, repository):
        self.repository = repository

    def load_manifest(self) -> dict:
        return migrate_manifest(self.repository)

    def validate_target(self, chapter_number: int) -> str:
        return validate_chapter_target(self.load_manifest(), chapter_number)

    def next_appendable(self) -> int:
        manifest = self.load_manifest()
        return find_max_contiguous_chapter(active_chapter_numbers(manifest)) + 1

    def save_draft(self, chapter_number: int, content: str) -> dict:
        manifest = self.load_manifest()
        updated = save_draft(manifest, chapter_number, content)
        if not self.repository.write_chapter(chapter_number, content):
            raise RuntimeError(f"无法保存第 {chapter_number} 章草稿")
        if not self.repository.write_json("chapter_manifest.json", updated):
            raise RuntimeError("无法更新章节清单")
        return updated
