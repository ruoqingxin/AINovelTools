import { describe, expect, it } from "vitest";
import type { EntityCard } from "./tauri-client";
import { findImportDuplicates, mergeImportCandidates, type ImportCandidate } from "./entity-import-review";

const candidates: ImportCandidate[] = [
  { entityType: "CONCEPT", name: "上古纪元", description: "天地初开。\n保留原段落。", aliases: ["古纪"], tags: ["历史"], selected: true },
  { entityType: "CONCEPT", name: "纪元空白期", description: "典籍缺失。", aliases: ["空白期", "古纪"], tags: ["历史", "谜团"], selected: true },
  { entityType: "CONCEPT", name: "万道纪", description: "万道并立。", aliases: [], tags: [], selected: false },
];

describe("entity import review", () => {
  it("merges only selected candidates under the chosen name without changing the original items", () => {
    const merged = mergeImportCandidates(candidates, 1);
    expect(merged).toEqual([
      { entityType: "CONCEPT", name: "纪元空白期", description: "【上古纪元】\n天地初开。\n保留原段落。\n\n【纪元空白期】\n典籍缺失。",
        aliases: ["古纪", "空白期"], tags: ["历史", "谜团"], selected: true },
      candidates[2],
    ]);
    expect(candidates[0].description).toBe("天地初开。\n保留原段落。");
    expect(candidates[1].description).toBe("典籍缺失。");
  });

  it("does not merge into an unselected or missing candidate", () => {
    expect(mergeImportCandidates(candidates, 2)).toBe(candidates);
    expect(mergeImportCandidates(candidates, -1)).toBe(candidates);
    expect(mergeImportCandidates([candidates[0]], 0)).toEqual([candidates[0]]);
  });

  it("matches normalized names and aliases in the same type including archived entities", () => {
    const cards = [
      { entity: { id: "history", entityType: "CONCEPT", lifecycleStatus: "ARCHIVED" }, revision: { name: "古代史", aliases: [" 古纪 "] } },
      { entity: { id: "character", entityType: "CHARACTER", lifecycleStatus: "ACTIVE" }, revision: { name: "万道纪", aliases: ["空白期"] } },
    ] as EntityCard[];
    expect(findImportDuplicates(candidates, cards)).toEqual([
      { existing: ["古代史（已停用）"], matches: [cards[0]], candidates: [1] },
      { existing: ["古代史（已停用）"], matches: [cards[0]], candidates: [0] },
      { existing: [], matches: [], candidates: [] },
    ]);
    const latin = [{ ...candidates[0], name: " ＡＢＣ ", aliases: [] }, { ...candidates[1], name: "abc", aliases: [] }];
    expect(findImportDuplicates(latin, [])[0].candidates).toEqual([1]);
  });

  it("ignores empty names and does not treat merely similar phrases as duplicates", () => {
    const items = [{ ...candidates[0], name: "", aliases: [""] }, { ...candidates[1], name: " ", aliases: [] }, candidates[2]];
    expect(findImportDuplicates(items, []).every((match) => !match.candidates.length)).toBe(true);
    expect(findImportDuplicates(candidates.map((item) => ({ ...item, aliases: [] })), [])
      .every((match) => !match.candidates.length)).toBe(true);
  });

  it("keeps duplicates type-specific after manual correction and refuses cross-type merges", () => {
    const items: ImportCandidate[] = [candidates[0], { ...candidates[1], entityType: "CHARACTER" }];
    expect(findImportDuplicates(items, []).every((match) => !match.candidates.length)).toBe(true);
    expect(mergeImportCandidates(items, 0)).toBe(items);
  });

  it("preserves a shared merge target but refuses different targets or snapshots", () => {
    const mergeTarget = { id: "existing", expectedVersion: 2, expectedRevisionId: "revision-2" };
    const items = candidates.map((item) => ({ ...item, mergeTarget }));
    expect(mergeImportCandidates(items, 0)[0].mergeTarget).toEqual(mergeTarget);
    for (const target of [undefined, { ...mergeTarget, id: "other" }, { ...mergeTarget, expectedVersion: 3 }]) {
      const different = [items[0], { ...items[1], mergeTarget: target }];
      expect(mergeImportCandidates(different, 0)).toBe(different);
    }
  });

  it("retains distinct same-name entities by ID and deduplicates multiple matching names per entity", () => {
    const cards = [
      { entity: { id: "one", entityType: "CONCEPT", lifecycleStatus: "ACTIVE" }, revision: { name: "上古纪元", aliases: ["古纪"] } },
      { entity: { id: "two", entityType: "CONCEPT", lifecycleStatus: "ACTIVE" }, revision: { name: "上古纪元", aliases: ["古纪"] } },
      { entity: { id: "other", entityType: "CONCEPT", lifecycleStatus: "ACTIVE" }, revision: { name: "无关规则", aliases: [] } },
    ] as EntityCard[];
    const matches = findImportDuplicates(candidates, cards)[0];
    expect(matches.existing).toEqual(["上古纪元"]);
    expect(matches.matches.map((card) => card.entity.id)).toEqual(["one", "two"]);
  });
});
