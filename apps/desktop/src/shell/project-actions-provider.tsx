import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { open, save } from "@tauri-apps/plugin-dialog";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createProject, errorMessage, openProject, type ProjectManifest, type RecentProject } from "../lib/tauri-client";
import { waitForPendingCommands } from "../lib/ipc-transport";
import { useConfirmLeave } from "./unsaved-changes-provider";

const globalQueryKeys = new Set([
  "bootstrap-status", "feature-catalog", "health", "current-project", "recent-projects",
  "model-profiles", "ai-task-preferences", "ai-budget-settings",
]);

type ProjectActions = {
  busy: "create" | "open" | null;
  transitioning: boolean;
  error: string | null;
  clearError: () => void;
  create: () => Promise<void>;
  open: () => Promise<void>;
  openRecent: (project: RecentProject) => Promise<void>;
};

const ProjectActionsContext = createContext<ProjectActions | null>(null);

export function useProjectActions() {
  const actions = useContext(ProjectActionsContext);
  if (!actions) throw new Error("Project actions require a project provider");
  return actions;
}

export function useProjectTransition() {
  return useContext(ProjectActionsContext)?.transitioning ?? false;
}

export function ProjectActionsProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const confirmLeave = useConfirmLeave();
  const running = useRef(false);
  const [busy, setBusy] = useState<ProjectActions["busy"]>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeProject(mode: "create" | "open", choosePath: () => Promise<string | null>) {
    if (running.current) return;
    running.current = true;
    setBusy(mode);
    setError(null);
    try {
      const path = await choosePath();
      if (!path || !await confirmLeave()) return;
      flushSync(() => setTransitioning(true));
      await client.cancelQueries();
      await waitForPendingCommands();
      let project: ProjectManifest;
      if (mode === "create") {
        const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "未命名作品";
        project = await createProject(path, name);
      } else {
        project = await openProject(path);
      }
      await client.cancelQueries();
      // Most existing feature caches are not project-keyed; never carry them across a switch.
      client.removeQueries({ predicate: (query) => !globalQueryKeys.has(String(query.queryKey[0])) });
      client.setQueryData(["current-project"], project);
      await navigate({ to: mode === "create" ? "/planning" : "/", search: {}, hash: "", replace: true, ignoreBlocker: true });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["recent-projects"] }),
        client.invalidateQueries({ queryKey: ["health"] }),
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      running.current = false;
      setBusy(null);
      setTransitioning(false);
    }
  }

  return <ProjectActionsContext.Provider value={{
    busy, transitioning, error, clearError: () => setError(null),
    create: () => changeProject("create", async () => {
      const path = await save({ title: "选择作品保存位置", defaultPath: "NovelProject" });
      return typeof path === "string" && path ? path : null;
    }),
    open: () => changeProject("open", async () => {
      const path = await open({ title: "打开作品", directory: true, multiple: false });
      return typeof path === "string" && path ? path : null;
    }),
    openRecent: (project) => changeProject("open", () => Promise.resolve(project.root)),
  }}>{children}</ProjectActionsContext.Provider>;
}
