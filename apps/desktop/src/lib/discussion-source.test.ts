import { describe, expect, it } from "vitest";
import { discussionSourceHref, parseDiscussionSource, planningTargetHref, resolveDiscussionPlanningTarget } from "./discussion-source";
import type { PlanNode } from "./tauri-client";

const nodes: PlanNode[] = [
  { id: "design", kind: "WORK_DESIGN", archived: false, title: "作品设定", parentId: null, sortOrder: 0, revision: 1 },
  { id: "chapter:1", kind: "CHAPTER", archived: false, title: "入城", parentId: null, sortOrder: 0, revision: 1 },
  { id: "old-volume", kind: "VOLUME", archived: true, title: "归档卷", parentId: null, sortOrder: 0, revision: 1 },
];

describe("discussion and planning links", () => {
  it("round trips exact source IDs and safe planning return context", () => {
    const request = { candidateId: "old-candidate", projectId: "project-1", sessionId: "session-1", sectionId: "seed-premise" };
    const back = planningTargetHref("seed-premise", "project-1");
    const url = new URL(discussionSourceHref(request, back), window.location.origin);
    expect(parseDiscussionSource(url.search)).toEqual(request);
    expect(url.searchParams.get("returnTo")).toBe(back);
  });
  it("keeps empty sources in source mode and rejects external returns", () => {
    expect(parseDiscussionSource("?sourceCandidate=")).toEqual({ candidateId: "" });
    expect(parseDiscussionSource("?sourceSession=session-1")).toEqual({ candidateId: "", sessionId: "session-1" });
    expect(parseDiscussionSource("?tab=draft")).toBeNull();
    expect(discussionSourceHref({ candidateId: "old" }, "//outside.test/planning")).not.toContain("returnTo");
  });
  it("routes chapter plans to the existing creation assistant", () => {
    const url = new URL(planningTargetHref("plan-node:chapter:1", "project-1", "CHAPTER"), window.location.origin);
    expect(url.pathname).toBe("/writing");
    expect(url.searchParams.get("assistant")).toBe("plan");
    expect(url.searchParams.get("discussionTarget")).toBe("plan-node:chapter:1");
    expect(decodeURIComponent(url.hash)).toBe("#chapter:1");
  });
  it("resolves only the requested setting or active node, without guessing a fallback", () => {
    expect(resolveDiscussionPlanningTarget("seed-premise", nodes, ["seed-premise"])?.node.id).toBe("design");
    expect(resolveDiscussionPlanningTarget("plan-node:chapter:1", nodes, [], true)?.node.id).toBe("chapter:1");
    expect(resolveDiscussionPlanningTarget("plan-node:old-volume", nodes, [])).toBeNull();
    expect(resolveDiscussionPlanningTarget("plan-node:missing", nodes, [], true)).toBeNull();
    expect(resolveDiscussionPlanningTarget("seed-premise", [], ["seed-premise"])).toBeNull();
    expect(resolveDiscussionPlanningTarget("plan-node:chapter:1", nodes, [])).toBeNull();
  });
});
