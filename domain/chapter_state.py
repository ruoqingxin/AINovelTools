# -*- coding: utf-8 -*-
"""章节生命周期、清单迁移和连续性规则。"""
from __future__ import annotations

import hashlib
from copy import deepcopy


MANIFEST_VERSION = 1
STATUS_MISSING = "missing"
STATUS_DRAFT = "draft"
STATUS_FINALIZED = "finalized"
STATUS_DRAFT_MODIFIED = "draft_modified"
STATUS_STALE = "stale"
STATUS_INDEX_PENDING = "index_pending"

ACTIVE_STATUSES = {STATUS_DRAFT, STATUS_FINALIZED, STATUS_DRAFT_MODIFIED, STATUS_INDEX_PENDING}
FINAL_STATUSES = {STATUS_FINALIZED, STATUS_INDEX_PENDING}


class ChapterStateError(RuntimeError):
    pass


class ChapterContinuityError(ChapterStateError):
    pass


def empty_manifest() -> dict:
    return {"version": MANIFEST_VERSION, "chapters": {}}


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def default_record(status: str = STATUS_DRAFT, content: str = "") -> dict:
    return {
        "status": status,
        "content_hash": content_hash(content) if content else "",
        "finalized_at": "",
        "state_snapshot": "",
        "indexed": False,
        "downstream_stale": False,
    }


def normalize_manifest(manifest: dict | None) -> dict:
    source = manifest if isinstance(manifest, dict) else empty_manifest()
    chapters = source.get("chapters", {})
    normalized = empty_manifest()
    if not isinstance(chapters, dict):
        return normalized
    for key, record in chapters.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        if number < 1 or not isinstance(record, dict):
            continue
        merged = default_record(record.get("status", STATUS_DRAFT))
        merged.update(record)
        normalized["chapters"][str(number)] = merged
    return normalized


def migrate_manifest(repository) -> dict:
    """首次打开旧工程时从章节文件生成保守的 draft 清单。"""
    existing = repository.read_json("chapter_manifest.json")
    if isinstance(existing, dict):
        return normalize_manifest(existing)
    manifest = empty_manifest()
    for number in repository.list_chapters():
        manifest["chapters"][str(number)] = default_record(
            STATUS_DRAFT,
            repository.read_chapter(number),
        )
    if not repository.write_json("chapter_manifest.json", manifest):
        raise ChapterStateError("无法初始化 chapter_manifest.json")
    return manifest


def find_max_contiguous_chapter(chapters: list[int] | set[int]) -> int:
    numbers = {number for number in chapters if number > 0}
    current = 0
    while current + 1 in numbers:
        current += 1
    return current


def active_chapter_numbers(manifest: dict) -> list[int]:
    return sorted(
        int(number)
        for number, record in manifest["chapters"].items()
        if record.get("status") in ACTIVE_STATUSES
    )


def validate_chapter_target(manifest: dict, target: int) -> str:
    if target < 1:
        raise ChapterContinuityError("章节号必须大于 0")
    if any(record.get("status") == STATUS_STALE for record in manifest["chapters"].values()):
        raise ChapterContinuityError("存在状态失效章节，完成重建前不能继续生成")
    max_contiguous = find_max_contiguous_chapter(active_chapter_numbers(manifest))
    if target <= max_contiguous:
        return "rewrite"
    if target == max_contiguous + 1:
        return "append"
    raise ChapterContinuityError(
        f"章节不连续：当前最大连续章节为第 {max_contiguous} 章，只能生成第 {max_contiguous + 1} 章"
    )


def save_draft(manifest: dict, chapter_number: int, content: str) -> dict:
    updated = deepcopy(normalize_manifest(manifest))
    records = updated["chapters"]
    key = str(chapter_number)
    old_status = records.get(key, {}).get("status", STATUS_MISSING)
    status = STATUS_DRAFT_MODIFIED if old_status in FINAL_STATUSES else STATUS_DRAFT
    record = default_record(status, content)
    record.update(records.get(key, {}))
    record["status"] = status
    record["content_hash"] = content_hash(content)
    records[key] = record

    if old_status in FINAL_STATUSES:
        for number, downstream in records.items():
            if int(number) > chapter_number and downstream.get("status") in FINAL_STATUSES:
                downstream["status"] = STATUS_STALE
                downstream["downstream_stale"] = True
    return updated
