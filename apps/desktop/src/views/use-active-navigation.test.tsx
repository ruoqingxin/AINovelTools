import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useActiveNavigation } from "./use-active-navigation";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Navigation({ selected }: { selected: string }) {
  const ref = useActiveNavigation(selected);
  return <nav ref={ref} aria-label="分类"><a aria-current={selected === "last" ? "page" : undefined}>最后一类</a></nav>;
}

it("reveals the active category horizontally without scrolling the content pane", () => {
  const rect = (left: number, right: number) => ({ left, right } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "NAV" ? rect(20, 300) : rect(400, 480);
  });
  const { rerender } = render(<Navigation selected="none" />);
  const nav = screen.getByRole("navigation");
  nav.scrollTop = 120;
  rerender(<Navigation selected="last" />);
  expect(nav.scrollLeft).toBe(180);
  expect(nav.scrollTop).toBe(120);
});

it("rechecks the selected category on resize and leaves already visible items alone", () => {
  let offscreen = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { left: this.tagName === "NAV" ? 20 : offscreen ? -40 : 40,
      right: this.tagName === "NAV" ? 300 : 120 } as DOMRect;
  });
  render(<Navigation selected="last" />);
  const nav = screen.getByRole("navigation");
  nav.scrollLeft = 100;
  fireEvent.resize(window);
  expect(nav.scrollLeft).toBe(100);
  offscreen = true;
  fireEvent.resize(window);
  expect(nav.scrollLeft).toBe(40);
});
