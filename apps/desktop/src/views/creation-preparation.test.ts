import { describe, expect, it } from "vitest";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { buildPreparationStages, preparationStatus } from "./creation-preparation";
import { emptyPlanningSection } from "./use-planning-draft";

const nodes: PlanNode[] = [
  { id: "outline", kind: "OUTLINE", parentId: null, title: "大纲", archived: false, revision: 1, sortOrder: 0 },
  { id: "first", kind: "CHAPTER", parentId: "volume", title: "第一章", archived: false, revision: 1, sortOrder: 0 },
];
const confirmed = (id: string): PlanningSection => ({ ...emptyPlanningSection(id), content: "作者决定", storyState: "CONFIRMED" });

describe("story preparation topics", () => {
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
    expect(stages.find((stage) => stage.id === "outline")!.items[0].sectionId).toBeNull();
    expect(stages.find((stage) => stage.id === "opening")!.items[0].sectionId).toBeNull();
    expect(stages.flatMap((stage) => stage.items).some((item) => item.sectionId === "plan-node:first")).toBe(false);
  });
  it("organizes six main themes and keeps extra details optional", () => {
    const stages = buildPreparationStages(nodes);
    expect(stages.flatMap((stage) => stage.items).filter((item) => item.primary)).toHaveLength(6);
    expect(stages.map((stage) => stage.title)).toEqual(["故事概念", "核心人物", "目标与动机", "主要矛盾", "主线方向", "开篇事件"]);
    expect(stages.find((stage) => stage.id === "opening")!.items[0].sectionId).toBe("plan-node:first");
    expect(stages.flatMap((stage) => stage.items).filter((item) => ["genre", "promise", "rules", "stakes", "ending", "relationship"].includes(item.id))
      .every((item) => !item.primary)).toBe(true);
  });
  it("marks an unresolved revision for review without changing the other confirmed topics", () => {
    const stages = buildPreparationStages(nodes);
    const sections = stages.flatMap((stage) => stage.items).filter((item) => item.primary).map((item) => confirmed(item.sectionId!));
    sections[0].pendingContent = "另一种开局";
    expect(sections.map((section) => preparationStatus(section, sections))).toEqual([
      "review", "confirmed", "confirmed", "confirmed", "confirmed", "confirmed",
    ]);
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
      .toEqual(["题材", "阅读期待", "核心人物", "目标与动机"]);
  });
});
