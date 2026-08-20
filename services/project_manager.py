# -*- coding: utf-8 -*-
"""小说工程创建、打开、切换及旧配置迁移。"""
from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path

from config_manager import save_config
from services.chapter_service import ChapterService
from services.blueprint_service import BlueprintService
from services.project_repository import NovelProjectRepository


PROJECT_VERSION = 1
MAX_RECENT_PROJECTS = 10

DEFAULT_PROJECT_CONFIG = {
    "version": PROJECT_VERSION,
    "name": "",
    "topic": "",
    "genre": "玄幻",
    "num_chapters": 10,
    "word_number": 3000,
    "current_chapter": 1,
    "planning_guidance": "",
    "chapter_guidance": "",
    "blueprint_mode": "range",
    "volume_mode": "none",
    "volume_count": 0,
    "current_volume": 1,
    "selected_skill_ids": [],
    "characters_involved": "",
    "key_items": "",
    "scene_location": "",
    "time_constraint": "",
}


class ProjectError(RuntimeError):
    pass


class ProjectBusyError(ProjectError):
    pass


class ProjectManager:
    def __init__(self, global_config: dict, config_file: str, task_controller=None):
        self.global_config = global_config
        self.config_file = config_file
        self.task_controller = task_controller
        self.repository: NovelProjectRepository | None = None
        self.project: dict | None = None

    @property
    def current_path(self) -> str:
        return str(self.repository.root) if self.repository else ""

    def create_project(self, project_path: str, initial_config: dict | None = None) -> dict:
        root = Path(project_path).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        repository = NovelProjectRepository(root)
        if repository.path_for("project.json").exists():
            raise ProjectError(f"工程已存在: {root}")
        project = self._normalize_project(initial_config or {}, root.name)
        if not repository.write_json("project.json", project):
            raise ProjectError(f"无法创建工程配置: {root}")
        self._activate(repository, project)
        return deepcopy(project)

    def open_project(self, project_path: str, legacy_params: dict | None = None) -> dict:
        root = Path(project_path).expanduser().resolve()
        if not root.is_dir():
            raise ProjectError(f"工程目录不存在: {root}")
        repository = NovelProjectRepository(root)
        project_path_obj = repository.path_for("project.json")
        if project_path_obj.exists():
            project = repository.read_json("project.json")
            if not isinstance(project, dict):
                raise ProjectError("project.json 格式无效")
            project = self._normalize_project(project, root.name)
        else:
            project = self._migrate_legacy_params(legacy_params or {}, root.name)
            if not repository.write_json("project.json", project):
                raise ProjectError("旧工程迁移失败，未写入 project.json")
        self._activate(repository, project)
        return deepcopy(project)

    def switch_project(self, project_path: str, legacy_params: dict | None = None) -> dict:
        if self.task_controller and self.task_controller.is_running():
            self.task_controller.cancel()
            if not self.task_controller.wait_for_idle(5):
                raise ProjectBusyError("后台任务未能及时结束，工程未切换")
        return self.open_project(project_path, legacy_params)

    def save_project(self, values: dict) -> bool:
        if not self.repository:
            raise ProjectError("尚未打开小说工程")
        project = self._normalize_project(values, self.repository.root.name)
        if not self.repository.write_json("project.json", project):
            return False
        self.project = project
        return True

    def close_project(self):
        self.repository = None
        self.project = None

    def _activate(self, repository: NovelProjectRepository, project: dict):
        ChapterService(repository).load_manifest()
        BlueprintService(repository).load_blueprint()
        BlueprintService(repository).load_volume_plan()
        self.repository = repository
        self.project = project
        path = str(repository.root)
        recent = [path]
        for item in self.global_config.get("recent_projects", []):
            normalized = os.path.normcase(os.path.abspath(item))
            if normalized != os.path.normcase(path):
                recent.append(str(Path(item).expanduser().resolve()))
        self.global_config["current_project"] = path
        self.global_config["recent_projects"] = recent[:MAX_RECENT_PROJECTS]
        self.global_config.pop("other_params", None)
        if not save_config(self.global_config, self.config_file):
            raise ProjectError("无法保存当前工程记录")

    @staticmethod
    def _migrate_legacy_params(legacy: dict, project_name: str) -> dict:
        migrated = {
            "name": project_name,
            "topic": legacy.get("topic", ""),
            "genre": legacy.get("genre", "玄幻"),
            "num_chapters": legacy.get("num_chapters", 10),
            "word_number": legacy.get("word_number", 3000),
            "current_chapter": legacy.get("chapter_num", 1),
            "chapter_guidance": legacy.get("user_guidance", ""),
            "characters_involved": legacy.get("characters_involved", ""),
            "key_items": legacy.get("key_items", ""),
            "scene_location": legacy.get("scene_location", ""),
            "time_constraint": legacy.get("time_constraint", ""),
        }
        return ProjectManager._normalize_project(migrated, project_name)

    @staticmethod
    def _normalize_project(values: dict, project_name: str) -> dict:
        project = deepcopy(DEFAULT_PROJECT_CONFIG)
        project.update({key: value for key, value in values.items() if key in project})
        project["version"] = PROJECT_VERSION
        project["name"] = str(project.get("name") or project_name)
        for key, default in (("num_chapters", 10), ("word_number", 3000),
                             ("current_chapter", 1), ("volume_count", 0),
                             ("current_volume", 1)):
            try:
                project[key] = int(project[key])
            except (TypeError, ValueError):
                project[key] = default
        if not isinstance(project.get("selected_skill_ids"), list):
            project["selected_skill_ids"] = []
        return project
