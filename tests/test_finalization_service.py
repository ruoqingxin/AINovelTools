# -*- coding: utf-8 -*-
import json

import pytest

from domain.chapter_state import STATUS_FINALIZED, STATUS_INDEX_PENDING, default_record
from services.finalization_service import ChapterFinalizationService
from services.project_repository import NovelProjectRepository


def test_atomic_finalization_writes_snapshot_and_manifest(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    repository.write_json("chapter_manifest.json", {"version": 1, "chapters": {"1": default_record()}})

    result = ChapterFinalizationService(repository).finalize(1, "正文", "摘要", "角色", "剧情")

    record = repository.read_json("chapter_manifest.json")["chapters"]["1"]
    assert result["changed"] is True
    assert record["status"] == STATUS_FINALIZED
    assert record["state_snapshot"] == "chapter_states/chapter_1.json"
    assert repository.read_json(record["state_snapshot"])["global_summary"] == "摘要"
    assert repository.read_chapter(1) == "正文"


def test_finalization_failure_does_not_commit_partial_files(tmp_path):
    class FailingRepository(NovelProjectRepository):
        def write_many(self, files):
            raise OSError("injected failure")

    repository = FailingRepository(tmp_path)
    repository.write_text("global_summary.txt", "旧摘要")

    with pytest.raises(OSError):
        ChapterFinalizationService(repository).finalize(1, "正文", "新摘要", "角色", "剧情")

    assert repository.read_text("global_summary.txt") == "旧摘要"
    assert repository.read_chapter(1) == ""


def test_index_failure_marks_pending_and_same_hash_is_idempotent(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    service = ChapterFinalizationService(repository)

    first = service.finalize(1, "正文", "摘要", "角色", "剧情", lambda _text: False)
    second = service.finalize(1, "正文", "不同摘要", "不同角色", "不同剧情")

    assert first["status"] == STATUS_INDEX_PENDING
    assert second["changed"] is False
    assert repository.read_text("global_summary.txt") == "摘要"


def test_rewriting_chapter_marks_later_finalized_chapters_stale(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    service = ChapterFinalizationService(repository)
    service.finalize(1, "第一版", "摘要1", "角色1", "剧情1")
    service.finalize(2, "第二章", "摘要2", "角色2", "剧情2")

    service.finalize(1, "第一章重写", "新摘要", "新角色", "新剧情")

    manifest = repository.read_json("chapter_manifest.json")
    assert manifest["chapters"]["2"]["status"] == "stale"


def test_pending_index_can_be_rebuilt(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    service = ChapterFinalizationService(repository)
    service.finalize(1, "正文", "摘要", "角色", "剧情", lambda _text: False)

    assert service.rebuild_index(1, lambda text: text == "正文") is True
    assert repository.read_json("chapter_manifest.json")["chapters"]["1"]["status"] == STATUS_FINALIZED


def test_recovery_rolls_back_interrupted_multi_file_commit(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    repository.write_text("global_summary.txt", "新摘要")
    tx_root = repository.path_for(".transactions/interrupted")
    backup = tx_root / "backup/global_summary.txt"
    backup.parent.mkdir(parents=True)
    backup.write_text("旧摘要", encoding="utf-8")
    (tx_root / "journal.json").write_text(json.dumps({
        "status": "committing",
        "files": [{"name": "global_summary.txt", "existed": True}],
    }), encoding="utf-8")

    repository.recover_transactions()

    assert repository.read_text("global_summary.txt") == "旧摘要"
    assert not tx_root.exists()
