# -*- coding: utf-8 -*-
"""章节原子定稿、状态快照和索引状态管理。"""
from __future__ import annotations

import json

from domain.chapter_state import (
    STATUS_FINALIZED,
    STATUS_INDEX_PENDING,
    FINAL_STATUSES,
    content_hash,
    finalize_record,
)


class ChapterFinalizationService:
    def __init__(self, repository):
        self.repository = repository

    def finalize(self, chapter_number: int, chapter_text: str, global_summary: str,
                 character_state: str, plot_arcs: str, indexer=None) -> dict:
        chapter_text = chapter_text.strip()
        if not chapter_text:
            raise ValueError("空章节不能定稿")
        manifest = self.repository.read_json("chapter_manifest.json", {"version": 1, "chapters": {}})
        current = manifest.get("chapters", {}).get(str(chapter_number), {})
        digest = content_hash(chapter_text)
        if current.get("status") in FINAL_STATUSES and current.get("content_hash") == digest:
            return {"changed": False, "indexed": current.get("indexed", False)}

        snapshot_name = f"chapter_states/chapter_{chapter_number}.json"
        snapshot = {
            "version": 1, "chapter_number": chapter_number, "content_hash": digest,
            "global_summary": global_summary, "character_state": character_state,
            "plot_arcs": plot_arcs,
        }
        updated = finalize_record(manifest, chapter_number, chapter_text, snapshot_name)
        files = {
            f"chapters/chapter_{chapter_number}.txt": chapter_text,
            "global_summary.txt": global_summary,
            "character_state.txt": character_state,
            "plot_arcs.txt": plot_arcs,
            "chapter_manifest.json": json.dumps(updated, ensure_ascii=False, indent=2) + "\n",
            snapshot_name: json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n",
        }
        self.repository.write_many(files)

        indexed = False
        if indexer is not None:
            try:
                indexed = indexer(chapter_text) is not False
            except Exception:
                indexed = False
        latest = self.repository.read_json("chapter_manifest.json")
        record = latest["chapters"][str(chapter_number)]
        record["indexed"] = indexed
        record["status"] = STATUS_FINALIZED if indexed or indexer is None else STATUS_INDEX_PENDING
        if not self.repository.write_json("chapter_manifest.json", latest):
            raise RuntimeError("无法更新章节索引状态")
        return {"changed": True, "indexed": indexed, "status": record["status"]}

    def rebuild_index(self, chapter_number: int, indexer) -> bool:
        manifest = self.repository.read_json("chapter_manifest.json", {"chapters": {}})
        record = manifest.get("chapters", {}).get(str(chapter_number))
        if not record or record.get("status") != STATUS_INDEX_PENDING:
            raise ValueError(f"第 {chapter_number} 章不处于索引待重建状态")
        chapter_text = self.repository.read_chapter(chapter_number)
        try:
            indexed = indexer(chapter_text) is not False
        except Exception:
            indexed = False
        if indexed:
            record["indexed"] = True
            record["status"] = STATUS_FINALIZED
            if not self.repository.write_json("chapter_manifest.json", manifest):
                raise RuntimeError("无法更新章节索引状态")
        return indexed
