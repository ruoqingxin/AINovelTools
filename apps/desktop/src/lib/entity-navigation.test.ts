import { describe, expect, it } from "vitest";
import { entityChapterHref, entityHref } from "./entity-navigation";
describe("entity and chapter links", () => {
  it("preserves exact entity and project IDs and safe search returns", () => {
    const url = new URL(entityHref("entity:1", "project:1", "/search?q=沈砚&type=ENTITY"), window.location.origin);
    expect(url.pathname).toBe("/knowledge");
    expect(url.searchParams.get("entity")).toBe("entity:1");
    expect(url.searchParams.get("targetProject")).toBe("project:1");
    const back = new URL(url.searchParams.get("returnTo")!, window.location.origin);
    expect(back.pathname).toBe("/search");
    expect(back.searchParams.get("q")).toBe("沈砚");
    expect(back.searchParams.get("type")).toBe("ENTITY");
  });
  it("routes chapter references to the existing assistant and round-trips entity returns", () => {
    const back = entityHref("entity-1", "project-1");
    const url = new URL(entityChapterHref("chapter:1", "project-1", back), window.location.origin);
    expect(url.searchParams.get("referenceChapter")).toBe("chapter:1");
    expect(url.searchParams.get("assistant")).toBe("plan");
    expect(url.searchParams.get("returnTo")).toBe(back);
    expect(decodeURIComponent(url.hash)).toBe("#chapter:1");
  });
  it("rejects external and protocol-relative returns", () => {
    expect(entityHref("id", "project", "//outside.test")).not.toContain("returnTo");
    expect(entityChapterHref("id", "project", "javascript:alert(1)")).not.toContain("returnTo");
  });
});
