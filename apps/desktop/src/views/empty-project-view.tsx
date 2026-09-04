import { ArrowRight, FilePlus2, FolderOpen, ListTree, Sparkles } from "lucide-react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  createProject,
  errorMessage,
  getCurrentProject,
  invalidateProjectQueries,
  listRecentProjects,
  openProject,
  type RecentProject,
} from "../lib/tauri-client";

function projectNameFromPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "未命名工程";
}

function lastOpenedLabel(timestamp: string) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return "最近打开";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

export function EmptyProjectView() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"create" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recentProjects = useQuery({
    queryKey: ["recent-projects"],
    queryFn: listRecentProjects,
  });
  const currentProject = useQuery({
    queryKey: ["current-project"],
    queryFn: getCurrentProject,
  });

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
      setError(errorMessage(cause));
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
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleOpenRecent(project: RecentProject) {
    setBusy("open");
    setError(null);
    try {
      await openProject(project.root);
      await invalidateProjectQueries(queryClient);
    } catch (cause) {
      setError(`无法打开“${project.name}”：${errorMessage(cause)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="empty-project-view">
      <div className="workspace-heading">
        <p className="eyebrow">项目工作区</p>
        <h1>小说工程</h1>
        <p className="workspace-lede">从一个念头开始，逐步整理设定、搭建大纲，再进入正文。你不需要一次想清楚整本小说。</p>
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

      {!currentProject.data ? <div className="first-start-guide" aria-label="开始创作步骤">
        <div className="first-start-guide-heading">
          <div className="first-start-guide-icon" aria-hidden="true"><Sparkles size={18} /></div>
          <div><strong>第一次使用？按这个顺序开始</strong><span>每一步都可以随时修改，不会锁死你的故事。</span></div>
        </div>
        <ol>
          <li><b>01</b><span><strong>新建工程</strong>选择一个文件夹保存小说资料。</span></li>
          <li><b>02</b><span><strong>写下故事核心</strong>先回答“谁想要什么，为什么现在必须行动”。</span></li>
          <li><b>03</b><span><strong>创建第一章</strong>设定和大纲不完整也没关系，边写边补。</span></li>
        </ol>
        <p className="first-start-guide-tip"><ArrowRight size={14} />建议从“作品设定”开始，系统会给你可选择的候选，不用面对空白页。</p>
      </div> : null}

      {currentProject.data ? (
        <div className="current-project-panel">
          <div className="current-project-icon" aria-hidden="true"><FolderOpen size={20} strokeWidth={1.6} /></div>
          <div>
            <span>当前工程</span>
            <strong>{currentProject.data.name}</strong>
          </div>
          <Link to="/planning" className="secondary-action current-project-open">
            <ListTree size={15} />进入规划
          </Link>
        </div>
      ) : null}

      <div className="recent-projects">
        <div className="section-heading">
          <h2>最近使用</h2>
          <span>{recentProjects.data?.length ?? 0} 个工程</span>
        </div>
        {recentProjects.data?.length ? (
          <div className="recent-project-list">
            {recentProjects.data.map((project) => (
              <button
                key={project.root}
                type="button"
                className="recent-project-row"
                disabled={busy !== null}
                onClick={() => void handleOpenRecent(project)}
              >
                <FolderOpen size={18} strokeWidth={1.6} />
                <span className="recent-project-copy">
                  <strong>{project.name}</strong>
                  <span title={project.root}>{project.root}</span>
                </span>
                <time dateTime={project.lastOpenedAt}>
                  {lastOpenedLabel(project.lastOpenedAt)}
                </time>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-list">
            <div className="empty-list-icon" aria-hidden="true">
              <FolderOpen size={21} strokeWidth={1.5} />
            </div>
            <p>{recentProjects.isPending ? "正在加载最近工程…" : "最近打开的工程会显示在这里"}</p>
          </div>
        )}
      </div>
    </section>
  );
}
