import { describe, expect, it } from "vitest";
import { primaryDestination, primaryNavigation, workspaceLabel } from "./navigation";

describe("workspace navigation", () => {
  it("unifies preparation and outlines into a single planning destination", () => {
    expect(primaryNavigation.map((item) => item.label)).toEqual(["大纲规划", "写作", "构思", "资料", "待办"]);
  });
  it.each([
    ["/preparation", "/planning"],
    ["/writing", "/writing"], ["/chapters", "/writing"],
    ["/planning", "/planning"], ["/discussion", "/discussion"],
    ["/knowledge", "/knowledge"], ["/knowledge/settings", "/knowledge"],
    ["/knowledge/records", "/knowledge"], ["/knowledge/materials", "/knowledge"],
    ["/knowledge/review", "/review"], ["/review", "/review"],
  ])("maps %s to %s", (path, destination) => {
    expect(primaryDestination(path)).toBe(destination);
  });
  it.each(["/", "/search", "/jobs", "/settings", "/knowledge-other"])("does not treat %s as a business destination", (path) => {
    expect(primaryDestination(path)).toBeUndefined();
  });
  it("names global tools separately", () => {
    expect(workspaceLabel("/jobs")).toBe("后台活动");
    expect(workspaceLabel("/")).toBe("作品管理");
  });
});
