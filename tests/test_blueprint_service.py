import pytest

from domain.blueprint import BlueprintValidationError, validate_volume_plan
from services.blueprint_service import BlueprintService
from services.project_repository import NovelProjectRepository


def chapter(number):
    return {
        "chapter_number": number,
        "chapter_title": f"第{number}章",
        "chapter_role": "推进",
        "chapter_purpose": "推进剧情",
        "suspense_level": "中",
        "foreshadowing": "伏笔",
        "plot_twist_level": "低",
        "chapter_summary": "章节概要",
    }


def test_volume_plan_requires_continuous_full_coverage():
    plan = {
        "mode": "manual_count",
        "volumes": [
            {"number": 1, "start_chapter": 1, "end_chapter": 2},
            {"number": 2, "start_chapter": 3, "end_chapter": 5},
        ],
    }
    assert validate_volume_plan(plan, 5) == []

    plan["volumes"][1]["start_chapter"] = 4
    assert validate_volume_plan(plan, 5)


def test_blueprint_range_replacement_preserves_other_chapters(tmp_path):
    service = BlueprintService(NovelProjectRepository(tmp_path))
    service.save_full([chapter(1), chapter(2), chapter(3), chapter(4)], 4)
    replacement = chapter(2)
    replacement["chapter_title"] = "替换章节"

    service.replace_range(2, 2, [replacement], 4)

    result = service.load_blueprint()["chapters"]
    assert [entry["chapter_number"] for entry in result] == [1, 2, 3, 4]
    assert result[1]["chapter_title"] == "替换章节"
    assert "替换章节" in service.repository.read_text("Novel_directory.txt")


def test_blueprint_rejects_missing_required_fields_without_overwrite(tmp_path):
    service = BlueprintService(NovelProjectRepository(tmp_path))
    service.save_full([chapter(1)], 1)
    invalid = chapter(1)
    invalid["chapter_summary"] = ""

    with pytest.raises(BlueprintValidationError):
        service.save_full([invalid], 1)

    assert service.load_blueprint()["chapters"][0]["chapter_summary"] == "章节概要"


def test_legacy_text_migrates_and_manual_save_is_validated(tmp_path):
    repository = NovelProjectRepository(tmp_path)
    service = BlueprintService(repository)
    text = BlueprintService.render([chapter(1)])
    repository.write_text("Novel_directory.txt", text)

    assert service.load_blueprint()["chapters"][0]["chapter_title"] == "第1章"
    service.save_legacy_text(text, 1)
