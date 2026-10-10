import { describe, expect, it } from "vitest";
import { materialHref, parseMaterialTarget, planNodeHref, resolvePlanNodeTarget, summaryManuscriptHref } from "./knowledge-navigation";
import { sourceReturnTo } from "./manuscript-source";
import type { PlanNode, SummaryMaterial } from "./tauri-client";

const node: PlanNode = { id: "scene-1", kind: "SCENE", parentId: "chapter-1", title: "重逢", archived: false, revision: 1, sortOrder: 0 };
const summary: SummaryMaterial = {
  id: "summary-1", projectId: "project-1", kind: "CHAPTER", precision: "L0", sourceId: "chapter-1",
  sourceVersion: "manuscript:11111111-1111-1111-1111-111111111111", content: "摘要",
  generationMode: "EXTRACTIVE_AUTO", lifecycleStatus: "STALE", createdAt: "", updatedAt: "",
};

describe("knowledge navigation", () => {
  it.each(["SUMMARY", "CARD"] as const)("encodes exact %s identity and preserves a safe search return", (kind) => {
    const url = new URL(materialHref(kind, "object:/?&", "project-1", "/search?q=城&type=CARD"), window.location.origin);
    expect(parseMaterialTarget(url.search)).toEqual({ kind, id: "object:/?&", projectId: "project-1" });
    expect(new URL(url.searchParams.get("returnTo")!, window.location.origin).searchParams.get("q")).toBe("城");
    expect(materialHref(kind, "1", "p", "https://other.test")).not.toContain("returnTo");
  });

  it("keeps missing and ambiguous targets explicit", () => {
    expect(parseMaterialTarget("?other=1")).toBeNull();
    expect(parseMaterialTarget("?summary=")).toEqual({ kind: "SUMMARY", id: "", projectId: "" });
    expect(parseMaterialTarget("?summary=1&card=2")?.kind).toBeNull();
  });

  it("opens only an exact active plan in the expected project", () => {
    expect(resolvePlanNodeTarget("scene-1", "project-1", "project-1", [node])).toBe(node);
    for (const [id, project] of [["missing", "project-1"], ["scene-1", "foreign"], ["scene-1", null], ["", "project-1"]]) {
      expect(resolvePlanNodeTarget(id!, project, "project-1", [node])).toBeNull();
    }
    expect(resolvePlanNodeTarget(node.id, "project-1", "project-1", [{ ...node, archived: true }])).toBeNull();
    expect(resolvePlanNodeTarget(node.id, "project-1", "project-1", [node], true)).toBeNull();
    expect(resolvePlanNodeTarget("chapter-1", "project-1", "project-1", [{ ...node, id: "chapter-1", kind: "CHAPTER" }], true)?.kind).toBe("CHAPTER");
  });

  it("opens chapter plans in the existing writing assistant", () => {
    const url = new URL(planNodeHref("chapter-1", "project-1", "/search?q=城&type=PLAN", true), window.location.origin);
    expect(url.pathname).toBe("/writing");
    expect(url.searchParams.get("planNode")).toBe("chapter-1");
    expect(url.searchParams.get("assistant")).toBe("plan");
    expect(url.searchParams.get("targetProject")).toBe("project-1");
    expect(new URL(url.searchParams.get("returnTo")!, window.location.origin).searchParams.get("q")).toBe("城");
  });

  it("links generated memory to its recorded manuscript revision even when stale", () => {
    const back = materialHref("SUMMARY", summary.id, summary.projectId, "/search?q=城&type=SUMMARY");
    const url = new URL(summaryManuscriptHref(summary, back)!, window.location.origin);
    expect(url.searchParams.get("sourceChapter")).toBe("chapter-1");
    expect(url.searchParams.get("sourceRevision")).toBe("11111111-1111-1111-1111-111111111111");
    expect(url.searchParams.get("returnTo")).toBe(back);
    expect(sourceReturnTo(back)).toBe(back);
  });

  it.each([
    { generationMode: "MANUAL_REFERENCE" }, { generationMode: "EXTRACTIVE_AUTO_SETTINGS" },
    { sourceId: null }, { sourceVersion: "chapter:2" }, { sourceVersion: "manuscript:missing" }, { kind: "CHARACTER" as const },
  ])("does not infer evidence from an arbitrary source label: %j", (change) => {
    expect(summaryManuscriptHref({ ...summary, ...change }, "/search")).toBeNull();
  });
});
