import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { emptyPlanningSection, usePlanningDraft } from "./use-planning-draft";

const section = (id = "plan-1", version = 1) => ({
  ...emptyPlanningSection(id), content: "formal", pendingContent: "candidate", version,
});
afterEach(cleanup);

describe("usePlanningDraft", () => {
  it("keeps the baseline and local edits during background updates", () => {
    const { result, rerender } = renderHook(({ stored }) => usePlanningDraft("plan-1", stored, true), { initialProps: { stored: section() } });
    act(() => result.current.setForm((current) => ({ ...current, pendingContent: "local" })));
    rerender({ stored: { ...section("plan-1", 2), pendingContent: "external" } });
    expect(result.current.form.pendingContent).toBe("local");
    expect(result.current.baseline.version).toBe(1);
    expect(result.current.remoteChanged).toBe(true);
    expect(result.current.dirty).toBe(true);
  });

  it("refreshes a clean form but does not downgrade an acknowledged version", () => {
    const { result, rerender } = renderHook(({ stored }) => usePlanningDraft("plan-1", stored, true), { initialProps: { stored: section() } });
    rerender({ stored: { ...section("plan-1", 2), content: "external" } });
    expect(result.current.form.content).toBe("external");
    rerender({ stored: section() });
    expect(result.current.baseline.version).toBe(2);
  });

  it("preserves newer fields after an adoption acknowledgement and prevents duplicate saves", () => {
    const { result } = renderHook(() => usePlanningDraft("plan-1", section(), true));
    let snapshot!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { snapshot = result.current.beginSave()!; });
    expect(result.current.beginSave()).toBeNull();
    act(() => result.current.setForm((current) => ({ ...current, pendingContent: "newer typing" })));
    act(() => {
      result.current.acknowledge(snapshot, { ...section("plan-1", 2), content: "candidate", pendingContent: "", storyState: "CONFIRMED" });
      result.current.finishSave(snapshot);
    });
    expect(result.current.form.content).toBe("candidate");
    expect(result.current.form.pendingContent).toBe("newer typing");
    expect(result.current.baseline.pendingContent).toBe("");
    expect(result.current.baseline.version).toBe(2);
    expect(result.current.dirty).toBe(true);
  });

  it("keeps unsubmitted fields during a state-only save", () => {
    const { result } = renderHook(() => usePlanningDraft("plan-1", section(), true));
    act(() => result.current.setForm((current) => ({ ...current, pendingContent: "not submitted", storyState: "DEFERRED" })));
    let snapshot!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { snapshot = result.current.beginSave()!; });
    act(() => {
      result.current.acknowledge({ ...snapshot, form: { ...snapshot.baseline, storyState: "DEFERRED" } }, { ...section("plan-1", 2), storyState: "DEFERRED" });
      result.current.finishSave(snapshot);
    });
    expect(result.current.form.pendingContent).toBe("not submitted");
    expect(result.current.form.storyState).toBe("DEFERRED");
    expect(result.current.dirty).toBe(true);
  });

  it("keeps a rejected snapshot retryable and supports explicit remote reload", () => {
    const { result, rerender } = renderHook(({ stored }) => usePlanningDraft("plan-1", stored, true), { initialProps: { stored: section() } });
    act(() => result.current.setForm((current) => ({ ...current, content: "local" })));
    let snapshot!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { snapshot = result.current.beginSave()!; });
    rerender({ stored: { ...section("plan-1", 2), content: "external" } });
    act(() => result.current.finishSave(snapshot));
    expect(result.current.baseline.version).toBe(1);
    expect(result.current.form.content).toBe("local");
    act(() => result.current.reload());
    expect(result.current.form.content).toBe("external");
    expect(result.current.dirty).toBe(false);
  });

  it("does not apply a late acknowledgement to a different selection", () => {
    const { result, rerender } = renderHook(({ id }) => usePlanningDraft(id, section(id), true), { initialProps: { id: "plan-1" } });
    let snapshot!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { snapshot = result.current.beginSave()!; });
    rerender({ id: "plan-2" });
    act(() => {
      result.current.acknowledge(snapshot, { ...section("plan-1", 2), content: "late response" });
      result.current.finishSave(snapshot);
    });
    expect(result.current.form.id).toBe("plan-2");
    expect(result.current.form.content).toBe("formal");
  });

  it("retains an unchanged failed batch snapshot across remote refresh until explicit reload", () => {
    const { result, rerender } = renderHook(({ stored }) => usePlanningDraft("plan-1", stored, true), { initialProps: { stored: section() } });
    let snapshot!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { snapshot = result.current.beginSave()!; });
    act(() => {
      result.current.retainFailedSave(snapshot);
      result.current.finishSave(snapshot);
    });
    rerender({ stored: { ...section("plan-1", 2), pendingContent: "external batch" } });
    expect(result.current.form.pendingContent).toBe("candidate");
    expect(result.current.baseline.version).toBe(1);
    expect(result.current.dirty).toBe(true);
    let retry!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { retry = result.current.beginSave()!; });
    expect(retry.baseline.version).toBe(1);
    act(() => result.current.finishSave(retry));
    act(() => result.current.reload());
    expect(result.current.form.pendingContent).toBe("external batch");
    expect(result.current.baseline.version).toBe(2);
    expect(result.current.dirty).toBe(false);
  });

  it("clears failed-batch retention after a successful retry without losing subsequent edits", () => {
    const { result } = renderHook(() => usePlanningDraft("plan-1", section(), true));
    let snapshot!: NonNullable<ReturnType<typeof result.current.beginSave>>;
    act(() => { snapshot = result.current.beginSave()!; });
    act(() => {
      result.current.retainFailedSave(snapshot);
      result.current.finishSave(snapshot);
    });
    act(() => { snapshot = result.current.beginSave()!; });
    act(() => {
      result.current.acknowledge(snapshot, { ...section("plan-1", 2), pendingContent: "" });
      result.current.finishSave(snapshot);
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.baseline.version).toBe(2);
  });
});
