import type { PlanningSection } from "../lib/tauri-client";

export const bookPreparationFields = {
  genre: "题材类型",
  targetWords: "目标字数",
  perspective: "叙事视角",
  style: "语言风格",
  premise: "核心故事",
  tone: "整体基调",
  pace: "节奏偏好",
  audience: "目标读者",
  experience: "阅读体验",
  boundaries: "创作边界",
  ending: "结局倾向",
  notes: "补充记录",
} as const;
export type BookPreparation = Record<keyof typeof bookPreparationFields, string>;
export const basicBookPreparationKeys = ["targetWords", "perspective", "style", "tone"] as const;
export const legacyStoryDirectionItems = [
  { key: "genre", item: "genre", title: "题材" },
  { key: "premise", item: "premise", title: "故事核心" },
  { key: "experience", item: "promise", title: "阅读期待" },
  { key: "ending", item: "ending", title: "结局方向" },
] as const;
const metadataPrefix = "book-preparation:v1:";

export function emptyBookPreparation(): BookPreparation {
  return Object.fromEntries(Object.keys(bookPreparationFields).map((key) => [key, ""])) as BookPreparation;
}

export function bookPreparationContent(fields: BookPreparation) {
  return (Object.entries(bookPreparationFields) as [keyof BookPreparation, string][])
    .filter(([key]) => fields[key].trim())
    .map(([key, label]) => `【${label}】\n${fields[key]}${key === "targetWords" ? " 万字" : ""}`)
    .join("\n\n");
}

export function readBookPreparation(section?: Pick<PlanningSection, "content" | "references">): BookPreparation {
  if (!section) return emptyBookPreparation();
  for (const reference of section.references) {
    if (!reference.startsWith(metadataPrefix)) continue;
    try {
      const fields: unknown = JSON.parse(reference.slice(metadataPrefix.length));
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
      const record = fields as Record<string, unknown>;
      if (!Object.keys(bookPreparationFields).every((key) => typeof record[key] === "string")) continue;
      const parsed = Object.fromEntries(Object.keys(bookPreparationFields).map((key) => [key, record[key]])) as BookPreparation;
      // External edits or adopted AI prose must never be replaced by stale form metadata.
      if (bookPreparationContent(parsed) === section.content) return parsed;
    } catch { /* Keep unstructured author notes intact. */ }
  }
  return { ...emptyBookPreparation(), notes: section.content };
}

export function withBookPreparation(section: PlanningSection, fields: BookPreparation): PlanningSection {
  return {
    ...section,
    content: bookPreparationContent(fields),
    references: [...section.references.filter((entry) => !entry.startsWith(metadataPrefix)), metadataPrefix + JSON.stringify(fields)],
  };
}

export function changedBookDirections(before: PlanningSection, after: PlanningSection) {
  const previous = readBookPreparation(before);
  const next = readBookPreparation(after);
  return (["genre", "targetWords", "perspective", "style", "premise", "tone", "pace", "boundaries", "ending"] as const)
    .filter((key) => previous[key].trim() && previous[key] !== next[key])
    .map((key) => bookPreparationFields[key]);
}
