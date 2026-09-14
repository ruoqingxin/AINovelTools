import { describe, expect, it } from "vitest";
import {
  assessWritingReadiness,
  auditChapterPlan,
  buildWritingReadinessItems,
  findWritingGapTargets,
  suggestedWritingSections,
} from "./writing-readiness";
import type { PlanningSection } from "./tauri-client";

function section(id: string, content: string, pendingContent = ""): PlanningSection {
  return {
    id,
    content,
    pendingContent,
    storyState: "UNSET",
    rationale: "",
    consequence: "",
    references: [],
    updatedAt: "",
  };
}

describe("assessWritingReadiness", () => {
  it("allows writing when all suggested settings, a character card and a chapter plan exist", () => {
    const readiness = assessWritingReadiness({
      sections: suggestedWritingSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "第三人称有限视角" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.suggestedCompletedCount).toBe(suggestedWritingSections.length);
    expect(readiness.suggestedMissingSections).toEqual([]);
  });

  it("treats planning gaps as suggestions instead of stopping generation", () => {
    const readiness = assessWritingReadiness({
      sections: [],
      hasCharacterCard: false,
      hasChapterPlan: false,
    });

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.suggestedMissingSections.length).toBe(
      suggestedWritingSections.length,
    );
    expect(readiness.missingCharacterCard).toBe(true);
    expect(readiness.missingChapterPlan).toBe(true);
  });

  it("does not treat pending content as finalized but keeps writing available", () => {
    const readiness = assessWritingReadiness({
      sections: [
        section("seed-premise", ""),
        section("engine-protagonist", "", "只有待定候选"),
      ],
      hasCharacterCard: false,
      hasChapterPlan: false,
    });

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.suggestedMissingSections.map((item) => item.id)).toContain(
      "engine-protagonist",
    );
    expect(readiness.missingCharacterCard).toBe(true);
    expect(readiness.missingChapterPlan).toBe(true);
  });

  it("reports an unspecified narrative person without blocking", () => {
    const readiness = assessWritingReadiness({
      sections: suggestedWritingSections.map((item) =>
        section(
          item.id,
          item.id === "frame-narrative" ? "节奏要快，章末留钩子。" : "已确认设定",
        ),
      ),
      hasCharacterCard: true,
      hasChapterPlan: true,
    });

    expect(readiness.canGenerate).toBe(true);
    expect(readiness.missingNarrativePerspective).toBe(true);
  });

  it("does not confuse a negated person with the selected narrative person", () => {
    const readiness = assessWritingReadiness({
      sections: suggestedWritingSections.map((item) =>
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

describe("buildWritingReadinessItems", () => {
  it("turns every planning gap into a suggestion and preserves direct destinations", () => {
    const readiness = assessWritingReadiness({
      sections: [],
      hasCharacterCard: false,
      hasChapterPlan: false,
    });
    const items = buildWritingReadinessItems(readiness, "chapter-1");

    expect(
      items.slice(suggestedWritingSections.length).map((item) => item.id),
    ).toEqual([
      "character-card",
      "chapter-plan",
    ]);
    expect(items.every((item) => item.severity === "warning")).toBe(true);
    expect(items.find((item) => item.id === "character-card")?.href).toBe("/knowledge");
    expect(items.find((item) => item.id === "chapter-plan")?.href).toBe("/planning#chapter-1");
    expect(items.find((item) => item.id === "frame-setting")?.href).toBe(
      "/planning#frame-setting",
    );
  });
});

describe("auditChapterPlan", () => {
  it("accepts an execution card with the expected structural signals", () => {
    const notices = auditChapterPlan({
      chapterPlan:
        "本章目标：让主角发现身份线索。关键冲突是与守卫争夺证据；主角选择独自追踪，局势因此改变。结尾留下神秘印记作为钩子。",
      volumePlan: "第一卷目标：进入主城并揭开身份线索。",
      sections: [section("frame-narrative", "第三人称有限视角")],
    });

    expect(notices).toEqual([]);
  });

  it("reports explicit perspective conflicts and missing structural signals", () => {
    const notices = auditChapterPlan({
      chapterPlan: "本章目标是让主角选择调查旧案并发现异常记录。采用第一人称。",
      volumePlan: "",
      sections: [section("frame-narrative", "第三人称有限视角")],
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "volume-plan",
      "narrative-perspective",
      "chapter-conflict",
      "chapter-hook",
    ]);
  });
});
