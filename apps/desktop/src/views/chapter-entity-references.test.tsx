import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityCard } from "../lib/tauri-client";
import { ChapterEntityReferencePanel } from "./chapter-entity-references";

const mocks = vi.hoisted(() => ({ getCurrentProject: vi.fn(), getChapterEntityReferences: vi.fn(),
  listEntityCards: vi.fn(), saveChapterEntityReferences: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
const card = (id: string, name = id): EntityCard => ({
  entity: { id, projectId: "project-1", entityType: "CHARACTER", lifecycleStatus: "ACTIVE", currentRevisionId: `revision-${id}`,
    version: 1, createdAt: "", updatedAt: "" },
  revision: { id: `revision-${id}`, entityId: id, name, revision: 1, description: "作者资料", aliases: [], tags: [],
    fixedAttributesJson: "{}", sourceVersion: null, baseRevisionId: null, createdAt: "" },
});
const empty = { projectId: "project-1", chapterId: "chapter-1", version: 0, entities: [] };
function renderPanel(active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPendingChange = vi.fn();
  const ui = (next: boolean) => <QueryClientProvider client={client}>
    <ChapterEntityReferencePanel chapterId="chapter-1" active={next} onPendingChange={onPendingChange} />
  </QueryClientProvider>;
  return { ...render(ui(active)), client, ui, onPendingChange };
}
function expand() {
  const details = screen.getByText("本章参考资料").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
describe("chapter reference selection", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState(null, "", "/writing");
    mocks.getCurrentProject.mockResolvedValue({ projectId: "project-1" });
    mocks.getChapterEntityReferences.mockResolvedValue(empty);
    mocks.listEntityCards.mockResolvedValue([card("entity-1", "沈砚"), card("entity-2", "守门人")]);
    mocks.saveChapterEntityReferences.mockImplementation(async (input) => ({ ...empty, version: input.expectedVersion + 1,
      entities: input.entityIds.map((id: string) => card(id)) }));
  });
  it("queries lazily and keeps edits while hidden without refetching", async () => {
    const { rerender, client, ui, onPendingChange } = renderPanel();
    expect(mocks.getChapterEntityReferences).not.toHaveBeenCalled();
    expect(mocks.listEntityCards).not.toHaveBeenCalled();
    expand();
    const input = await screen.findByRole("checkbox", { name: /沈砚/ });
    fireEvent.click(input);
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(true));
    rerender(ui(false));
    await client.invalidateQueries({ queryKey: ["chapter-entity-references"] });
    expect(mocks.getChapterEntityReferences).toHaveBeenCalledTimes(1);
    expect(input).toBeChecked();
    rerender(ui(true));
    await waitFor(() => expect(mocks.getChapterEntityReferences).toHaveBeenCalledTimes(2));
    expect(input).toBeChecked();
  });
  it("saves a versioned set and links to the exact entity with a chapter return path", async () => {
    renderPanel();
    expand();
    fireEvent.click(await screen.findByRole("checkbox", { name: /沈砚/ }));
    const url = new URL(screen.getByRole("link", { name: "查看沈砚" }).getAttribute("href")!, window.location.origin);
    expect(url.searchParams.get("entity")).toBe("entity-1");
    expect(url.searchParams.get("returnTo")).toContain("referenceChapter=chapter-1");
    fireEvent.click(screen.getByRole("button", { name: "保存参考资料" }));
    await screen.findByText("本章参考资料已保存。");
    expect(mocks.saveChapterEntityReferences).toHaveBeenCalledWith({ projectId: "project-1", chapterId: "chapter-1",
      expectedVersion: 0, entityIds: ["entity-1"] });
    expect(screen.getByRole("button", { name: "保存参考资料" })).toBeDisabled();
  });
  it("refreshes clean selections after an edit is reverted to its baseline", async () => {
    const { client } = renderPanel();
    expand();
    const first = await screen.findByRole("checkbox", { name: /沈砚/ });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(screen.getByRole("button", { name: "保存参考资料" })).toBeDisabled();
    mocks.getChapterEntityReferences.mockResolvedValue({ ...empty, version: 1, entities: [card("entity-2")] });
    await client.invalidateQueries({ queryKey: ["chapter-entity-references"] });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /守门人/ })).toBeChecked());
    expect(first).not.toBeChecked();
    expect(screen.getByRole("button", { name: "保存参考资料" })).toBeDisabled();
  });
  it("retains selection changes made during saving and uses the acknowledged version next time", async () => {
    let resolve!: (value: unknown) => void;
    mocks.saveChapterEntityReferences.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    renderPanel();
    expand();
    const first = await screen.findByRole("checkbox", { name: /沈砚/ });
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "保存参考资料" }));
    await waitFor(() => expect(mocks.saveChapterEntityReferences).toHaveBeenCalled());
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("checkbox", { name: /守门人/ }));
    resolve({ ...empty, version: 1, entities: [card("entity-1")] });
    await screen.findByText("本章参考资料已保存。");
    expect(first).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /守门人/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "保存参考资料" }));
    await waitFor(() => expect(mocks.saveChapterEntityReferences).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedVersion: 1, entityIds: ["entity-2"],
    })));
  });
  it("preserves local edits on conflict, including a cancelled explicit reload", async () => {
    mocks.saveChapterEntityReferences.mockRejectedValueOnce(new Error("关联版本冲突"));
    renderPanel();
    expand();
    const input = await screen.findByRole("checkbox", { name: /沈砚/ });
    fireEvent.click(input);
    mocks.getChapterEntityReferences.mockResolvedValue({ ...empty, version: 2, entities: [card("entity-2")] });
    fireEvent.click(screen.getByRole("button", { name: "保存参考资料" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("关联版本冲突");
    expect(input).toBeChecked();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "读取最新关联" }));
    expect(input).toBeChecked();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "读取最新关联" }));
    await waitFor(() => expect(input).not.toBeChecked());
    expect(screen.getByRole("checkbox", { name: /守门人/ })).toBeChecked();
  });
  it("keeps archived selections removable and caps new selections at eight", async () => {
    const selected = Array.from({ length: 8 }, (_, i) => card(`entity-${i}`));
    selected[0].entity.lifecycleStatus = "ARCHIVED";
    mocks.getChapterEntityReferences.mockResolvedValue({ ...empty, version: 1, entities: selected });
    mocks.listEntityCards.mockResolvedValue([...selected, card("extra")]);
    renderPanel();
    expand();
    expect(await screen.findByRole("checkbox", { name: /entity-0/ })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /extra/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /entity-0/ }));
    expect(screen.getByRole("checkbox", { name: /extra/ })).toBeEnabled();
  });
  it("retries failed reads for the same chapter without saving", async () => {
    mocks.getChapterEntityReferences.mockRejectedValueOnce(new Error("关联读取失败"));
    renderPanel();
    expand();
    expect(await screen.findByRole("alert")).toHaveTextContent("关联读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("checkbox", { name: /沈砚/ })).toBeVisible();
    expect(mocks.getChapterEntityReferences).toHaveBeenLastCalledWith("project-1", "chapter-1");
    expect(mocks.saveChapterEntityReferences).not.toHaveBeenCalled();
  });
});
