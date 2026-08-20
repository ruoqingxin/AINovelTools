# -*- coding: utf-8 -*-
from domain.outline_workflow import DEFAULT_STEP_DEFINITIONS
from services.outline_service import OutlineService
from services.project_repository import NovelProjectRepository


def test_empty_workflow_has_34_stable_steps(tmp_path):
    service = OutlineService(NovelProjectRepository(tmp_path))

    workflow = service.load_workflow()

    assert len(workflow["steps"]) == 34
    assert [step["id"] for step in workflow["steps"]] == [item[0] for item in DEFAULT_STEP_DEFINITIONS]
    assert all(step["status"] == "pending" for step in workflow["steps"])


def test_legacy_architecture_migrates_without_losing_content(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    repository.write_text("Novel_architecture.txt", "旧版架构内容")

    workflow = OutlineService(repository).load_workflow()

    migrated = next(step for step in workflow["steps"] if step["id"] == "legacy_architecture")
    assert migrated["content"] == "旧版架构内容"
    assert migrated["status"] == "confirmed"


def test_render_skips_empty_disabled_and_drafts_by_default(tmp_path):
    service = OutlineService(NovelProjectRepository(tmp_path))
    service.load_workflow()
    service.save_step_draft("story_premise", "草稿内容")
    service.save_step_draft("theme", "确认内容")
    service.confirm_step("theme")

    assert "确认内容" in service.render_architecture()
    assert "草稿内容" not in service.render_to_string()
    assert "草稿内容" in service.render_to_string(include_drafts=True)


def test_workflow_rebuilds_deleted_render_file(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    service = OutlineService(repository)
    service.load_workflow()
    service.save_step_draft("story_premise", "可重建内容")
    service.confirm_step("story_premise")

    service.render_architecture()
    repository.path_for("Novel_architecture.txt").unlink()
    service.render_architecture()

    assert repository.read_text("Novel_architecture.txt") == service.render_to_string()
    assert "可重建内容" in repository.read_text("Novel_architecture.txt")


def test_ai_import_creates_draft_step(tmp_path):
    service = OutlineService(NovelProjectRepository(tmp_path))
    service.import_ai_steps({"ai_quick_generation": "AI 生成内容"})

    step = service.get_step("ai_quick_generation")
    assert step["content"] == "AI 生成内容"
    assert step["status"] == "draft"
    assert "AI 生成内容" not in service.render_to_string()
