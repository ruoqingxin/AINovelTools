# -*- coding: utf-8 -*-
"""大纲工作流的迁移、编辑和兼容文本渲染。"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone

from domain.outline_workflow import (
    OUTLINE_WORKFLOW_VERSION,
    OutlineWorkflowValidationError,
    empty_workflow,
    validate_workflow,
)


class OutlineService:
    WORKFLOW_FILE = "outline_workflow.json"
    RENDER_FILE = "Novel_architecture.txt"

    def __init__(self, repository):
        self.repository = repository

    def load_workflow(self) -> dict:
        existing = self.repository.read_json(self.WORKFLOW_FILE)
        if isinstance(existing, dict):
            errors = validate_workflow(existing)
            if not errors:
                return existing
            raise OutlineWorkflowValidationError("; ".join(errors))
        workflow = empty_workflow()
        legacy = self.repository.read_text(self.RENDER_FILE).strip()
        if legacy:
            workflow["steps"].append(self._new_step(
                workflow, "legacy_architecture", "旧版架构迁移", legacy, "confirmed", "legacy_migration"
            ))
        self._write(workflow)
        return workflow

    def get_step(self, step_id: str) -> dict | None:
        return next((step for step in self.load_workflow()["steps"] if step["id"] == step_id), None)

    def save_step_draft(self, step_id: str, content: str, source: str = "manual") -> None:
        self._update_step(step_id, content, "draft" if content.strip() else "pending", source)

    def confirm_step(self, step_id: str) -> None:
        workflow = self.load_workflow()
        step = self._find_step(workflow, step_id)
        if not step["content"].strip():
            raise OutlineWorkflowValidationError("空步骤不能确认")
        self._record_history(step)
        step["status"] = "confirmed"
        self._write(workflow)

    def unconfirm_step(self, step_id: str) -> None:
        workflow = self.load_workflow()
        step = self._find_step(workflow, step_id)
        self._record_history(step)
        step["status"] = "draft" if step["content"].strip() else "pending"
        self._write(workflow)

    def clear_step(self, step_id: str) -> None:
        self._update_step(step_id, "", "pending", "manual")

    def import_ai_steps(self, contents: dict[str, str], source: str = "ai") -> None:
        workflow = self.load_workflow()
        for step_id, content in contents.items():
            if not str(content).strip():
                continue
            step = next((item for item in workflow["steps"] if item["id"] == step_id), None)
            if step is None:
                step = self._new_step(workflow, step_id, "AI 快速生成架构", "", "pending", source)
                workflow["steps"].append(step)
            self._record_history(step)
            step["content"] = str(content).strip()
            step["status"] = "draft"
            step["source"] = source
        self._write(workflow)

    def render_to_string(self, include_drafts: bool = False) -> str:
        blocks = []
        for step in sorted(self.load_workflow()["steps"], key=lambda item: item["index"]):
            if not step.get("enabled", True) or not step.get("content", "").strip():
                continue
            if step.get("status") != "confirmed" and not include_drafts:
                continue
            if step.get("source") == "legacy_migration":
                blocks.append(step["content"].strip())
            else:
                blocks.append(f"#=== {step['index']}) {step['title']} ===\n{step['content'].strip()}")
        return "\n\n".join(blocks) + ("\n" if blocks else "")

    def render_architecture(self, include_drafts: bool = False) -> str:
        rendered = self.render_to_string(include_drafts)
        if not self.repository.write_text(self.RENDER_FILE, rendered):
            raise RuntimeError("无法渲染 Novel_architecture.txt")
        return rendered

    def _update_step(self, step_id: str, content: str, status: str, source: str) -> None:
        workflow = self.load_workflow()
        step = self._find_step(workflow, step_id)
        self._record_history(step)
        step["content"] = content.strip()
        step["status"] = status
        step["source"] = source
        self._write(workflow)

    @staticmethod
    def _find_step(workflow: dict, step_id: str) -> dict:
        step = next((item for item in workflow["steps"] if item["id"] == step_id), None)
        if step is None:
            raise OutlineWorkflowValidationError(f"不存在的大纲步骤: {step_id}")
        return step

    @staticmethod
    def _new_step(workflow: dict, step_id: str, title: str, content: str, status: str, source: str) -> dict:
        return {"id": step_id, "index": len(workflow["steps"]) + 1, "title": title,
                "enabled": True, "required": False, "content": content, "status": status,
                "source": source, "history": []}

    @staticmethod
    def _record_history(step: dict) -> None:
        if step.get("content", "").strip():
            step.setdefault("history", []).append({
                "content": step["content"], "status": step.get("status", "pending"),
                "source": step.get("source", ""),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

    def _write(self, workflow: dict) -> None:
        errors = validate_workflow(workflow)
        if errors:
            raise OutlineWorkflowValidationError("; ".join(errors))
        payload = deepcopy(workflow)
        payload["version"] = OUTLINE_WORKFLOW_VERSION
        if not self.repository.write_json(self.WORKFLOW_FILE, payload):
            raise RuntimeError("无法保存 outline_workflow.json")
