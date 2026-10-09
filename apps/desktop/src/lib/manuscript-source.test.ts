import { describe, expect, it } from "vitest";
import { manuscriptSourceHref, parseManuscriptSource, sourceReturnTo } from "./manuscript-source";

describe("manuscript source navigation", () => {
  it("round trips opaque block IDs and structured return queries", () => {
    const request = { projectId: "project-1", revisionId: "old-revision", blockId: 'block:1"]',
      chapterId: "chapter-1", evidenceAnchorId: "anchor-1" };
    const href = manuscriptSourceHref(request, "/search?q=%E9%9B%BE%E5%9F%8E&type=MANUSCRIPT");
    const url = new URL(href, window.location.origin);
    expect(parseManuscriptSource(url.search)).toEqual(request);
    expect(url.searchParams.get("returnTo")).toBe("/search?q=%E9%9B%BE%E5%9F%8E&type=MANUSCRIPT");
  });

  it("keeps invalid source links in source mode instead of opening editable latest text", () => {
    expect(parseManuscriptSource("?sourceRevision=")).toEqual({});
    expect(parseManuscriptSource("?sourceBlock=")).toEqual({});
    expect(parseManuscriptSource("?tab=extraction")).toBeNull();
  });

  it.each(["https://outside.test/search", "//outside.test/search", "/\\outside.test/search",
    "/settings", "/writing/../settings", "javascript:alert(1)", "/%2foutside.test/search"])(
    "rejects unsafe or unrelated returns: %s", (value) => {
      expect(sourceReturnTo(value)).toBeNull();
      expect(new URL(manuscriptSourceHref({ revisionId: "old" }, value), window.location.origin).searchParams.has("returnTo")).toBe(false);
    });

  it("preserves a valid chapter and knowledge panel return", () => {
    expect(sourceReturnTo("/writing?tab=extraction&knowledge=facts#chapter-1"))
      .toBe("/writing?tab=extraction&knowledge=facts#chapter-1");
  });
});
