import { describe, expect, it } from "vitest";
import { essentialPlanningSectionIds, nextIncompletePlanningSectionId, planningSectionGroups } from "./story-planning-workbench";

describe("planningSectionGroups", () => {
  it("provides a complete, uniquely keyed work-design structure", () => {
    const sections = planningSectionGroups.flatMap((group) => group.children);

    expect(planningSectionGroups.map((group) => group.label)).toEqual([
      "开篇定位",
      "故事驱动",
      "连载建设",
    ]);
    expect(sections).toHaveLength(17);
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
    expect(sections.every((section) => section.label.trim() && section.prompt.trim() && section.guidance.trim())).toBe(true);
  });

  it("keeps a small essential set and advances to the next unfinished item", () => {
    const allIds = new Set(planningSectionGroups.flatMap((group) => group.children.map((section) => section.id)));
    expect(essentialPlanningSectionIds.every((id) => allIds.has(id))).toBe(true);
    expect(nextIncompletePlanningSectionId("seed-premise", new Set(["seed-premise", "seed-genre-promise"]))).toBe("seed-genre");
    expect(nextIncompletePlanningSectionId("frame-narrative", allIds)).toBeNull();
  });
});
