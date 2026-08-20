import json

import pytest

from domain.chapter_state import (
    ChapterContinuityError,
    STATUS_DRAFT,
    STATUS_FINALIZED,
    STATUS_STALE,
    find_max_contiguous_chapter,
    migrate_manifest,
    save_draft,
    validate_chapter_target,
)
from services.chapter_context import ChapterContextBuilder
from services.chapter_service import ChapterService
from services.project_repository import NovelProjectRepository


def test_continuity_uses_first_gap_not_largest_chapter_number():
    assert find_max_contiguous_chapter([1, 2, 3, 5, 6]) == 3
    manifest = {"version": 1, "chapters": {str(number): {"status": STATUS_DRAFT} for number in [1, 2, 3, 5, 6]}}

    assert validate_chapter_target(manifest, 3) == "rewrite"
    assert validate_chapter_target(manifest, 4) == "append"
    with pytest.raises(ChapterContinuityError):
        validate_chapter_target(manifest, 5)


def test_legacy_chapters_migrate_as_drafts(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    repository.write_chapter(1, "第一章")
    repository.write_chapter(2, "第二章")

    manifest = migrate_manifest(repository)

    assert manifest["chapters"]["1"]["status"] == STATUS_DRAFT
    assert manifest["chapters"]["2"]["status"] == STATUS_DRAFT
    assert repository.read_json("chapter_manifest.json")["version"] == 1


def test_editing_finalized_chapter_marks_downstream_stale():
    manifest = {
        "version": 1,
        "chapters": {
            "1": {"status": STATUS_FINALIZED},
            "2": {"status": STATUS_FINALIZED},
            "3": {"status": STATUS_FINALIZED},
        },
    }

    updated = save_draft(manifest, 2, "修改后的第二章")

    assert updated["chapters"]["2"]["status"] == "draft_modified"
    assert updated["chapters"]["3"]["status"] == STATUS_STALE
    with pytest.raises(ChapterContinuityError):
        validate_chapter_target(updated, 4)


def test_chapter_service_saves_draft_and_updates_manifest(tmp_path):
    service = ChapterService(NovelProjectRepository(tmp_path))

    service.save_draft(1, "草稿正文")

    assert service.repository.read_chapter(1) == "草稿正文"
    assert service.load_manifest()["chapters"]["1"]["status"] == STATUS_DRAFT
    assert service.next_appendable() == 2


def test_context_builder_collects_project_files_and_role_profiles(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    repository.write_text("Novel_architecture.txt", "架构")
    repository.write_text("global_summary.txt", "摘要")
    repository.write_text("character_state.txt", "角色状态")
    repository.write_text("plot_arcs.txt", "剧情线")
    repository.write_text(
        "Novel_directory.txt",
        "第1章 - 开端\n章节定位：开篇\n核心作用：引入冲突\n章节简述：主角出场\n",
    )
    repository.write_chapter(1, "第一章正文")
    repository.write_text("角色库/主角.txt", "主角资料")

    context = ChapterContextBuilder(repository).build(
        {"characters_involved": "主角"},
        2,
    )

    assert context.architecture == "架构"
    assert context.global_summary == "摘要"
    assert context.current_blueprint["chapter_number"] == 2
    assert context.recent_chapters == ("第一章正文",)
    assert context.role_profiles == "主角资料"
