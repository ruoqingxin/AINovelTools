import { describe, expect, it } from "vitest";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { buildPreparationStages, preparationProgress, preparationStatus } from "./creation-preparation";
import { emptyPlanningSection } from "./use-planning-draft";

const nodes: PlanNode[] = [
  { id: "outline", kind: "OUTLINE", parentId: null, title: "大纲", archived: false, revision: 1, sortOrder: 0 },
  { id: "first", kind: "CHAPTER", parentId: "volume", title: "第一章", archived: false, revision: 1, sortOrder: 0 },
];
const confirmed = (id: string): PlanningSection => ({ ...emptyPlanningSection(id), content: "作者决定", storyState: "CONFIRMED" });

describe("creation preparation progress", () => {
  it("does not count empty states, drafts, candidates, or explicit deferrals as confirmed", () => {
    expect(preparationStatus()).toBe("empty");
    expect(preparationStatus({ ...emptyPlanningSection("x"), content: "旧笔记" })).toBe("draft");
    expect(preparationStatus({ ...confirmed("x"), pendingContent: "新候选" })).toBe("review");
    expect(preparationStatus({ ...confirmed("x"), content: "" })).toBe("empty");
    expect(preparationStatus({ ...confirmed("x"), storyState: "DEFERRED" })).toBe("deferred");
    expect(preparationStatus({ ...confirmed("x"), storyState: "RETIRED" })).toBe("draft");
    expect(preparationStatus({ ...confirmed("x"), storyState: "LOCKED" })).toBe("confirmed");
  });
  it("requires real outline and opening nodes, ignoring archived nodes and orphaned plans", () => {
    const stages = buildPreparationStages(nodes.map((node) => ({ ...node, archived: true })));
    expect(stages[2].items[0].sectionId).toBeNull();
    expect(stages[3].items[0].sectionId).toBeNull();
    expect(preparationProgress(stages, [confirmed("plan-node:first")]).confirmed).toBe(0);
  });
  it("reuses existing planning IDs and does not require optional relationship or ending decisions", () => {
    const stages = buildPreparationStages(nodes);
    const sections = stages.flatMap((stage) => stage.items).filter((item) => item.required).map((item) => confirmed(item.sectionId!));
    expect(preparationProgress(stages, sections)).toMatchObject({ ready: true, confirmed: 10, total: 10 });
    expect(stages[3].items[0].sectionId).toBe("plan-node:first");
  });
  it("withdraws readiness when a confirmed key decision has an unresolved revision", () => {
    const stages = buildPreparationStages(nodes);
    const sections = stages.flatMap((stage) => stage.items).filter((item) => item.required).map((item) => confirmed(item.sectionId!));
    sections[0].pendingContent = "另一种开局";
    expect(preparationProgress(stages, sections)).toMatchObject({ ready: false, confirmed: 9, missing: [{ id: "premise" }] });
  });
  it("asks one short question per item without multiline fill-in templates", () => {
    const items = buildPreparationStages(nodes).flatMap((stage) => stage.items);
    expect(new Set(items.map((item) => item.sectionId)).size).toBe(items.length);
    for (const item of items) {
      expect(item.question.match(/？/g)).toHaveLength(1);
      expect(item.question.length).toBeLessThanOrEqual(20);
      expect(item.placeholder).not.toContain("\n");
    }
    expect(items.filter((item) => ["genre", "promise", "protagonist", "motivation"].includes(item.id)).map((item) => item.title))
      .toEqual(["题材", "阅读期待", "主角", "行动动机"]);
  });
});
