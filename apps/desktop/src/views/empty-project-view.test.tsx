import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyProjectView } from "./empty-project-view";

describe("EmptyProjectView", () => {
  it("shows disabled project actions before project services exist", () => {
    render(<EmptyProjectView />);

    expect(screen.getByRole("heading", { name: "小说工程" })).toBeVisible();
    expect(screen.getByRole("button", { name: "新建工程" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开工程" })).toBeDisabled();
  });
});
