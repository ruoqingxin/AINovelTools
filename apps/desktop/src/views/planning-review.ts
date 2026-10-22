import type { PlanningSection } from "../lib/tauri-client";

const reviewPrefix = "author-planning-review:v1:";
type PlanningReview = {
  sectionVersion: number;
  checks: string[];
  basis: Array<{ id: string; version: number }>;
};

export const outlineReviewChecks = [
  "主角的行动理由成立",
  "前后事件能够衔接",
  "转折有充分铺垫",
  "结局回应故事主线",
];
export const openingReviewChecks = [
  "开篇承接故事主线",
  "主要事件推动了故事",
  "章末让人愿意继续读",
];

export function readPlanningReview(section?: PlanningSection): PlanningReview | null {
  const value = section?.references.find((reference) => reference.startsWith(reviewPrefix));
  if (!value) return null;
  try {
    const review: unknown = JSON.parse(value.slice(reviewPrefix.length));
    if (!review || typeof review !== "object") return null;
    const data = review as Partial<PlanningReview>;
    if (!Number.isInteger(data.sectionVersion) || !Array.isArray(data.checks) || !data.checks.every((item) => typeof item === "string")
      || !Array.isArray(data.basis) || !data.basis.every((item) => item && typeof item.id === "string" && Number.isInteger(item.version))) return null;
    return data as PlanningReview;
  } catch { return null; }
}

export function planningReviewChanges(section: PlanningSection | undefined, sections: PlanningSection[]) {
  const review = readPlanningReview(section);
  if (!review) return [];
  return review.basis.filter((basis) => {
    const current = sections.find((item) => item.id === basis.id);
    return !current || (current.version ?? 0) !== basis.version || !current.content.trim()
      || Boolean(current.pendingContent.trim()) || !["CONFIRMED", "LOCKED"].includes(current.storyState);
  }).map((basis) => basis.id);
}

export function planningReviewIsCurrent(section: PlanningSection | undefined, sections: PlanningSection[]) {
  const review = readPlanningReview(section);
  // Legacy formal content remains available; its first new confirmation records an explicit review.
  return !review || review.sectionVersion === (section?.version ?? 0) && planningReviewChanges(section, sections).length === 0;
}

export function withPlanningReview(section: PlanningSection, checks: string[], basis: PlanningSection[]) {
  const review: PlanningReview = {
    sectionVersion: (section.version ?? 0) + 1,
    checks,
    basis: basis.map((item) => ({ id: item.id, version: item.version ?? 0 })),
  };
  return [...section.references.filter((reference) => !reference.startsWith(reviewPrefix)), reviewPrefix + JSON.stringify(review)];
}
