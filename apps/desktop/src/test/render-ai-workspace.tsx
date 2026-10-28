import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AiWorkspaceContext } from "../views/content-identity";

// Retain editor safety coverage after moving the editors into the AI workspace.
export function renderInAiWorkspace(ui: ReactNode) {
  return render(ui, { wrapper: ({ children }) => <AiWorkspaceContext.Provider value>{children}</AiWorkspaceContext.Provider> });
}
