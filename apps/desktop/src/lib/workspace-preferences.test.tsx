import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWorkspacePreferences, updateWorkspacePreferences, useLayoutPreference, useWorkspacePreferences } from "./workspace-preferences";

const storageKey = "ainoveltools:workspace-preferences:v1";
function Preferences() {
  const value = useWorkspacePreferences();
  const [open, setOpen] = useLayoutPreference("test:panel", false);
  return <><output aria-label="字号">{value.fontSize}</output>
    <button aria-pressed={open} onClick={() => setOpen((current) => !current)}>面板</button></>;
}

describe("workspace preferences", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("bounds numeric values and rejects malformed preferences", () => {
    expect(normalizeWorkspacePreferences({ fontSize: 100, lineHeight: NaN, readingWidth: -20,
      theme: "invalid", layouts: { valid: true, invalid: "yes" } })).toEqual({
      fontSize: 24, lineHeight: 1.9, readingWidth: 560, theme: "light", layouts: { valid: true },
    });
    expect(normalizeWorkspacePreferences(null).fontSize).toBe(16);
  });
  it("recovers from damaged JSON and remembers display and layout changes", () => {
    localStorage.setItem(storageKey, "{broken");
    const view = render(<Preferences />);
    expect(screen.getByLabelText("字号")).toHaveTextContent("16");
    act(() => updateWorkspacePreferences({ fontSize: 20 }));
    fireEvent.click(screen.getByRole("button", { name: "面板" }));
    view.unmount();
    render(<Preferences />);
    expect(screen.getByLabelText("字号")).toHaveTextContent("20");
    expect(screen.getByRole("button", { name: "面板" })).toHaveAttribute("aria-pressed", "true");
  });
  it("receives changes from another window", () => {
    render(<Preferences />);
    act(() => {
      localStorage.setItem(storageKey, JSON.stringify({ fontSize: 22 }));
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
    });
    expect(screen.getByLabelText("字号")).toHaveTextContent("22");
  });
  it("keeps changes in memory when browser storage is unavailable", () => {
    render(<Preferences />);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    act(() => updateWorkspacePreferences({ fontSize: 18 }));
    expect(screen.getByLabelText("字号")).toHaveTextContent("18");
    fireEvent.click(screen.getByRole("button", { name: "面板" }));
    expect(screen.getByRole("button", { name: "面板" })).toHaveAttribute("aria-pressed", "true");
  });
});
