import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceControls } from "./appearance-controls";
import { useWorkspaceTheme } from "../lib/use-workspace-theme";
const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  setTheme: vi.fn<(theme: "light" | "dark" | null) => Promise<void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: native.setTheme }) }));
function App() { useWorkspaceTheme(); return <AppearanceControls />; }
describe("appearance controls", () => {
  beforeEach(() => {
    localStorage.clear();
    native.isTauri.mockReturnValue(false);
    native.setTheme.mockReset().mockResolvedValue();
  });
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
  it("keeps browser previews independent of native window APIs", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(native.setTheme).not.toHaveBeenCalled();
  });
  it("synchronizes the native title bar and restores the saved dark choice", () => {
    native.isTauri.mockReturnValue(true);
    const view = render(<App />);
    expect(native.setTheme).toHaveBeenLastCalledWith("light");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(native.setTheme).toHaveBeenLastCalledWith("dark");
    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    expect(native.setTheme).toHaveBeenLastCalledWith("light");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    view.unmount();
    render(<App />);
    expect(native.setTheme).toHaveBeenLastCalledWith("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("releases the native override in system mode without pinning the resolved color", () => {
    native.isTauri.mockReturnValue(true);
    let changed!: () => void;
    const media = { matches: true, addEventListener: vi.fn((_event, listener) => { changed = listener; }), removeEventListener: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(native.setTheme).toHaveBeenLastCalledWith(null);
    const calls = native.setTheme.mock.calls.length;
    act(() => { media.matches = false; changed(); });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(native.setTheme).toHaveBeenCalledTimes(calls);
  });
  it("keeps the page usable if native theme synchronization fails", async () => {
    native.isTauri.mockReturnValue(true);
    native.setTheme.mockRejectedValue(new Error("Window theme unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");
  });
});
