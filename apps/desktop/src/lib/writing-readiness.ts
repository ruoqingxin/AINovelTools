import type { PlanningSection } from "./tauri-client";

export const writingReadinessSections = [
  { id: "seed-premise", label: "核心前提与开局情境" },
  { id: "engine-protagonist", label: "主角目标与内在需求" },
  { id: "engine-antagonism", label: "对抗系统与升级机制" },
  { id: "engine-stakes", label: "赌注、代价与失败后果" },
  { id: "engine-ending", label: "结局状态与承诺兑现" },
  { id: "cast-arcs", label: "人物弧光、秘密与信息差" },
  { id: "frame-setting", label: "舞台、硬规则与资源限制" },
  { id: "frame-narrative", label: "视角、信息与叙事节奏" },
] as const;

export type WritingReadiness = {
  ready: boolean;
  completedCount: number;
  totalCount: number;
  missingSections: Array<{ id: string; label: string }>;
  missingCharacterCard: boolean;
  missingChapterPlan: boolean;
  missingNarrativePerspective: boolean;
};

export function assessWritingReadiness(input: {
  sections: PlanningSection[];
  hasCharacterCard: boolean;
  hasChapterPlan: boolean;
}): WritingReadiness {
  const completedIds = new Set(
    input.sections
      .filter((section) => section.content.trim())
      .map((section) => section.id),
  );
  const missingSections = writingReadinessSections
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
    ready:
      missingSections.length === 0 &&
      !missingCharacterCard &&
      !missingChapterPlan &&
      !missingNarrativePerspective,
    completedCount: writingReadinessSections.length - missingSections.length,
    totalCount: writingReadinessSections.length,
    missingSections,
    missingCharacterCard,
    missingChapterPlan,
    missingNarrativePerspective,
  };
}

function hasAffirmedNarrativePerspective(content: string) {
  return ["第一人称", "第二人称", "第三人称"].some((label) => {
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
