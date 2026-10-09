import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCandidateEdits } from "./use-candidate-edits";

describe("candidate edit snapshots", () => {
  it("keeps the original baseline until a submitted snapshot is acknowledged", () => {
    const { result } = renderHook(useCandidateEdits);
    act(() => result.current.edit("one", "first edit", "original"));
    act(() => result.current.edit("one", "later edit", "remote update"));
    expect(result.current.entries.one?.baseline).toBe("original");
    act(() => result.current.acknowledge("one", "first edit"));
    expect(result.current.entries.one).toEqual({ value: "later edit", baseline: "first edit" });
    expect(result.current.dirty).toBe(true);
    act(() => result.current.acknowledge("one", "later edit"));
    expect(result.current.dirty).toBe(false);
  });

  it("clears an edit when it is restored or explicitly discarded, without affecting other items", () => {
    const { result } = renderHook(useCandidateEdits);
    act(() => {
      result.current.edit("one", "edit", "original");
      result.current.edit("two", "another edit", "original");
    });
    act(() => result.current.edit("one", "original", "remote update"));
    expect(result.current.entries.one?.value).toBe("original");
    expect(result.current.dirty).toBe(true);
    act(() => result.current.discard("two"));
    expect(result.current.dirty).toBe(false);
  });

  it("preserves a reversion to the old baseline while an earlier edit is being saved", () => {
    const { result } = renderHook(useCandidateEdits);
    act(() => result.current.edit("one", "submitted", "original"));
    act(() => result.current.edit("one", "original", "original"));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.acknowledge("one", "submitted"));
    expect(result.current.entries.one).toEqual({ value: "original", baseline: "submitted" });
    expect(result.current.dirty).toBe(true);
  });
});
