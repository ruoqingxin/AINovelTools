import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChapter } from "./create-chapter";
import type { PlanNode } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ createPlanNode: vi.fn(), getCurrentProject: vi.fn(), listPlanNodes: vi.fn() }));
vi.mock("../lib/tauri-client", () => mocks);
const manager = { id: "manager", kind: "VOLUME_MANAGER", parentId: null, archived: false } as PlanNode;
const volume = { id: "volume", title: "第一卷", kind: "VOLUME", parentId: "manager", archived: false } as PlanNode;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentProject.mockResolvedValue({ projectId: "project" });
  mocks.listPlanNodes.mockResolvedValue([]);
});
describe("createChapter", () => {
  it("builds only missing structural parents before a first chapter", async () => {
    mocks.createPlanNode.mockResolvedValueOnce(manager).mockResolvedValueOnce(volume).mockResolvedValueOnce({ id: "chapter" });
    await createChapter({ projectId: "project", title: "第1章" });
    expect(mocks.createPlanNode.mock.calls.map(([input]) => input.kind)).toEqual(["VOLUME_MANAGER", "VOLUME", "CHAPTER"]);
  });
  it("reuses parents created before a partial failure on retry", async () => {
    const nodes: PlanNode[] = [];
    mocks.listPlanNodes.mockImplementation(() => Promise.resolve([...nodes]));
    mocks.createPlanNode.mockImplementation(async (input) => {
      if (input.kind === "CHAPTER") throw new Error("章节创建失败");
      const node = input.kind === "VOLUME_MANAGER" ? manager : volume;
      nodes.push(node);
      return node;
    });
    await expect(createChapter({ projectId: "project", title: "第1章" })).rejects.toThrow("章节创建失败");
    mocks.createPlanNode.mockResolvedValueOnce({ id: "chapter" });
    await createChapter({ projectId: "project", title: "第1章" });
    expect(mocks.createPlanNode.mock.calls.map(([input]) => input.kind)).toEqual(["VOLUME_MANAGER", "VOLUME", "CHAPTER", "CHAPTER"]);
  });
  it("rejects a foreign project or stale volume before creating a chapter", async () => {
    mocks.getCurrentProject.mockResolvedValueOnce({ projectId: "foreign" });
    await expect(createChapter({ projectId: "project", title: "first" })).rejects.toThrow("作品已切换");
    await expect(createChapter({ projectId: "project", title: "first", volumeId: "missing" })).rejects.toThrow("分卷已不可用");
    expect(mocks.createPlanNode).not.toHaveBeenCalled();
  });
});
