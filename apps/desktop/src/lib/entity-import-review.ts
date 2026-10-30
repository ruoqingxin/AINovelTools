import type { EntityCard, EntityType, InputEntityImportTarget } from "./tauri-client";

export type ImportCandidate = {
  entityType: EntityType;
  name: string;
  description: string;
  aliases: string[];
  tags: string[];
  selected: boolean;
  mergeTarget?: InputEntityImportTarget;
};

const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
const namesOf = (item: Pick<ImportCandidate, "name" | "aliases">) =>
  new Set([item.name, ...item.aliases].map(normalize).filter(Boolean));

export function findImportDuplicates(items: ImportCandidate[], cards: EntityCard[]) {
  const existing = new Map<string, Map<string, EntityCard>>();
  for (const card of cards) {
    for (const name of namesOf(card.revision)) {
      const key = `${card.entity.entityType}:${name}`;
      const matches = existing.get(key) ?? new Map<string, EntityCard>();
      matches.set(card.entity.id, card);
      existing.set(key, matches);
    }
  }
  const candidateNames = items.map(namesOf);
  return candidateNames.map((names, index) => {
    const matches = [...new Map([...names].flatMap((name) =>
      [...existing.get(`${items[index].entityType}:${name}`) ?? []])).values()];
    return {
      existing: [...new Set(matches.map((card) =>
        `${card.revision.name}${card.entity.lifecycleStatus === "ARCHIVED" ? "（已停用）" : ""}`))],
      matches,
      candidates: candidateNames.flatMap((other, otherIndex) =>
        otherIndex !== index && items[index].entityType === items[otherIndex].entityType
          && [...names].some((name) => other.has(name)) ? [otherIndex] : []),
    };
  });
}

export function mergeImportCandidates(items: ImportCandidate[], primaryIndex: number): ImportCandidate[] {
  const selected = items.filter((item) => item.selected);
  const primary = items[primaryIndex];
  if (selected.length < 2 || !primary?.selected || selected.some((item) => item.entityType !== primary.entityType
    || JSON.stringify(item.mergeTarget) !== JSON.stringify(primary.mergeTarget))) return items;
  const merged: ImportCandidate = {
    entityType: primary.entityType,
    name: primary.name,
    description: selected.map((item) => `【${item.name}】\n${item.description}`).join("\n\n"),
    aliases: [...new Set(selected.flatMap((item) => item.aliases))],
    tags: [...new Set(selected.flatMap((item) => item.tags))],
    selected: true,
    ...(primary.mergeTarget ? { mergeTarget: primary.mergeTarget } : {}),
  };
  return items.flatMap((item, index) => index === primaryIndex ? [merged] : item.selected ? [] : [item]);
}
