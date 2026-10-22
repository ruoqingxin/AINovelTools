import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoauthorDraft } from "./use-coauthor-draft";
import type { CoauthorDocument } from "../lib/tauri-client";

const mocks = vi.hoisted(() => ({ saveCoauthorDocument: vi.fn() }));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));
const scope = { projectId: "p1", sessionId: "s1" };
const document: CoauthorDocument = { sessionId: "s1", version: 1, title: "境界", kind: "SETTING",
  content: "原文", targetKey: null, targetRevision: null, narrativePosition: "" };
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });
afterEach(cleanup);

describe("coauthor draft persistence", () => {
  it("a delayed save only advances the version without replacing newer typing", async () => {
    let resolve!: (value: CoauthorDocument) => void;
    mocks.saveCoauthorDocument.mockReturnValue(new Promise<CoauthorDocument>((done) => { resolve = done; }));
    const { result } = renderHook(() => useCoauthorDraft(scope, document));
    act(() => result.current.change({ content: "开始保存" }));
    let saving!: Promise<CoauthorDocument>;
    act(() => { saving = result.current.save(); });
    act(() => result.current.change({ content: "保存期间又写了" }));
    await act(async () => { resolve({ ...document, version: 2, content: "开始保存" }); await saving; });
    expect(result.current.document.content).toBe("保存期间又写了");
    expect(result.current.document.version).toBe(2);
    expect(result.current.dirty).toBe(true);
    expect(JSON.parse(localStorage.getItem("coauthor-draft:p1:s1")!).content).toBe("保存期间又写了");
  });

  it("a conflict keeps the local document and blocks further silent saves", async () => {
    mocks.saveCoauthorDocument.mockRejectedValue({ code: "VERSION_CONFLICT", message: "版本已变化" });
    const { result } = renderHook(() => useCoauthorDraft(scope, document));
    act(() => result.current.change({ content: "保留作者编辑" }));
    await act(async () => { await result.current.save().catch(() => {}); });
    expect(result.current.conflict).toBe(true);
    expect(result.current.document.content).toBe("保留作者编辑");
    await expect(result.current.save()).rejects.toThrow("服务器版本已变化");
    expect(mocks.saveCoauthorDocument).toHaveBeenCalledTimes(1);
  });

  it("finds a scoped recovery copy without replacing the current document automatically", () => {
    localStorage.setItem("coauthor-draft:p1:s1", JSON.stringify({ ...document, version: 0, content: "未保存的备份" }));
    const { result } = renderHook(() => useCoauthorDraft(scope, document));
    expect(result.current.document.content).toBe("原文");
    expect(result.current.backup?.content).toBe("未保存的备份");
    expect(mocks.saveCoauthorDocument).not.toHaveBeenCalled();
  });
});
