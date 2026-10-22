import type { DiscussionSession } from "./tauri-client";

export type PlanningDiscussionFocus = {
  kind: "planning-section";
  sectionId: string;
  title: string;
  question: string;
};

export function planningDiscussionFocus(session: DiscussionSession): PlanningDiscussionFocus | null {
  if (session.scopeKind !== "PROJECT" || !session.scopeText) return null;
  try {
    const value = JSON.parse(session.scopeText) as Partial<PlanningDiscussionFocus> | null;
    return value?.kind === "planning-section" && typeof value.sectionId === "string"
      && typeof value.title === "string" && typeof value.question === "string"
      ? value as PlanningDiscussionFocus : null;
  } catch { return null; }
}
