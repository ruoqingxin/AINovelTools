import { describe, expect, it } from "vitest";
import { primaryDestination, primaryNavigation, workspaceLabel } from "./navigation";

describe("workspace navigation", () => {
  it("puts creation preparation before the remaining workspaces", () => {
    expect(primaryNavigation.map((item) => item.label)).toEqual(["筹备", "大纲", "正文", "共创", "资料", "待办"]);
    expect(primaryDestination("/planning", "?mode=prepare")).toBe("/preparation");
    expect(primaryDestination("/planning", "?mode=structure")).toBe("/planning");
    expect(primaryDestination("/discussion", "?work=preparation&targetProject=p")).toBe("/discussion");
    expect(primaryDestination("/discussion", "?work=section&targetProject=p&item=seed-tone")).toBe("/discussion");
  });
  it.each([
    ["/preparation", "/preparation"],
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
    expect(workspaceLabel("/discussion")).toBe("共创");
  });
  it.each(["preparation", "section", "planning", "writing", "entity", "records", "materials", "review"])(
    "keeps %s editing inside coauthor navigation", (work) => {
      expect(primaryDestination("/discussion", `?work=${work}&targetProject=p&item=seed-tone`)).toBe("/discussion");
    });
});
