import { describe, expect, it } from "vitest";
import type { PlanNode } from "../lib/tauri-client";
import { buildWorkspaceNodeIndex, groupNodesByParent } from "./project-workspace-index";

const node = (id: string, kind: PlanNode["kind"], parentId: string | null = null, archived = false): PlanNode => ({
  id, kind, parentId, archived, title: id, revision: 1, sortOrder: 0,
});

describe("workspace node indexes", () => {
  it("preserves input ordering, first roots and archived lookup without including archived chapters", () => {
    const nodes = [
      node("manager", "VOLUME_MANAGER"),
      node("volume", "VOLUME", "manager"),
      node("first", "CHAPTER", "volume"),
      node("archived", "CHAPTER", "volume", true),
      node("second", "CHAPTER", "volume"),
      node("duplicate-root", "VOLUME_MANAGER"),
    ];
    const index = buildWorkspaceNodeIndex(nodes);
    expect(index.rootsByKind.get("VOLUME_MANAGER")).toBe(nodes[0]);
    expect(index.nodesById.get("archived")).toBe(nodes[3]);
    expect(index.nodesByKind.CHAPTER.map((item) => item.id)).toEqual(["first", "second"]);
    expect(index.chaptersByVolume.get("volume")).toEqual([nodes[2], nodes[4]]);
    expect(groupNodesByParent(nodes).get(null)).toEqual([nodes[0], nodes[5]]);
    expect(index.nodesByKind.SCENE).toEqual([]);
  });

  it("handles empty projects", () => {
    const index = buildWorkspaceNodeIndex([]);
    expect(index.activeNodes).toEqual([]);
    expect(index.chaptersByVolume.size).toBe(0);
    expect(index.rootsByKind.size).toBe(0);
  });
});
