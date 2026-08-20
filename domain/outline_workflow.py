# -*- coding: utf-8 -*-
"""大纲工作流的结构和基础校验。"""
from __future__ import annotations


OUTLINE_WORKFLOW_VERSION = 1
STEP_STATUSES = {"pending", "draft", "confirmed"}

# ID 是持久化契约，标题可以随界面文案调整，ID 不应改名。
DEFAULT_STEP_DEFINITIONS = (
    ("story_premise", "故事前提"), ("theme", "主题表达"),
    ("genre_tone", "类型与基调"), ("target_readers", "目标读者"),
    ("core_conflict", "核心冲突"), ("central_question", "中心问题"),
    ("protagonist", "主角设定"), ("protagonist_goal", "主角目标"),
    ("protagonist_flaw", "主角缺陷"), ("protagonist_arc", "主角成长弧"),
    ("antagonist", "对手设定"), ("supporting_cast", "配角关系"),
    ("character_dynamics", "角色动力学"), ("world_rules", "世界规则"),
    ("world_history", "世界历史"), ("factions", "势力与组织"),
    ("power_system", "力量或技术体系"), ("key_locations", "关键地点"),
    ("opening_hook", "开篇钩子"), ("inciting_incident", "导火事件"),
    ("act_one", "第一幕"), ("first_turn", "第一转折"),
    ("act_two_a", "第二幕上半"), ("midpoint", "中点事件"),
    ("act_two_b", "第二幕下半"), ("second_turn", "第二转折"),
    ("act_three", "第三幕"), ("climax", "高潮"),
    ("resolution", "结局"), ("subplots", "支线剧情"),
    ("foreshadowing", "伏笔设计"), ("reversals", "关键反转"),
    ("rhythm", "节奏规划"), ("chapter_milestones", "章节里程碑"),
)


class OutlineWorkflowValidationError(ValueError):
    pass


def empty_workflow() -> dict:
    return {
        "version": OUTLINE_WORKFLOW_VERSION,
        "steps": [
            {
                "id": step_id,
                "index": index,
                "title": title,
                "enabled": True,
                "required": False,
                "content": "",
                "status": "pending",
                "source": "",
                "history": [],
            }
            for index, (step_id, title) in enumerate(DEFAULT_STEP_DEFINITIONS, 1)
        ],
    }


def validate_workflow(workflow: dict) -> list[str]:
    if not isinstance(workflow, dict):
        return ["工作流必须是对象"]
    steps = workflow.get("steps")
    if not isinstance(steps, list):
        return ["工作流 steps 必须是列表"]
    errors, ids, indexes = [], set(), set()
    for step in steps:
        if not isinstance(step, dict):
            errors.append("工作流包含非对象步骤")
            continue
        step_id = step.get("id")
        if not isinstance(step_id, str) or not step_id.strip():
            errors.append("步骤缺少稳定 id")
        elif step_id in ids:
            errors.append(f"步骤 id 重复: {step_id}")
        else:
            ids.add(step_id)
        index = step.get("index")
        if not isinstance(index, int) or index < 1:
            errors.append(f"步骤 {step_id or '?'} 的顺序无效")
        elif index in indexes:
            errors.append(f"步骤顺序重复: {index}")
        else:
            indexes.add(index)
        if step.get("status", "pending") not in STEP_STATUSES:
            errors.append(f"步骤 {step_id or '?'} 状态无效")
        if not isinstance(step.get("content", ""), str):
            errors.append(f"步骤 {step_id or '?'} 内容必须是文本")
    return errors
