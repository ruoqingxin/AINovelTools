import { describe, expect, it } from "vitest";
import { bookPreparationContent, changedBookDirections, emptyBookPreparation, readBookPreparation, withBookPreparation } from "./book-preparation";
import { emptyPlanningSection } from "./use-planning-draft";

describe("whole-book preparation", () => {
  it("round-trips structured preferences as readable author context", () => {
    const fields = { ...emptyBookPreparation(), genre: "都市悬疑", targetWords: "20", perspective: "第三人称 · 限定视角",
      style: "简洁直白", premise: "邮差追查未来来信。", boundaries: "不写后宫\n不写过度血腥" };
    const saved = withBookPreparation(emptyPlanningSection("seed-tone"), fields);
    expect(readBookPreparation(saved)).toEqual(fields);
    expect(saved.content).toContain("【目标字数】\n20 万字");
    expect(saved.content).toContain("【叙事视角】\n第三人称");
    expect(saved.content).not.toContain("暂未确定");
  });

  it("preserves legacy notes verbatim without inventing split decisions", () => {
    const content = "约二十万字，第三人称。\n  不写后宫。";
    const fields = readBookPreparation({ content, references: [] });
    expect(fields).toEqual({ ...emptyBookPreparation(), notes: content });
    expect(bookPreparationContent(fields)).toContain(content);
  });

  it("ignores stale, invalid and mismatched metadata after external edits", () => {
    const original = withBookPreparation(emptyPlanningSection("seed-tone"), { ...emptyBookPreparation(), style: "细腻写实" });
    expect(readBookPreparation({ ...original, content: "外部修改的新方向" }).notes).toBe("外部修改的新方向");
    for (const value of ["{", "null", "[]", '{"style":12}']) {
      expect(readBookPreparation({ content: "原文", references: [`book-preparation:v1:${value}`] }).notes).toBe("原文");
    }
  });

  it("retains provenance, candidates, reserved state and version without metadata duplication", () => {
    const baseline = { ...emptyPlanningSection("seed-tone"), references: ["discussion:original"], pendingContent: "旧候选",
      storyState: "AUTHOR_RESERVED" as const, version: 7 };
    const first = withBookPreparation(baseline, { ...emptyBookPreparation(), genre: "科幻" });
    const next = withBookPreparation(first, { ...readBookPreparation(first), targetWords: "50" });
    expect(next).toMatchObject({ pendingContent: "旧候选", storyState: "AUTHOR_RESERVED", version: 7 });
    expect(next.references.filter((entry) => entry.startsWith("book-preparation:v1:"))).toHaveLength(1);
    expect(next.references).toContain("discussion:original");
  });

  it("flags revision or removal of existing directions without warning for first-time choices", () => {
    const empty = emptyPlanningSection("seed-tone");
    const before = withBookPreparation(empty, { ...emptyBookPreparation(), style: "简洁直白", targetWords: "20" });
    expect(changedBookDirections(empty, before)).toEqual([]);
    expect(changedBookDirections(before, withBookPreparation(before, { ...readBookPreparation(before), style: "细腻写实", targetWords: "" })))
      .toEqual(["目标字数", "语言风格"]);
  });
});
