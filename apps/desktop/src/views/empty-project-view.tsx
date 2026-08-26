import { FilePlus2, FolderOpen } from "lucide-react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createProject,
  invalidateProjectQueries,
  openProject,
} from "../lib/tauri-client";

function projectNameFromPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "未命名工程";
}

export function EmptyProjectView() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"create" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setBusy("create");
    setError(null);
    try {
      const path = await save({
        title: "选择小说工程位置",
        defaultPath: "NovelProject",
      });
      if (typeof path !== "string" || !path) return;
      await createProject(path, projectNameFromPath(path));
      await invalidateProjectQueries(queryClient);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleOpen() {
    setBusy("open");
    setError(null);
    try {
      const path = await open({
        title: "打开小说工程",
        directory: true,
        multiple: false,
      });
      if (typeof path !== "string" || !path) return;
      await openProject(path);
      await invalidateProjectQueries(queryClient);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="empty-project-view">
      <div className="workspace-heading">
        <p className="eyebrow">项目工作区</p>
        <h1>小说工程</h1>
      </div>

      <div className="project-actions" aria-label="项目操作">
        <button className="primary-action" type="button" disabled={busy !== null} onClick={handleCreate}>
          <FilePlus2 size={17} />
          {busy === "create" ? "创建中…" : "新建工程"}
        </button>
        <button className="secondary-action" type="button" disabled={busy !== null} onClick={handleOpen}>
          <FolderOpen size={17} />
          {busy === "open" ? "打开中…" : "打开工程"}
        </button>
      </div>

      {error ? <p className="project-error" role="alert">{error}</p> : null}

      <div className="recent-projects">
        <div className="section-heading">
          <h2>最近使用</h2>
          <span>0 个工程</span>
        </div>
        <div className="empty-list">
          <div className="empty-list-icon" aria-hidden="true">
            <FolderOpen size={21} strokeWidth={1.5} />
          </div>
          <p>最近打开的工程会显示在这里</p>
        </div>
      </div>
    </section>
  );
}
