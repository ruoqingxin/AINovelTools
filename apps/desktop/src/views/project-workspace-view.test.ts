import { describe, expect, it } from "vitest";
import { buildVolumePlanTargetGuidance, parseChapterPlanCandidates, parseVolumePlanCandidates } from "./project-workspace-view";

describe("parseVolumePlanCandidates", () => {
  it("parses numbered, Chinese-numbered, and duplicate volume candidates", () => {
    const candidates = parseVolumePlanCandidates(`
1. 第1卷·启程｜阶段目标：进入主城｜卷末转折：身份暴露
第二卷：决裂｜阶段目标：阵营分裂｜主要矛盾：旧友反目
- 第1卷·启程｜重复候选
这是说明文字，不应被识别
`);

    expect(candidates).toEqual([
      {
        title: "第1卷·启程",
        content: "阶段目标：进入主城｜卷末转折：身份暴露",
      },
      {
        title: "第二卷·决裂",
        content: "阶段目标：阵营分裂｜主要矛盾：旧友反目",
      },
    ]);
  });

  it("ignores text that does not contain a volume heading", () => {
    expect(parseVolumePlanCandidates("分卷规划\n第一幕：开端")).toEqual([]);
  });

  it("splits multiple volume headings concatenated on one line", () => {
    const candidates = parseVolumePlanCandidates(
      "第1卷·苍梧七日｜目标一｜矛盾一｜转折一第2卷·末端节点｜目标二｜矛盾二｜转折二"
      + "第3卷·被删的历史｜目标三｜矛盾三｜转折三第4卷·重估规则的人｜目标四｜矛盾四｜转折四"
      + "第5卷·组件验证｜目标五｜矛盾五｜转折五第6卷·反向道祭｜目标六｜矛盾六｜转折六",
    );

    expect(candidates).toHaveLength(6);
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      "第1卷·苍梧七日",
      "第2卷·末端节点",
      "第3卷·被删的历史",
      "第4卷·重估规则的人",
      "第5卷·组件验证",
      "第6卷·反向道祭",
    ]);
    expect(candidates[1]).toEqual({
      title: "第2卷·末端节点",
      content: "目标二｜矛盾二｜转折二",
    });
    expect(candidates[5].content).toBe("目标六｜矛盾六｜转折六");
  });
});

describe("buildVolumePlanTargetGuidance", () => {
  it("turns the volume scale targets into explicit AI constraints", () => {
    expect(buildVolumePlanTargetGuidance({
      wordCount: "120",
      volumeCount: "4",
      chapterCount: "400",
    })).toBe([
      "本书预计总字数：120 万字",
      "计划分卷数：4 卷",
      "预计章节数：400 章",
    ].join("\n"));
  });

  it("omits empty targets", () => {
    expect(buildVolumePlanTargetGuidance({ wordCount: "", volumeCount: " 3 ", chapterCount: "" })).toBe("计划分卷数：3 卷");
  });
});

describe("parseChapterPlanCandidates", () => {
  it("parses chapter candidates and keeps execution-card details", () => {
    expect(parseChapterPlanCandidates(
      "第1章·入城｜查明封锁原因｜守卫盘查｜发现通缉画像\n"
      + "第2章：夜探旧宅｜找到失踪线索｜阵法反噬｜听见陌生声音",
    )).toEqual([
      {
        title: "第1章·入城",
        content: "查明封锁原因｜守卫盘查｜发现通缉画像",
      },
      {
        title: "第2章·夜探旧宅",
        content: "找到失踪线索｜阵法反噬｜听见陌生声音",
      },
    ]);
  });

  it("splits concatenated chapter headings on one line", () => {
    const candidates = parseChapterPlanCandidates(
      "第1章·入城｜目标一｜冲突一｜钩子一第2章·夜探｜目标二｜冲突二｜钩子二第3章·真相｜目标三｜冲突三｜钩子三",
    );
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      "第1章·入城",
      "第2章·夜探",
      "第3章·真相",
    ]);
  });
});
