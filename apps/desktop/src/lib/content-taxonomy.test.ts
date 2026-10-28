import { describe, expect, it } from "vitest";
import { aiWorkspaceHref, aiWorkspaceReturnHref, draftIdentity, entityIdentity, parseContentOrigin, planIdentity, planningSectionIdentity, summaryIdentity } from "./content-taxonomy";
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
  it.each([
    ["entity", "entity=a%26b", "/knowledge", "entity", "a&b"],
    ["writing", "planNode=c", "/writing", "planNode", "c"],
    ["writing", "planNode=c&tab=plan", "/planning", "planNode", "c"],
    ["materials", "card=rule", "/knowledge/materials", "card", "rule"],
    ["records", "objectId=r&tab=events", "/knowledge/records", "objectId", "r"],
  ])("returns %s work to its exact formal object", (work, detail, path, key, value) => {
    const url = new URL(aiWorkspaceReturnHref(new URLSearchParams(`work=${work}&targetProject=p&${detail}`)), window.location.origin);
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get(key)).toBe(value);
    expect(url.searchParams.get("targetProject")).toBe("p");
    if (work === "records") expect(url.searchParams.get("tab")).toBe("events");
  });
  it("preserves a safe source location and rejects external return destinations", () => {
    const href = aiWorkspaceHref({ workflow: "entity", projectId: "p", returnTo: "/search?q=城#result" });
    expect(aiWorkspaceReturnHref(new URL(href, window.location.origin).searchParams)).toBe("/search?q=%E5%9F%8E#result");
    const unsafe = aiWorkspaceHref({ workflow: "entity", projectId: "p", returnTo: "//other.test" });
    expect(new URL(unsafe, window.location.origin).searchParams.has("returnTo")).toBe(false);
    expect(aiWorkspaceReturnHref(new URLSearchParams("work=entity&returnTo=https://other.test"))).toBe("/knowledge");
  });
  it("retains the preparation section and reference list type when returning", () => {
    const section = new URL(aiWorkspaceReturnHref(new URLSearchParams("work=section&targetProject=p&item=seed-tone")), window.location.origin);
    expect(section.pathname).toBe("/planning");
    expect(section.searchParams.get("mode")).toBe("prepare");
    expect(section.searchParams.get("note")).toBe("seed-tone");
    expect(section.hash).toBe("");
    const cards = new URL(aiWorkspaceReturnHref(new URLSearchParams("work=materials&targetProject=p&materialKind=CARD")), window.location.origin);
    expect(cards.searchParams.get("materialKind")).toBe("CARD");
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
