import { describe, expect, it } from "vitest";
import { aiWorkspaceHref, draftIdentity, entityIdentity, parseContentOrigin, planIdentity, planningSectionIdentity, summaryIdentity } from "./content-taxonomy";
import { parseMaterialTarget } from "./knowledge-navigation";

describe("canonical content classification", () => {
  it("distinguishes a chapter plan from chapter prose", () => {
    expect(planIdentity("CHAPTER").category).toBe("OUTLINE");
    expect(draftIdentity({ kind: "MANUSCRIPT" }).category).toBe("MANUSCRIPT");
    expect(entityIdentity("CHARACTER")).toEqual({ category: "SETTING", subtype: "人物" });
  });
  it("does not silently recategorize mixed legacy preparation notes", () => {
    expect(planningSectionIdentity("engine-protagonist").category).toBe("UNCLASSIFIED");
    expect(planningSectionIdentity("cast-core-relationship").category).toBe("UNCLASSIFIED");
    expect(planningSectionIdentity("frame-setting").category).toBe("SETTING");
    expect(planningSectionIdentity("seed-tone").category).toBe("REFERENCE");
  });
  it.each(["EXTRACTIVE_AUTO", "EXTRACTIVE_AUTO_SETTINGS", "EXTRACTIVE_AUTO_PROJECT", "MANUAL_REFERENCE"])(
    "keeps %s summaries as reference rather than primary story facts", (generationMode) => {
      expect(summaryIdentity({ generationMode }).category).toBe("REFERENCE");
    });
  it.each(["SUMMARY", "CARD"] as const)("preserves the exact %s object and project in workspace navigation", (kind) => {
    const href = aiWorkspaceHref({ workflow: "materials", projectId: "p:1", targetId: "a & b", materialKind: kind });
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/discussion");
    expect(parseMaterialTarget(url.search)).toEqual({ kind, id: "a & b", projectId: "p:1" });
  });
  it("distinguishes the writing source and chapter plan task", () => {
    const url = new URL(aiWorkspaceHref({ workflow: "writing", projectId: "p", targetId: "chapter", tab: "plan" }), "http://localhost");
    expect(url.searchParams.get("planNode")).toBe("chapter");
    expect(url.searchParams.get("assistant")).toBe("plan");
  });
  it("does not infer identity from a discussion title or accept a foreign origin", () => {
    expect(parseContentOrigin("人物讨论", "p")).toBeNull();
    const origin = { kind: "content-target", category: "SETTING", subtype: "人物", title: "沈砚", key: "ENTITY:one", projectId: "p" };
    expect(parseContentOrigin(JSON.stringify(origin), "p")).toEqual(origin);
    expect(parseContentOrigin(JSON.stringify(origin), "other")).toBeNull();
    expect(parseContentOrigin(JSON.stringify({ ...origin, category: "资料" }), "p")).toBeNull();
    expect(parseContentOrigin(JSON.stringify({ ...origin, category: "toString" }), "p")).toBeNull();
  });
});
