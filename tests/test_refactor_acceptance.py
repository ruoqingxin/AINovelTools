# -*- coding: utf-8 -*-
import logging

import pytest

from domain.chapter_state import ChapterContinuityError, STATUS_STALE
from services.blueprint_service import BlueprintService
from services.chapter_service import ChapterService
from services.finalization_service import ChapterFinalizationService
from services.outline_service import OutlineService
from services.project_manager import ProjectManager
from services.task_controller import TaskController


def _chapter(number):
    return {
        "chapter_number": number,
        "chapter_title": f"章节{number}",
        "chapter_role": "推进",
        "chapter_purpose": "推进主线",
        "suspense_level": "中",
        "foreshadowing": "伏笔",
        "plot_twist_level": "低",
        "chapter_summary": f"第{number}章概要",
    }


def test_refactor_core_workflow_end_to_end(tmp_path):
    manager = ProjectManager({"recent_projects": []}, str(tmp_path / "config.json"))
    project_dir = tmp_path / "novel"
    manager.create_project(str(project_dir), {"name": "验收小说", "num_chapters": 6})
    repository = manager.repository

    outline = OutlineService(repository)
    outline.save_step_draft("story_premise", "主角必须阻止灾难")
    outline.confirm_step("story_premise")
    outline.render_architecture()
    repository.path_for("Novel_architecture.txt").unlink()
    assert "主角必须阻止灾难" in outline.render_architecture()

    blueprint = BlueprintService(repository)
    blueprint.save_volume_plan({
        "mode": "manual_count",
        "volumes": [
            {"number": number, "start_chapter": number, "end_chapter": number}
            for number in range(1, 7)
        ],
    }, 6)
    blueprint.save_full([_chapter(number) for number in range(1, 7)], 6)

    chapters = ChapterService(repository)
    finalizer = ChapterFinalizationService(repository)
    for number in range(1, 4):
        assert chapters.validate_target(number) == "append"
        text = f"第{number}章正文"
        chapters.save_draft(number, text)
        result = finalizer.finalize(number, text, f"摘要{number}", f"角色{number}", f"剧情{number}")
        assert result["changed"] is True

    assert finalizer.finalize(3, "第3章正文", "不会写入", "不会写入", "不会写入")["changed"] is False
    chapters.save_draft(2, "第二章重写")
    finalizer.finalize(2, "第二章重写", "重建摘要", "重建角色", "重建剧情")
    assert chapters.load_manifest()["chapters"]["3"]["status"] == STATUS_STALE
    with pytest.raises(ChapterContinuityError):
        chapters.validate_target(4)


def test_task_logs_structured_context_without_configuration(caplog):
    controller = TaskController()
    with caplog.at_level(logging.INFO):
        handle = controller.run("acceptance", lambda _cancel: "ok")
        handle.thread.join(2)

    log_text = caplog.text
    assert "task_id=acceptance project_id=none chapter=none" in log_text
    assert "api_key" not in log_text.lower()

    def fail_with_secret(_cancel):
        raise RuntimeError("api_key=should-not-appear")

    caplog.clear()
    with caplog.at_level(logging.INFO):
        failed = controller.run("failure", fail_with_secret)
        failed.thread.join(2)
    assert "error_type=RuntimeError" in caplog.text
    assert "should-not-appear" not in caplog.text
