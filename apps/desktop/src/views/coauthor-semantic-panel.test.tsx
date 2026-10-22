import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmActionProvider } from "../shell/confirm-action-provider";
import { CoauthorSemanticPanel } from "./coauthor-semantic-panel";
import type { CoauthorScope, CoauthorSemanticStatus } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/ipc-transport", () => mocks);
const scope: CoauthorScope = { projectId: "p", sessionId: "s" };
const disabled: CoauthorSemanticStatus = {
  settings: { version: 0, profileId: null, fingerprint: "", kinds: [] },
  totalChunks: 0, indexedChunks: 0, pendingSourceUpdates: 3,
};
const enabled: CoauthorSemanticStatus = {
  settings: { version: 1, profileId: "embedding", fingerprint: "f1", kinds: ["ENTITY"] },
  totalChunks: 17, indexedChunks: 8, pendingSourceUpdates: 0,
};
const model = { id: "embedding", capability: "EMBEDDING", privacyLevel: "ALLOW_CLOUD", hasSecret: true,
  name: "测试向量", baseUrl: "http://localhost:9000/v1", modelId: "embed-test", provider: "SILICON_FLOW" };
let saved: CoauthorSemanticStatus;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (current = scope) => <QueryClientProvider client={client}><ConfirmActionProvider>
    <CoauthorSemanticPanel key={`${current.projectId}:${current.sessionId}`} scope={current} />
  </ConfirmActionProvider></QueryClientProvider>;
  const view = render(tree());
  return { client, view, tree };
}
beforeEach(() => {
  vi.clearAllMocks(); saved = structuredClone(disabled);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_coauthor_semantic_status") return structuredClone(saved);
    if (command === "list_model_profiles") return [model];
    if (command === "save_coauthor_semantic_settings") return structuredClone(enabled);
    if (command === "build_coauthor_semantic_batch") return {
      status: { ...enabled, indexedChunks: 16 }, sentChars: 9600, sentChunks: 8,
    };
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(cleanup);

it("opens status without granting authorization, building vectors or starting a model", async () => {
  mount();
  expect(await screen.findByText("项目语义检索未启用")).toBeVisible();
  expect(screen.getByText("资料索引尚未更新完，分块总数不是全部资料的最终总量。")).toBeVisible();
  expect(screen.getByRole("button", { name: "建立下一批" })).toBeDisabled();
  expect(mocks.invoke.mock.calls.every(([name]) => name === "get_coauthor_semantic_status" || name === "list_model_profiles")).toBe(true);
});

it("requires explicit confirmation with endpoint and sends exact selected categories and profile snapshot", async () => {
  mount(); await screen.findByRole("option", { name: "测试向量" });
  fireEvent.change(screen.getByRole("combobox", { name: "向量模型" }), { target: { value: "embedding" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "正文" }));
  fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
  const confirm = await screen.findByRole("alertdialog", { name: "授权项目语义检索" });
  expect(confirm).toHaveTextContent(model.baseUrl);
  expect(confirm).toHaveTextContent("可能产生费用");
  expect(mocks.invoke.mock.calls.some(([name]) => name === "save_coauthor_semantic_settings")).toBe(false);
  fireEvent.click(within(confirm).getByRole("button", { name: "确认授权" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("save_coauthor_semantic_settings", {
    scope, expectedVersion: 0, kinds: ["ENTITY", "MANUSCRIPT"], selection: {
      profileId: model.id, baseUrl: model.baseUrl, modelId: model.modelId, provider: model.provider, privacyLevel: model.privacyLevel,
    },
  }));
  expect(mocks.invoke.mock.calls.some(([name]) => name === "build_coauthor_semantic_batch")).toBe(false);
});

it("builds only one explicitly confirmed batch and shows resumable progress and sent characters", async () => {
  saved = structuredClone(enabled); mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "建立下一批" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "建立下一批" }));
  const confirm = await screen.findByRole("alertdialog", { name: "建立一批语义索引" });
  fireEvent.click(within(confirm).getByRole("button", { name: "建立本批" }));
  expect(await screen.findByText("本批发送 8 块、9600 字。")).toBeVisible();
  expect(screen.getByText("向量分块 16 / 17 · 资料索引待更新 0 项")).toBeVisible();
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "build_coauthor_semantic_batch")).toHaveLength(1);
  expect(mocks.invoke).toHaveBeenCalledWith("build_coauthor_semantic_batch", { scope, expectedVersion: 1 });
});

