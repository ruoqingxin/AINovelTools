import { ArrowRight, BookOpenText, FilePlus2, FolderOpen, PenLine } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  createPlanNode,
  errorMessage,
  getCurrentProject,
  invalidateProjectQueries,
  listRecentProjects,
  listPlanNodes,
  listPlanningSections,
  savePlanningSection,
  type PlanningSection,
} from "../lib/tauri-client";
import { useProjectActions } from "../shell/project-actions-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { lastWritingChapterKey, resolveDefaultWritingChapter } from "./project-workspace-utils";

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
  const navigate = useNavigate();
  const actions = useProjectActions();
  const [starting, setStarting] = useState(false);
  const busy = actions.busy ?? (starting ? "create" : null);
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [quickStartBaseline, setQuickStartBaseline] = useState<PlanningSection[] | null>(null);
  const [premise, setPremise] = useState("");
  const [scale, setScale] = useState("");
  const [volumeDirection, setVolumeDirection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdChapter, setCreatedChapter] = useState<string | null>(null);
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
  let rememberedId = "";
  try {
    if (currentProject.data) rememberedId = window.localStorage.getItem(lastWritingChapterKey(currentProject.data.projectId)) ?? "";
  } catch { /* Position memory is optional when browser storage is unavailable. */ }
  const firstChapter = resolveDefaultWritingChapter(
    (planNodes.data ?? []).filter((node) => node.kind === "CHAPTER" && !node.archived), "", rememberedId,
  );
  const planning = useQuery({
    queryKey: ["planning-sections"], queryFn: listPlanningSections,
    enabled: quickStartOpen && Boolean(currentProject.data),
  });
  useEffect(() => {
    if (!quickStartOpen) { setQuickStartBaseline(null); return; }
    if (quickStartBaseline === null && planning.data) {
      setQuickStartBaseline(planning.data);
      setPremise((current) => current || planning.data.find((item) => item.id === "seed-premise")?.content || "");
    }
  }, [quickStartOpen, quickStartBaseline, planning.data]);
  useUnsavedChangesGuard(starting || quickStartOpen && Boolean(premise.trim() || scale || volumeDirection.trim()),
    starting ? "第一章正在创建。" : "第一章的创作方向尚未提交。");
  useEffect(() => {
    if (createdChapter) void navigate({ to: "/writing", hash: createdChapter });
  }, [createdChapter, navigate]);

  async function handleQuickStart() {
    if (!currentProject.data || !premise.trim() || quickStartBaseline === null) return;
    const baseline = new Map(quickStartBaseline.map((item) => [item.id, item]));
    async function saveQuickStartSection(section: PlanningSection) {
      const saved = await savePlanningSection({ ...section, version: baseline.get(section.id)?.version ?? 0 });
      baseline.set(saved.id, saved);
      setQuickStartBaseline([...baseline.values()]);
    }
    setStarting(true);
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
      await saveQuickStartSection({
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
        await saveQuickStartSection({
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
        await saveQuickStartSection({
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
      setQuickStartOpen(false);
      setCreatedChapter(chapter.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="empty-project-view project-manager">
      <div className="workspace-heading project-manager-heading">
        <h1>作品管理</h1>
      <div className="project-actions" aria-label="作品操作">
        {firstChapter ? <Link to="/writing" hash={firstChapter.id} className="primary-action"><BookOpenText size={15} />继续写作</Link>
          : currentProject.data ? <button type="button" className="primary-action" disabled={busy !== null}
            aria-expanded={quickStartOpen} onClick={() => setQuickStartOpen((value) => !value)}><PenLine size={15} />创建第一章</button> : null}
        <button className={currentProject.data ? "secondary-action" : "primary-action"} type="button" disabled={busy !== null} onClick={() => void actions.create()}>
          <FilePlus2 size={17} />
          {actions.busy === "create" ? "创建中…" : "新建作品"}
        </button>
        <button className="secondary-action" type="button" disabled={busy !== null} onClick={() => void actions.open()}>
          <FolderOpen size={17} />
          {actions.busy === "open" ? "打开中…" : "打开作品"}
        </button>
      </div>
      </div>

      {error ? <p className="project-error" role="alert">{error}</p> : null}

      {currentProject.data && !firstChapter && quickStartOpen ? <form className="quick-writing-start" onSubmit={(event) => { event.preventDefault(); void handleQuickStart(); }}>
            {planning.isPending ? <p role="status">正在读取已有规划…</p> : null}
            {planning.isError ? <p className="project-error" role="alert">{errorMessage(planning.error)}</p> : null}
            <div className="section-heading"><h2>创建第一章</h2></div>
            <label className="quick-writing-wide"><span>一句话核心</span><textarea rows={3} value={premise} onChange={(event) => setPremise(event.target.value)} placeholder="例如：一个能看见因果线的少年，在灵气枯竭的世界里被卷入一场跨越百年的旧案。" autoFocus /></label>
            <div className="entity-form-grid">
              <label>大致规模（可选）<select value={scale} onChange={(event) => setScale(event.target.value)}><option value="">先不定</option><option value="短篇，1 至 5 万字">短篇</option><option value="中篇，10 至 30 万字">中篇</option><option value="长篇，50 至 150 万字">长篇</option><option value="超长篇，150 万字以上">超长篇</option></select></label>
              <label>第一卷方向（可选）<input value={volumeDirection} onChange={(event) => setVolumeDirection(event.target.value)} placeholder="留白即表示以后再决定" /></label>
            </div>
            <div className="inspector-actions"><button type="submit" className="primary-action" disabled={!premise.trim() || busy !== null || quickStartBaseline === null}><ArrowRight size={15} />{busy === "create" ? "创建中…" : "创建第一章并开始写"}</button><button type="button" className="secondary-action" onClick={() => setQuickStartOpen(false)} disabled={busy !== null}>取消</button></div>
          </form> : null}

      <div className="recent-projects">
        <div className="section-heading">
          <h2>最近作品</h2>
          <span>{recentProjects.data?.length ?? 0} 部</span>
        </div>
        {recentProjects.isError ? <div className="project-error" role="alert">无法读取最近作品：{errorMessage(recentProjects.error)}
          <button type="button" className="secondary-action" onClick={() => void recentProjects.refetch()}>重试</button></div> : null}
        {recentProjects.data?.length ? (
          <div className="recent-project-list">
            {recentProjects.data.map((project) => (
              <button
                key={project.root}
                type="button"
                className="recent-project-row"
                disabled={busy !== null}
                onClick={() => void actions.openRecent(project)}
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
            <p>{recentProjects.isPending ? "正在读取最近作品…" : recentProjects.isError ? "最近作品暂不可用" : "暂无最近作品"}</p>
          </div>
        )}
      </div>
    </section>
  );
}
