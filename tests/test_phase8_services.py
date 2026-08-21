# -*- coding: utf-8 -*-
import json

import pytest

from services.chapter_context import ChapterContextBuilder
from services.project_repository import NovelProjectRepository
from services.project_manager import ProjectManager
from services.role_library_service import RoleLibraryService
from services.skill_service import SkillService


def test_role_library_migrates_all_to_real_uncategorized_directory(tmp_path):
    legacy = tmp_path / "角色库" / "全部"
    legacy.mkdir(parents=True)
    (legacy / "主角.txt").write_text("主角资料", encoding="utf-8")
    service = RoleLibraryService(tmp_path)

    service.initialize()

    assert service.categories()[0] == "全部"
    assert (tmp_path / "角色库" / "未分类" / "主角.txt").read_text(encoding="utf-8") == "主角资料"
    assert not legacy.exists()


def test_role_save_is_atomic_and_all_maps_to_uncategorized(tmp_path):
    service = RoleLibraryService(tmp_path)
    path = service.save("全部", "主角", "第一版")
    service.save("未分类", "主角", "第二版")

    assert path.parent.name == "未分类"
    assert path.read_text(encoding="utf-8") == "第二版"
    with pytest.raises(ValueError):
        service.save("../外部", "主角", "非法")

    renamed = service.rename("未分类", "主角", "主角二", "改名内容")
    assert renamed.read_text(encoding="utf-8") == "改名内容"
    assert not path.exists()


def test_selected_project_skills_are_resolved_into_chapter_context(tmp_path):
    skill_dir = tmp_path / "skills"
    skill_dir.mkdir()
    (skill_dir / "pace.json").write_text(json.dumps({
        "id": "pace", "name": "节奏", "content": "保持紧凑节奏",
    }, ensure_ascii=False), encoding="utf-8")
    repository = NovelProjectRepository(tmp_path / "novel")
    builder = ChapterContextBuilder(repository, SkillService({"skill_library_path": str(skill_dir)}))

    context = builder.build({"selected_skill_ids": ["pace", "missing"]}, 1)

    assert context.writing_skills == "保持紧凑节奏"


def test_projects_keep_independent_selected_skill_ids(tmp_path):
    manager = ProjectManager({"recent_projects": []}, str(tmp_path / "config.json"))
    first = tmp_path / "first"
    second = tmp_path / "second"
    manager.create_project(str(first), {"selected_skill_ids": ["pace"]})
    manager.create_project(str(second), {"selected_skill_ids": ["dialogue"]})

    assert manager.open_project(str(first))["selected_skill_ids"] == ["pace"]
    assert manager.open_project(str(second))["selected_skill_ids"] == ["dialogue"]