it("does not build after a cancelled confirmation or while authorization edits are unsaved", async () => {
  saved = structuredClone(enabled); mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "建立下一批" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "建立下一批" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "正文" }));
  expect(screen.getByRole("button", { name: "建立下一批" })).toBeDisabled();
  expect(mocks.invoke.mock.calls.some(([name]) => name === "build_coauthor_semantic_batch")).toBe(false);
});

it("clears only derived vectors after confirmation without rebuilding or deleting author sources", async () => {
  saved = structuredClone(enabled);
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === "clear_coauthor_semantic_cache"
    ? { ...enabled, settings: { ...enabled.settings, version: 2 }, indexedChunks: 0 } : original(command, ...args));
  mount(); await waitFor(() => expect(screen.getByRole("button", { name: "清除向量缓存" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "清除向量缓存" }));
  const confirm = await screen.findByRole("alertdialog", { name: "清除向量缓存" });
  expect(confirm).toHaveTextContent("不删除正文、设定或证据");
  fireEvent.click(within(confirm).getByRole("button", { name: "清除缓存" }));
  expect(await screen.findByText("向量分块 0 / 17 · 资料索引待更新 0 项")).toBeVisible();
  expect(mocks.invoke).toHaveBeenCalledWith("clear_coauthor_semantic_cache", { scope, expectedVersion: 1 });
  expect(mocks.invoke.mock.calls.some(([name]) => name === "build_coauthor_semantic_batch")).toBe(false);
});

it("keeps selections on conflict and blocks building from unverified cached status", async () => {
  saved = structuredClone(enabled); const { client } = mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "建立下一批" })).toBeEnabled());
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === "save_coauthor_semantic_settings"
    ? Promise.reject(new Error("授权版本已变化")) : original(command, ...args));
  fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("授权版本已变化");
  expect(screen.getByRole("checkbox", { name: "设定卡" })).toBeChecked();
  mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === "get_coauthor_semantic_status"
    ? Promise.reject(new Error("状态不可用")) : original(command, ...args));
  await act(async () => { await client.invalidateQueries({ queryKey: ["coauthor-semantic"] }); });
  expect(await screen.findByText("以下是缓存状态，当前授权及进度尚未核实。")).toBeVisible();
  expect(screen.getByRole("button", { name: "建立下一批" })).toBeDisabled();
});

it("revokes authorization while a build is waiting and discards its late result", async () => {
  saved = structuredClone(enabled);
  let complete!: (value: unknown) => void;
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "build_coauthor_semantic_batch") return new Promise((resolve) => { complete = resolve; });
    if (command === "save_coauthor_semantic_settings") return { ...disabled, settings: { ...disabled.settings, version: 2 } };
    return original(command, args);
  });
  mount(); await waitFor(() => expect(screen.getByRole("button", { name: "建立下一批" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "建立下一批" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "建立本批" }));
  await waitFor(() => expect(complete).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
  expect(await screen.findByText("项目语义检索未启用")).toBeVisible();
  await act(async () => complete({ status: { ...enabled, indexedChunks: 16 }, sentChars: 9600, sentChunks: 8 }));
  expect(screen.getByText("项目语义检索未启用")).toBeVisible();
  expect(screen.queryByText("本批发送 8 块、9600 字。")).not.toBeInTheDocument();
});

it("isolates late project or branch responses without auto-granting the next project", async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementation(async (command: string, args: { scope?: CoauthorScope }) =>
    command === "list_model_profiles" ? [model] : args.scope?.sessionId === "s"
      ? new Promise((resolve) => { finish = resolve; }) : structuredClone(disabled));
  const { view, tree } = mount();
  await waitFor(() => expect(finish).toBeDefined());
  view.rerender(tree({ projectId: "p2", sessionId: "s2" }));
  expect(await screen.findByText("项目语义检索未启用")).toBeVisible();
  await act(async () => finish(enabled));
  expect(screen.queryByText("项目语义检索已授权")).not.toBeInTheDocument();
});
