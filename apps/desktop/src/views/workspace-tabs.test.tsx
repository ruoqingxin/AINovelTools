import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClipboardList, Sparkles } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceTabs } from "./workspace-tabs";

const tabs = [
  { value: "first", label: "First", icon: ClipboardList },
  { value: "second", label: "Second", icon: Sparkles },
] as const;

function Harness() {
  const [value, setValue] = useState<"first" | "second">("first");
  return <WorkspaceTabs prefix="test" label="Work areas" tabs={tabs} value={value} onChange={setValue} />;
}

afterEach(cleanup);

describe("WorkspaceTabs", () => {
  it("moves selection and focus with arrow, Home and End keys", async () => {
    render(<Harness />);
    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(second, { key: "ArrowRight" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    await waitFor(() => expect(second).toHaveFocus());
    fireEvent.keyDown(second, { key: "Home" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "End" });
    await waitFor(() => expect(second).toHaveFocus());
  });
});
