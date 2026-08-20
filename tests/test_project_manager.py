import json

import pytest

from services.project_manager import ProjectBusyError, ProjectManager


class BusyTaskController:
    def is_running(self):
        return True

    def cancel(self):
        return True

    def wait_for_idle(self, _timeout):
        return False


def test_open_legacy_project_migrates_other_params(tmp_path):
    project_dir = tmp_path / "novel-a"
    project_dir.mkdir()
    config_file = tmp_path / "config.json"
    global_config = {
        "other_params": {"filepath": str(project_dir), "topic": "星海", "chapter_num": "3"},
        "recent_projects": [],
    }
    manager = ProjectManager(global_config, str(config_file))

    project = manager.open_project(str(project_dir), global_config["other_params"])

    assert project["version"] == 1
    assert project["topic"] == "星海"
    assert project["current_chapter"] == 3
    assert global_config["current_project"] == str(project_dir.resolve())
    assert "other_params" not in global_config
    assert json.loads((project_dir / "project.json").read_text(encoding="utf-8"))["topic"] == "星海"


def test_projects_keep_independent_settings(tmp_path):
    config_file = tmp_path / "config.json"
    manager = ProjectManager({"recent_projects": []}, str(config_file))
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"

    manager.create_project(str(first_dir), {"topic": "A"})
    manager.create_project(str(second_dir), {"topic": "B"})

    assert manager.open_project(str(first_dir))["topic"] == "A"
    assert manager.open_project(str(second_dir))["topic"] == "B"


def test_switch_refuses_when_task_does_not_stop(tmp_path):
    project_dir = tmp_path / "novel"
    project_dir.mkdir()
    manager = ProjectManager({}, str(tmp_path / "config.json"), BusyTaskController())

    with pytest.raises(ProjectBusyError):
        manager.switch_project(str(project_dir))
