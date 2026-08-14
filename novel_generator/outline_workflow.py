"""Step-by-step outline confirmation workflow.

The workflow is intentionally file-backed so an interrupted session can be
resumed without depending on the GUI or an LLM being available.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

from .storage import NovelProjectRepository


OUTLINE_STEPS = (
    "题材类型", "核心主题", "核心矛盾", "世界起源", "世界底层规则", "世界空间结构",
    "地理与自然环境", "资源分布", "种族与生物", "力量或技术体系", "生产方式",
    "人口与聚居方式", "交通与通信", "经济体系", "职业体系", "阶级结构",
    "家庭与教育", "势力组织", "政治制度", "法律体系", "军事体系", "势力关系",
    "历史背景", "文化习俗", "宗教信仰", "社会价值观", "当前世界局势", "世界核心矛盾",
    "主角身份", "主角目标", "反派与阻力", "故事主线", "分卷大纲", "章节大纲",
)
WORKFLOW_FILE = "outline_workflow.json"


def outline_adapter_kwargs(config: dict) -> dict:
    """Return only fields accepted by the LLM adapter factory."""
    return {
        "interface_format": config["interface_format"],
        "base_url": config["base_url"],
        "model_name": config["model_name"],
        "api_key": config.get("api_key", ""),
        "temperature": config["temperature"],
        "max_tokens": config["max_tokens"],
        "timeout": config["timeout"],
    }


def extract_step_content(text: str, title: str) -> str:
    """Extract a matching Markdown/plain heading block from source material."""
    source = str(text or "").strip()
    if not source:
        return ""
    escaped = re.escape(str(title).strip())
    pattern = re.compile(
        rf"(?ims)^\s*(?:#+\s*)?(?:\d+[.)、]?\s*)?{escaped}\s*[:：]?\s*$"
    )
    match = pattern.search(source)
    if not match:
        return source
    body_start = match.end()
    next_heading = re.search(r"(?im)^\s*#{1,6}\s+.+$", source[body_start:])
    body_end = body_start + next_heading.start() if next_heading else len(source)
    return source[body_start:body_end].strip()


def normalize_step_content(content: str, title: str) -> str:
    """Store section prose without duplicating the workflow heading."""
    value = str(content or "").strip()
    if not value:
        return ""
    first, *rest = value.splitlines()
    heading = re.sub(r"^\s*#+\s*", "", first).strip()
    heading = re.sub(r"^\d+[.)、]?\s*", "", heading).strip()
    if heading.rstrip("：:").strip() == str(title).strip():
        return "\n".join(rest).strip()
    return value


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class OutlineWorkflow:
    """Persistent state machine for confirming each outline step."""

    def __init__(self, project_path: str | Path):
        self.repository = NovelProjectRepository(project_path)
        self.path = self.repository.path(WORKFLOW_FILE)
        self.data = self._load()

    def _load(self) -> dict:
        self.repository.ensure_exists()
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("steps"):
                    return self._merge_defaults(data)
            except (OSError, ValueError, TypeError):
                pass
        return self._new_data()

    @staticmethod
    def _new_data() -> dict:
        return {
            "version": 1,
            "created_at": _now(),
            "updated_at": _now(),
            "finalized": False,
            "custom_sections": [],
            "steps": [
                {"index": i + 1, "title": title, "content": "", "source": "",
                 "status": "pending", "history": []}
                for i, title in enumerate(OUTLINE_STEPS)
            ],
        }

    @classmethod
    def _merge_defaults(cls, data: dict) -> dict:
        fresh = cls._new_data()
        old = {int(item.get("index", 0)): item for item in data.get("steps", [])
               if isinstance(item, dict)}
        for item in fresh["steps"]:
            if item["index"] in old:
                item.update(old[item["index"]])
        fresh.update({k: data[k] for k in ("version", "created_at", "finalized") if k in data})
        fresh["custom_sections"] = data.get("custom_sections", []) if isinstance(data.get("custom_sections", []), list) else []
        for custom in fresh["custom_sections"]:
            custom.setdefault("content", "")
            custom.setdefault("status", "draft" if custom["content"] else "pending")
            custom.setdefault("history", [])
        fresh["updated_at"] = data.get("updated_at", _now())
        return fresh

    def save(self) -> None:
        self.data["updated_at"] = _now()
        self.repository.write(WORKFLOW_FILE, json.dumps(self.data, ensure_ascii=False, indent=2))

    def step(self, index: int) -> dict:
        if not 1 <= int(index) <= len(OUTLINE_STEPS):
            raise IndexError("大纲步骤编号必须在 1-34 之间")
        return self.data["steps"][int(index) - 1]

    def current_index(self) -> int:
        for item in self.data["steps"]:
            if item["status"] != "confirmed":
                return item["index"]
        return len(OUTLINE_STEPS)

    def update(self, index: int, content: str, source: str = "manual") -> dict:
        item = self.step(index)
        content = normalize_step_content(content, item["title"])
        was_confirmed = item["status"] == "confirmed"
        changed = item["content"] != content
        item["content"] = content
        item["source"] = source or "manual"
        if was_confirmed and not changed:
            # Saving an unchanged confirmed section must not silently revoke
            # its confirmation or remove it from later AI context.
            item["status"] = "confirmed"
        else:
            item["status"] = "draft" if content else "pending"
        if was_confirmed and changed:
            # Later sections were derived from this confirmed premise and must
            # be reviewed again when that premise changes.
            for later in self.data["steps"][int(index):]:
                if later["status"] == "confirmed":
                    later["status"] = "draft" if later["content"] else "pending"
            self.data["finalized"] = False
        item["history"].append({"at": _now(), "action": "update", "source": item["source"], "content": content})
        self.save()
        return item

    def confirm(self, index: int, content: Optional[str] = None) -> dict:
        item = self.step(index)
        index = int(index)
        if content is not None:
            self.update(index, content, item.get("source") or "manual")
        if not item["content"].strip():
            raise ValueError("确认前请先填写本步内容")
        item["status"] = "confirmed"
        item["confirmed_at"] = _now()
        item["history"].append({"at": _now(), "action": "confirm", "content": item["content"]})
        self.data["finalized"] = all(s["status"] == "confirmed" for s in self.data["steps"])
        self.save()
        self.write_confirmed_sections()
        return item

    def unconfirm(self, index: int) -> dict:
        item = self.step(index)
        item["status"] = "draft" if item["content"] else "pending"
        item["history"].append({"at": _now(), "action": "unconfirm"})
        self.data["finalized"] = False
        self.save()
        return item

    def set_from_file(self, index: int, file_path: str | Path,
                      extractor: Optional[Callable[[str, str], str]] = None) -> dict:
        text = Path(file_path).read_text(encoding="utf-8")
        content = extractor(text, self.step(index)["title"]) if extractor else extract_step_content(text, self.step(index)["title"])
        return self.update(index, content, "file_extract")

    def set_from_ai(self, index: int, generator: Callable[[str, Iterable[dict]], str]) -> dict:
        prior = self.confirmed_context(index)
        content = generator(self.step(index)["title"], prior)
        return self.update(index, content, "ai_derive")

    def confirmed_context(self, index: int) -> list[dict]:
        prior = [item for item in self.data["steps"][:int(index) - 1] if item["status"] == "confirmed"]
        for custom in self.data.get("custom_sections", []):
            if custom.get("status") != "confirmed" or not str(custom.get("content", "")).strip():
                continue
            prior.append({
                "index": custom.get("id", "custom"),
                "title": custom.get("title", "自定义分区"),
                "content": custom.get("content", ""),
                "status": "confirmed",
                "source": "custom",
            })
        return prior

    def finalize(self) -> Path:
        if not self.data["finalized"]:
            raise ValueError("还有未确认的大纲步骤")
        lines = ["# 小说大纲（34 个分区确认定稿）", ""]
        for item in self.data["steps"]:
            lines.extend([f"## {item['index']}. {item['title']}", item["content"].strip(), ""])
        confirmed_custom = [item for item in self.data.get("custom_sections", []) if item.get("status") == "confirmed"]
        if confirmed_custom:
            lines.extend(["# 用户自定义分区", ""])
            for item in confirmed_custom:
                lines.extend([f"## {item['title']}", item.get("content", "").strip(), ""])
        return self.repository.write(NovelProjectRepository.ARCHITECTURE, "\n".join(lines).rstrip() + "\n")

    def write_confirmed_sections(self) -> Path:
        """Persist the confirmed portion so every confirmation is recoverable."""
        lines = ["# 小说大纲（分区确认中）", ""]
        for item in self.data["steps"]:
            if item["status"] != "confirmed":
                continue
            lines.extend([f"## {item['index']}. {item['title']}", item["content"].strip(), ""])
        confirmed_custom = [item for item in self.data.get("custom_sections", []) if item.get("status") == "confirmed"]
        if confirmed_custom:
            lines.extend(["# 用户自定义分区", ""])
            for item in confirmed_custom:
                lines.extend([f"## {item['title']}", item.get("content", "").strip(), ""])
        return self.repository.write(NovelProjectRepository.ARCHITECTURE, "\n".join(lines).rstrip() + "\n")

    def add_custom_section(self, title: str, content: str = "") -> dict:
        title = str(title or "").strip()
        if not title:
            raise ValueError("自定义分区标题不能为空")
        existing = self.data.setdefault("custom_sections", [])
        value = str(content or "")
        item = {"id": f"custom-{len(existing) + 1}", "title": title,
                "content": value, "status": "draft" if value else "pending",
                "history": [], "created_at": _now(), "updated_at": _now()}
        existing.append(item)
        self.save()
        return item

    def custom_section(self, section_id: str) -> dict:
        for item in self.data.setdefault("custom_sections", []):
            if item.get("id") == section_id:
                return item
        raise KeyError("自定义分区不存在")

    def update_custom_section(self, section_id: str, content: str) -> dict:
        item = self.custom_section(section_id)
        value = str(content or "")
        was_confirmed = item.get("status") == "confirmed"
        changed = item.get("content", "") != value
        item["content"] = value
        item["status"] = "confirmed" if was_confirmed and not changed else ("draft" if value else "pending")
        item["updated_at"] = _now()
        item.setdefault("history", []).append({"at": _now(), "action": "update", "content": value})
        self.save()
        return item

    def confirm_custom_section(self, section_id: str, content: Optional[str] = None) -> dict:
        item = self.custom_section(section_id)
        if content is not None:
            self.update_custom_section(section_id, content)
        if not str(item.get("content", "")).strip():
            raise ValueError("确认前请先填写自定义分区内容")
        item["status"] = "confirmed"
        item["confirmed_at"] = _now()
        item.setdefault("history", []).append({"at": _now(), "action": "confirm", "content": item["content"]})
        self.save()
        self.write_confirmed_sections()
        return item

    def delete_custom_section(self, section_id: str) -> None:
        sections = self.data.setdefault("custom_sections", [])
        self.data["custom_sections"] = [item for item in sections if item.get("id") != section_id]
        self.save()
