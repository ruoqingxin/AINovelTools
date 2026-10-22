import { describe, expect, it } from "vitest";
import { assembleOutline, buildOutlineSteps, outlineSourcesChanged, withOutlineSources } from "./outline-steps";
import { emptyPlanningSection } from "./use-planning-draft";
import { preparationStatus } from "./creation-preparation";

describe("outline steps", () => {
  const steps = buildOutlineSteps("plan-node:outline");
  const sections = steps.map((step, index) => ({
    ...emptyPlanningSection(step.sectionId!), content: `事件 ${index + 1}`, pendingContent: "",
    storyState: "CONFIRMED" as const, version: 1,
  }));
  it("keeps five distinct, short questions scoped to one outline", () => {
    expect(steps).toHaveLength(5);
    expect(new Set(steps.map((step) => step.sectionId)).size).toBe(5);
    expect(buildOutlineSteps("another")[0].sectionId).not.toBe(steps[0].sectionId);
    steps.forEach((step) => {
      expect(step.sectionId).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(step.question.match(/？/g)).toHaveLength(1);
      expect(step.question.length).toBeLessThan(20);
      expect(step.placeholder).not.toContain("\n");
      expect(step.kind).toBe("OUTLINE_STEP");
    });
  });
  it("assembles formal step content in causal order without adopting candidates", () => {
    const result = assembleOutline(steps, sections.map((section) => ({ ...section, pendingContent: "未确认候选" })).reverse());
    expect(result).toBe(steps.map((step, index) => `## ${step.title}\n\n事件 ${index + 1}`).join("\n\n"));
    expect(result).not.toContain("未确认候选");
  });
  it("tracks source versions while preserving unrelated references", () => {
    const refs = withOutlineSources(["discussion:original"], steps, sections);
    const main = { ...emptyPlanningSection("plan-node:outline"), references: refs, content: "正式大纲", storyState: "CONFIRMED" as const };
    expect(refs).toContain("discussion:original");
    expect(withOutlineSources(refs, steps, sections)).toHaveLength(2);
    expect(outlineSourcesChanged(main, sections)).toBe(false);
    expect(outlineSourcesChanged(main, sections.slice(1))).toBe(true);
    for (const change of [{ version: 2 }, { pendingContent: "新稿" }, { storyState: "DEFERRED" as const }]) {
      const updated = sections.map((section, index) => index === 0 ? { ...section, ...change } : section);
      expect(outlineSourcesChanged(main, updated)).toBe(true);
      expect(preparationStatus(main, updated)).toBe("review");
    }
  });
  it("leaves legacy outlines alone and treats malformed source records as stale", () => {
    expect(outlineSourcesChanged(emptyPlanningSection("legacy"), [])).toBe(false);
    for (const record of ["bad json", "{}", "[null]", '[{"id":"missing"}]']) {
      expect(outlineSourcesChanged({ ...emptyPlanningSection("outline"), references: [`outline-sources:v1:${record}`] }, sections)).toBe(true);
    }
  });
});
