import threading
import time

import pytest

from services.model_config import get_task_llm_config, llm_call_kwargs
from services.project_repository import NovelProjectRepository, RepositoryPathError
from services.task_controller import TaskAlreadyRunning, TaskController


def sample_config():
    llm = {
        "interface_format": "OpenAI",
        "api_key": "key",
        "base_url": "https://example.test/v1",
        "model_name": "model",
        "temperature": 0.7,
        "max_tokens": 100,
        "timeout": 10,
    }
    return {"llm_configs": {"test": llm}, "choose_configs": {"chapter_llm": "test"}}


def test_model_config_resolves_task_and_filters_fields():
    config = sample_config()
    resolved = get_task_llm_config(config, "chapter_llm")

    assert llm_call_kwargs(resolved) == resolved


def test_repository_round_trips_json_and_chapters(tmp_path):
    repository = NovelProjectRepository(tmp_path)

    assert repository.write_json("project.json", {"version": 1}) is True
    assert repository.read_json("project.json") == {"version": 1}
    assert repository.write_chapter(2, "第二章") is True
    assert repository.read_chapter(2) == "第二章"
    assert repository.list_chapters() == [2]


def test_repository_rejects_path_escape(tmp_path):
    repository = NovelProjectRepository(tmp_path)

    with pytest.raises(RepositoryPathError):
        repository.path_for("../outside.txt")


def test_task_controller_enforces_single_active_task():
    controller = TaskController()
    release = threading.Event()

    controller.run("first", lambda _cancel: release.wait(1))
    with pytest.raises(TaskAlreadyRunning):
        controller.run("second", lambda _cancel: None)

    controller.cancel("first")
    release.set()
    assert controller.wait_for_idle(1) is True
