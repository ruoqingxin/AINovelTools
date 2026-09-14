import { ArrowRight, BookOpenText, FilePlus2, FolderOpen, ListTree, PenLine, Sparkles } from "lucide-react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  createProject,
  createPlanNode,
  errorMessage,
  getCurrentProject,
  invalidateProjectQueries,
  listRecentProjects,
  listPlanNodes,
  openProject,
  savePlanningSection,
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
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [premise, setPremise] = useState("");
  const [scale, setScale] = useState("");
  const [volumeDirection, setVolumeDirection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recentProjects = useQuery({
    queryKey: ["recent-projects"],
    queryFn: listRecentProjects,
  });
  const currentProject = useQuery({
    queryKey: ["current-project"],
    queryFn: getCurrentProject,
  });
  const planNodes = useQuery({
    queryKey: ["plan-nodes"],
    queryFn: listPlanNodes,
    enabled: Boolean(currentProject.data),
  });
  const firstChapter = planNodes.data?.find(
    (node) => node.kind === "CHAPTER" && !node.archived,
  );

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

  async function handleQuickStart() {
    if (!currentProject.data || !premise.trim()) return;
    setBusy("create");
    setError(null);
    try {
      let nodes = planNodes.data ?? [];
      let workDesign = nodes.find(
        (node) => node.parentId === null && node.kind === "WORK_DESIGN" && !node.archived,
      );
      if (!workDesign) {
        workDesign = await createPlanNode({ kind: "WORK_DESIGN", title: "作品设定" });
        nodes = [...nodes, workDesign];
      }
      await savePlanningSection({
        id: "seed-premise",
        content: premise.trim(),
        pendingContent: "",
        storyState: "CONFIRMED",
        rationale: "快速起步",
        consequence: "",
        references: [],
        updatedAt: "",
      });
      if (scale.trim()) {
        await savePlanningSection({
          id: "seed-tone",
          content: `大致规模：${scale.trim()}`,
          pendingContent: "",
          storyState: "CONFIRMED",
          rationale: "快速起步",
          consequence: "",
          references: [],
          updatedAt: "",
        });
      }

      let volumeManager = nodes.find(
        (node) => node.parentId === null && node.kind === "VOLUME_MANAGER" && !node.archived,
      );
      if (!volumeManager) {
        volumeManager = await createPlanNode({ kind: "VOLUME_MANAGER", title: "分卷管理" });
        nodes = [...nodes, volumeManager];
      }
      let firstVolume = nodes.find(
        (node) => node.parentId === volumeManager.id && node.kind === "VOLUME" && !node.archived,
      );
      if (!firstVolume) {
        firstVolume = await createPlanNode({
          kind: "VOLUME",
          title: "第一卷",
          parentId: volumeManager.id,
        });
      }
      if (volumeDirection.trim()) {
        await savePlanningSection({
          id: `plan-node:${firstVolume.id}`,
          content: volumeDirection.trim(),
          pendingContent: "",
          storyState: "CONFIRMED",
          rationale: "快速起步",
          consequence: "",
          references: [],
          updatedAt: "",
        });
      }
      const chapter = nodes.find(
        (node) => node.parentId === firstVolume?.id && node.kind === "CHAPTER" && !node.archived,
      ) ?? await createPlanNode({
        kind: "CHAPTER",
        title: "第1章",
        parentId: firstVolume.id,
      });
      await invalidateProjectQueries(queryClient);
      window.location.assign(`/writing#${chapter.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
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
          <div className="current-project-actions">
            {firstChapter ? <a href={`/writing#${firstChapter.id}`} className="primary-action"><BookOpenText size={15} />继续写作</a> : null}
            <Link to="/planning" className="secondary-action current-project-open">
              <ListTree size={15} />一起规划
            </Link>
            {!firstChapter ? <button type="button" className="primary-action" onClick={() => setQuickStartOpen((value) => !value)}><PenLine size={15} />先写一段看看</button> : null}
          </div>
          {!firstChapter && quickStartOpen ? <form className="quick-writing-start" onSubmit={(event) => { event.preventDefault(); void handleQuickStart(); }}>
            <div className="section-heading"><div><h2>先写一段看看</h2><p>一句话核心是唯一必填项，规模和第一卷方向都可以保留未知。</p></div></div>
            <label className="quick-writing-wide"><span>一句话核心</span><textarea rows={3} value={premise} onChange={(event) => setPremise(event.target.value)} placeholder="例如：一个能看见因果线的少年，在灵气枯竭的世界里被卷入一场跨越百年的旧案。" autoFocus /></label>
            <div className="entity-form-grid">
              <label>大致规模（可选）<select value={scale} onChange={(event) => setScale(event.target.value)}><option value="">先不定</option><option value="短篇，1 至 5 万字">短篇</option><option value="中篇，10 至 30 万字">中篇</option><option value="长篇，50 至 150 万字">长篇</option><option value="超长篇，150 万字以上">超长篇</option></select></label>
              <label>第一卷方向（可选）<input value={volumeDirection} onChange={(event) => setVolumeDirection(event.target.value)} placeholder="留白即表示以后再决定" /></label>
            </div>
            <div className="inspector-actions"><button type="submit" className="primary-action" disabled={!premise.trim() || busy !== null}><ArrowRight size={15} />{busy === "create" ? "创建中…" : "创建第一章并开始写"}</button><button type="button" className="secondary-action" onClick={() => setQuickStartOpen(false)} disabled={busy !== null}>取消</button></div>
          </form> : null}
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
