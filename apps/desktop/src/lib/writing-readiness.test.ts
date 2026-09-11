import { describe, expect, it } from "vitest";
import {
  assessWritingReadiness,
  blockingWritingSections,
  findWritingGapTargets,
  warningWritingSections,
} from "./writing-readiness";
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
  it("allows writing when all blocking settings, a character card and a chapter plan exist", () => {
    const readiness = assessWritingReadiness({
      sections: blockingWritingSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "第三人称有限视角" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.blockingCompletedCount).toBe(blockingWritingSections.length);
    expect(readiness.blockingMissingSections).toEqual([]);
    expect(readiness.warningMissingSections.map((item) => item.id)).toEqual(
      warningWritingSections.map((item) => item.id),
    );
  });

  it("treats non-blocking planning gaps as warnings instead of stopping generation", () => {
    const readiness = assessWritingReadiness({
      sections: blockingWritingSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "第三人称有限视角" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.blockingMissingSections).toEqual([]);
    expect(readiness.warningMissingSections.length).toBeGreaterThan(0);
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

    expect(readiness.canGenerate).toBe(false);
    expect(readiness.blockingMissingSections.map((item) => item.id)).toContain("engine-protagonist");
    expect(readiness.missingCharacterCard).toBe(true);
    expect(readiness.missingChapterPlan).toBe(true);
  });

  it("requires the narrative section to specify the actual person", () => {
    const readiness = assessWritingReadiness({
      sections: blockingWritingSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "节奏要快，章末留钩子。" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.canGenerate).toBe(false);
    expect(readiness.missingNarrativePerspective).toBe(true);
  });

  it("does not confuse a negated person with the selected narrative person", () => {
    const readiness = assessWritingReadiness({
      sections: blockingWritingSections.map((item) =>
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

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.missingNarrativePerspective).toBe(false);
  });
});

describe("findWritingGapTargets", () => {
  it("maps model-reported gaps to the exact setup or knowledge location", () => {
    const targets = findWritingGapTargets(
      "[上下文不足]\n- 主角名字：未确定\n- 境界设定：缺失\n- 叙述人称未明确",
    );

    expect(targets).toEqual([
      { id: "character-card", label: "补人物卡", href: "/knowledge" },
      {
        id: "frame-setting",
        label: "补世界与力量规则",
        href: "/planning#frame-setting",
      },
      {
        id: "frame-narrative",
        label: "补叙述视角",
        href: "/planning#frame-narrative",
      },
    ]);
  });

  it("returns no target when the model only gives a generic insufficiency message", () => {
    expect(findWritingGapTargets("[上下文不足]\n正式设定不完整")).toEqual([]);
  });
});
