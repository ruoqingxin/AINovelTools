import type { PlanningSection } from "./tauri-client";

export const suggestedWritingSections = [
  { id: "seed-premise", label: "核心前提与开局情境" },
  { id: "seed-genre-promise", label: "类型、题材与阅读承诺" },
  { id: "seed-hook", label: "核心卖点与独特钩子" },
  { id: "seed-tone", label: "基调、尺度与篇幅体量" },
  { id: "engine-protagonist", label: "主角目标与内在需求" },
  { id: "engine-antagonism", label: "对抗系统与升级机制" },
  { id: "engine-stakes", label: "赌注、代价与失败后果" },
  { id: "engine-theme", label: "核心谜团与主题命题" },
  { id: "engine-ending", label: "结局状态与承诺兑现" },
  { id: "cast-core-relationship", label: "核心关系与关系变化" },
  { id: "cast-supporting", label: "关键角色与叙事功能" },
  { id: "cast-arcs", label: "人物弧光、秘密与信息差" },
  { id: "frame-setting", label: "舞台、硬规则与资源限制" },
  { id: "frame-history", label: "历史因果、势力与矛盾来源" },
  { id: "frame-narrative", label: "视角、信息与叙事节奏" },
] as const;

export type WritingReadiness = {
  canGenerate: boolean;
  suggestedCompletedCount: number;
  suggestedTotalCount: number;
  suggestedMissingSections: Array<{ id: string; label: string }>;
  missingCharacterCard: boolean;
  missingChapterPlan: boolean;
  missingNarrativePerspective: boolean;
};

export type WritingGapTarget = {
  id: string;
  label: string;
  href: string;
};

export type WritingReadinessItem = {
  id: string;
  label: string;
  description: string;
  severity: "warning";
  kind: "section" | "character-card" | "chapter-plan";
  href: string;
};

export type WritingPreflightNotice = {
  id: string;
  label: string;
  detail: string;
};

export function isPlanningSectionSettled(section?: PlanningSection) {
  if (!section) return false;
  return Boolean(section.content.trim()) || [
    "UNKNOWN",
    "DEFERRED",
    "AUTHOR_RESERVED",
    "CONFIRMED",
    "LOCKED",
    "RETIRED",
  ].includes(section.storyState);
}

const writingGapPatterns: Array<WritingGapTarget & { keywords: string[] }> = [
  {
    id: "character-card",
    label: "补人物卡",
    href: "/knowledge",
    keywords: [
      "人物卡",
      "角色卡",
      "主角卡",
      "人物信息",
      "角色资料",
      "主角名字",
      "主角姓名",
      "主角信息",
      "人物姓名",
      "角色姓名",
    ],
  },
  {
    id: "chapter-plan",
    label: "补章节执行卡",
    href: "/planning",
    keywords: ["章节执行卡", "章节卡", "章节计划", "本章目标"],
  },
  {
    id: "seed-premise",
    label: "补核心前提",
    href: "/planning#seed-premise",
    keywords: ["核心前提", "开局情境", "故事前提", "故事为什么开始"],
  },
  {
    id: "engine-protagonist",
    label: "补主角目标",
    href: "/planning#engine-protagonist",
    keywords: ["主角目标", "内在需求", "主角动机", "主角欲望", "主角设定"],
  },
  {
    id: "engine-antagonism",
    label: "补对抗机制",
    href: "/planning#engine-antagonism",
    keywords: ["对抗系统", "升级机制", "反派目标", "敌人层级"],
  },
  {
    id: "engine-stakes",
    label: "补赌注与代价",
    href: "/planning#engine-stakes",
    keywords: ["赌注", "失败后果", "行动代价", "风险代价"],
  },
  {
    id: "engine-ending",
    label: "补结局方向",
    href: "/planning#engine-ending",
    keywords: ["结局状态", "承诺兑现", "最终结局"],
  },
  {
    id: "cast-arcs",
    label: "补人物弧光",
    href: "/planning#cast-arcs",
    keywords: ["人物弧光", "角色弧光", "信息差"],
  },
  {
    id: "frame-setting",
    label: "补世界与力量规则",
    href: "/planning#frame-setting",
    keywords: [
      "境界",
      "境界设定",
      "力量体系",
      "力量规则",
      "硬规则",
      "世界规则",
      "能力边界",
      "资源限制",
      "修炼体系",
      "禁忌",
    ],
  },
  {
    id: "frame-history",
    label: "补势力与历史",
    href: "/planning#frame-history",
    keywords: ["历史因果", "势力关系", "势力矛盾"],
  },
  {
    id: "frame-narrative",
    label: "补叙述视角",
    href: "/planning#frame-narrative",
    keywords: ["叙述人称", "叙述视角", "视角范围", "人称未明确"],
  },
];

export function findWritingGapTargets(text: string): WritingGapTarget[] {
  const targets = writingGapPatterns
    .filter((target) => target.keywords.some((keyword) => text.includes(keyword)))
    .map(({ id, label, href }) => ({ id, label, href }));

  return targets.filter(
    (target, index) => targets.findIndex((candidate) => candidate.id === target.id) === index,
  );
}

