import { describe, expect, it } from "vitest";
import { assessWritingReadiness, writingReadinessSections } from "./writing-readiness";
import type { PlanningSection } from "./tauri-client";

function section(id: string, content: string, pendingContent = ""): PlanningSection {
  return {
    id,
    content,
    pendingContent,
    rationale: "",
    consequence: "",
    references: [],
    updatedAt: "",
  };
}

describe("assessWritingReadiness", () => {
  it("allows writing when finalized settings, a character card and a chapter plan exist", () => {
    const readiness = assessWritingReadiness({
      sections: writingReadinessSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "第三人称有限视角" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.completedCount).toBe(writingReadinessSections.length);
    expect(readiness.missingSections).toEqual([]);
  });

  it("does not treat pending content as finalized and reports card and chapter gaps", () => {
    const readiness = assessWritingReadiness({
      sections: [
        section("seed-premise", ""),
        section("engine-protagonist", "", "只有待定候选"),
      ],
      hasCharacterCard: false,
      hasChapterPlan: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.missingSections.map((item) => item.id)).toContain("engine-protagonist");
    expect(readiness.missingCharacterCard).toBe(true);
    expect(readiness.missingChapterPlan).toBe(true);
  });

  it("requires the narrative section to specify the actual person", () => {
    const readiness = assessWritingReadiness({
      sections: writingReadinessSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "节奏要快，章末留钩子。" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.missingNarrativePerspective).toBe(true);
  });

  it("does not confuse a negated person with the selected narrative person", () => {
    const readiness = assessWritingReadiness({
      sections: writingReadinessSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative"
            ? "不使用第一人称，采用第三人称有限视角。"
            : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.missingNarrativePerspective).toBe(false);
  });
});
