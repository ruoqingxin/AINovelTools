import { describe, expect, it } from "vitest";
import { essentialPlanningSectionIds, nextIncompletePlanningSectionId, planningSectionGroups } from "./story-planning-workbench";

describe("planningSectionGroups", () => {
  it("provides a complete, uniquely keyed work-design structure", () => {
    const sections = planningSectionGroups.flatMap((group) => group.children);

    expect(planningSectionGroups.map((group) => group.label)).toEqual([
      "作品定位",
      "故事内核",
      "人物系统",
      "故事世界",
      "情节系统",
      "叙事方案",
    ]);
    expect(sections).toHaveLength(37);
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
    expect(sections.every((section) => section.label.trim() && section.prompt.trim())).toBe(true);
  });

  it("keeps a small essential set and advances to the next unfinished item", () => {
    const allIds = new Set(planningSectionGroups.flatMap((group) => group.children.map((section) => section.id)));
    expect(essentialPlanningSectionIds.every((id) => allIds.has(id))).toBe(true);
    expect(nextIncompletePlanningSectionId("positioning-genre", new Set(["positioning-genre", "positioning-promise"]))).toBe("positioning-selling-point");
    expect(nextIncompletePlanningSectionId("narrative-motifs", allIds)).toBeNull();
  });
});