export function auditChapterPlan(input: {
  chapterPlan: string;
  volumePlan: string;
  sections: PlanningSection[];
}): WritingPreflightNotice[] {
  const plan = input.chapterPlan.trim();
  if (!plan) return [];

  const notices: WritingPreflightNotice[] = [];
  if (!input.volumePlan.trim()) {
    notices.push({
      id: "volume-plan",
      label: "所属分卷规划缺失",
      detail: "执行卡没有可承接的分卷目标，生成正文前建议先补齐分卷阶段任务和卷末转折。",
    });
  }

  const narrativeSection = input.sections.find((section) => section.id === "frame-narrative");
  const formalPerspectives = affirmedNarrativePerspectives(narrativeSection?.content ?? "");
  const planPerspectives = affirmedNarrativePerspectives(plan);
  const conflictingPerspective = formalPerspectives.find(
    (perspective) => planPerspectives.length > 0 && !planPerspectives.includes(perspective),
  );
  if (conflictingPerspective) {
    notices.push({
      id: "narrative-perspective",
      label: "叙述人称可能冲突",
      detail: `正式设定要求${conflictingPerspective}，执行卡另行指定了${planPerspectives.join("、")}。请确认本章是否例外。`,
    });
  }

  const structuralChecks = [
    {
      id: "chapter-goal",
      label: "本章目标",
      detail: "未识别到明确目标，正文可能缺少本章要完成的推进任务。",
      pattern: /目标|目的|任务|要完成|要获得|需要/,
    },
    {
      id: "chapter-conflict",
      label: "冲突推进",
      detail: "未识别到明确阻碍或对抗，场景可能缺少持续张力。",
      pattern: /冲突|阻碍|对抗|争夺|威胁|对手|敌人/,
    },
    {
      id: "chapter-turn",
      label: "关键行动与转折",
      detail: "未识别到关键选择、发现或局面变化，章节可能只复述信息。",
      pattern: /行动|选择|决定|发现|反转|转折|改变/,
    },
    {
      id: "chapter-hook",
      label: "结尾钩子",
      detail: "未识别到章末悬念、伏笔或下一章接口，衔接可能偏弱。",
      pattern: /钩子|悬念|伏笔|线索|留下|未完/,
    },
  ];
  for (const check of structuralChecks) {
    if (!check.pattern.test(plan)) {
      notices.push({
        id: check.id,
        label: check.label,
        detail: check.detail,
      });
    }
  }
  return notices;
}

export function buildWritingReadinessItems(
  readiness: WritingReadiness,
  chapterId: string,
): WritingReadinessItem[] {
  const items: WritingReadinessItem[] = readiness.suggestedMissingSections.map(
    (section) => ({
      id: section.id,
      label: section.label,
      description: "规划建议 · 不影响开始写作",
      severity: "warning",
      kind: "section",
      href: `/planning#${section.id}`,
    }),
  );

  if (readiness.missingCharacterCard) {
    items.push({
      id: "character-card",
      label: "人物卡",
      description: "知识库建议 · 可以先写，再按正文沉淀角色",
      severity: "warning",
      kind: "character-card",
      href: "/knowledge",
    });
  }
  if (readiness.missingChapterPlan) {
    items.push({
      id: "chapter-plan",
      label: "章节执行卡",
      description: "章节建议 · 可直接写正文，之后再补计划",
      severity: "warning",
      kind: "chapter-plan",
      href: `/planning#${chapterId}`,
    });
  }
  if (readiness.missingNarrativePerspective) {
    items.push({
      id: "frame-narrative",
      label: "叙述人称未明确",
      description: "写作建议 · 未决定时可以保留未知",
      severity: "warning",
      kind: "section",
      href: "/planning#frame-narrative",
    });
  }
  return items;
}

export function assessWritingReadiness(input: {
  sections: PlanningSection[];
  hasCharacterCard: boolean;
  hasChapterPlan: boolean;
}): WritingReadiness {
  const completedIds = new Set(
    input.sections
      .filter(isPlanningSectionSettled)
      .map((section) => section.id),
  );
  const suggestedMissingSections = suggestedWritingSections
    .filter((section) => !completedIds.has(section.id))
    .map((section) => ({ id: section.id, label: section.label }));
  const missingCharacterCard = !input.hasCharacterCard;
  const missingChapterPlan = !input.hasChapterPlan;
  const narrativeSection = input.sections.find((section) => section.id === "frame-narrative");
  const hasExplicitNarrativePerspective =
    Boolean(narrativeSection?.content.trim()) &&
    hasAffirmedNarrativePerspective(narrativeSection?.content ?? "");
  const missingNarrativePerspective =
    Boolean(narrativeSection?.content.trim()) && !hasExplicitNarrativePerspective;

  return {
    canGenerate: true,
    suggestedCompletedCount:
      suggestedWritingSections.length - suggestedMissingSections.length,
    suggestedTotalCount: suggestedWritingSections.length,
    suggestedMissingSections,
    missingCharacterCard,
    missingChapterPlan,
    missingNarrativePerspective,
  };
}

function hasAffirmedNarrativePerspective(content: string) {
  return affirmedNarrativePerspectives(content).length > 0;
}

function affirmedNarrativePerspectives(content: string) {
  return ["第一人称", "第二人称", "第三人称"].filter((label) => {
    let searchFrom = 0;
    while (searchFrom < content.length) {
      const index = content.indexOf(label, searchFrom);
      if (index < 0) return false;
      const prefix = content.slice(Math.max(0, index - 4), index);
      if (!/[不非别未禁勿避]/.test(prefix)) return true;
      searchFrom = index + label.length;
    }
    return false;
  });
}
