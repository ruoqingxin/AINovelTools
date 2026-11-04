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

const detailTitles = new Set([
  "概述", "定义", "起源", "历史", "背景", "作用", "用途", "机制", "规则", "划分", "分类",
  "等级", "等级划分", "判定标准", "发现", "发现方式", "接入", "重复接入", "进入",
  "接入条件", "进入条件", "使用条件", "适用条件", "前置条件", "限制", "接入限制",
  "重复接入限制", "使用限制", "例外", "代价", "能力", "特征",
]);

export function isImportDetailOf(name: string, subject: Pick<ImportCandidate, "name" | "aliases">) {
  const title = normalize(name);
  return [...namesOf(subject)].some((parent) => {
    if (parent.length < 2 || !title.startsWith(parent)) return false;
    const suffix = title.slice(parent.length).replace(/^[\s:：·\-—/的]+/, "");
    return suffix.length > 0 && suffix.split(/[与及和、/&]/).every((part) => detailTitles.has(part));
  });
}

export function findImportOrganizationSuggestions(items: ImportCandidate[]) {
  const owners = items.map((item, index) => {
    if (!item.selected || item.entityType !== "CONCEPT") return index;
    const parents = items.flatMap((parent, parentIndex) =>
      parentIndex !== index && parent.selected && parent.entityType === item.entityType
        && normalize(parent.name).length < normalize(item.name).length
        && JSON.stringify(parent.mergeTarget) === JSON.stringify(item.mergeTarget)
        && isImportDetailOf(item.name, parent) ? [parentIndex] : []);
    return parents.sort((a, b) => normalize(items[a].name).length - normalize(items[b].name).length)[0] ?? index;
  });
  const groups = new Map<number, number[]>();
  owners.forEach((owner, index) => {
    let root = owner;
    while (owners[root] !== root) root = owners[root];
    const indices = groups.get(root) ?? [];
    indices.push(index);
    groups.set(root, indices);
  });
  return [...groups].flatMap(([primaryIndex, indices]) => indices.length > 1 ? [{ primaryIndex, indices }] : []);
}

export function mergeImportCandidates(items: ImportCandidate[], primaryIndex: number, indices?: number[]): ImportCandidate[] {
  const included = indices ? new Set(indices) : null;
  if (included && ([...included].some((index) => !items[index]?.selected) || !included.has(primaryIndex))) return items;
  const selected = items.filter((item, index) => item.selected && (!included || included.has(index)));
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
  return items.flatMap((item, index) => index === primaryIndex ? [merged]
    : item.selected && (!included || included.has(index)) ? [] : [item]);
}
