import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceControls } from "./appearance-controls";
import { useWorkspaceTheme } from "../lib/use-workspace-theme";
function App() { useWorkspaceTheme(); return <AppearanceControls />; }
describe("appearance controls", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("starts light, switches theme and restores the choice after reopening", () => {
    const view = render(<App />);
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    view.unmount();
    render(<App />);
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("follows system changes only in system mode", () => {
    let changed!: () => void;
    const media = { matches: true, addEventListener: vi.fn((_event, listener) => { changed = listener; }), removeEventListener: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => { media.matches = false; changed(); });
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    act(() => { media.matches = false; changed(); });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("closes the menu with Escape or outside click and restores trigger focus", () => {
    render(<App />);
    const menu = document.querySelector("details")!;
    menu.open = true;
    fireEvent.keyDown(screen.getByRole("button", { name: "浅色" }), { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(screen.getByLabelText("外观")).toHaveFocus();
    menu.open = true;
    fireEvent.pointerDown(document.body);
    expect(menu.open).toBe(false);
  });
});
