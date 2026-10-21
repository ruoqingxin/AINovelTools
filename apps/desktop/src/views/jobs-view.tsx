import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, ClipboardList, History, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { classifyAiFailure } from "../lib/ai-failure";
import { formatCost } from "../lib/ai-cost-estimate";
import { taskPollingInterval, useJobs } from "../lib/jobs-query";
import {
  acknowledgeFailedJobs, cancelAiTask, cancelJob, errorMessage, getAiRunRequest, getCurrentProject,
  getPlanningAiJobRequest, listAiRuns, listJobEvents, listPlanNodes, retryJob,
  type AiRun, type Job, type JobType,
} from "../lib/tauri-client";
import { planningTargetHref } from "../lib/discussion-source";
import "./activity-workspace.css";
import { WorkspaceTabs } from "./workspace-tabs";

const typeLabels: Record<JobType, string> = {
  BACKUP: "创建备份", RESTORE_VERIFY: "备份校验与恢复", HEALTH_SCAN: "检查数据健康",
  REBUILD_SEARCH_INDEX: "重建搜索索引", REFRESH_CHAPTER_SUMMARY: "更新章节摘要",
  REFRESH_PROJECT_SETTING_SUMMARY: "更新设定记忆", AI_PLANNING_GENERATE: "生成大纲内容",
  AI_PLANNING_EXTRACT: "处理规划文件",
};
const statusLabels: Record<string, string> = {
  QUEUED: "等待中", RUNNING: "执行中", SUCCEEDED: "已完成", COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已取消",
};
const actionLabels: Record<string, string> = {
  DRAFT: "整章创作", CONTINUE: "续写", REWRITE: "重写", POLISH: "润色", SUMMARIZE: "摘要",
  CONSISTENCY_CHECK: "一致性检查", workDesign: "作品定位", discussion: "构思讨论",
  discussionDesign: "整理设定", outline: "故事主线", volumePlanning: "分卷规划",
  chapterSplit: "章节拆分", chapterPlan: "本章计划", consistencyReview: "一致性检查",
  writing: "正文书写", knowledgeExtraction: "知识提炼",
};
const sourceLabels: Record<string, string> = { WRITING: "正文创作", PLANNING: "大纲", KNOWLEDGE_EXTRACTION: "知识提炼" };
type ActivityState = "RECENT" | "ACTIVE" | "FAILED" | "ALL";

function inState(status: string, filter: ActivityState) {
  if (filter === "ACTIVE") return status === "QUEUED" || status === "RUNNING";
  if (filter === "FAILED") return status === "FAILED";
  if (filter === "RECENT") return status !== "CANCELLED";
  return true;
}

function activityRank(status: string) {
  return status === "RUNNING" || status === "QUEUED" ? 0 : status === "FAILED" ? 1 : 2;
}

function payload(job: Job): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(job.payload);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
function isAiJob(job: Job) { return job.jobType === "AI_PLANNING_GENERATE" || job.jobType === "AI_PLANNING_EXTRACT"; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }

function ActivityFilters({ value, onChange }: { value: ActivityState; onChange: (value: ActivityState) => void }) {
  return <select aria-label="活动状态" value={value} onChange={(event) => onChange(event.target.value as ActivityState)}>
    <option value="RECENT">进行中、失败与近期完成</option><option value="ACTIVE">进行中</option>
    <option value="FAILED">失败</option><option value="ALL">全部记录</option>
  </select>;
}

function RequestSnapshot({ snapshot, pending, error }: {
  snapshot: { endpoint: string | null; requestBody: string | null } | undefined; pending: boolean; error: unknown;
}) {
  return pending ? <p role="status">正在读取请求…</p> : error ? <p className="project-error" role="alert">{errorMessage(error)}</p>
    : snapshot?.requestBody ? <div className="job-request-content">
      <div className="job-request-meta"><span><b>POST</b>{snapshot.endpoint}</span></div><pre>{snapshot.requestBody}</pre>
    </div> : <p>暂无请求快照</p>;
}

function AiRunsHistory() {
  const client = useQueryClient();
  const [source, setSource] = useState("ALL");
  const [state, setState] = useState<ActivityState>("RECENT");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const action = useMutation({ mutationFn: (id: string) => cancelAiTask(id), onSettled: () => client.invalidateQueries({ queryKey: ["ai-runs"] }) });
  const runs = useQuery({
    queryKey: ["ai-runs", "ALL"], queryFn: () => listAiRuns(),
    refetchInterval: (query) => taskPollingInterval(query.state.data),
  });
  const displayed = (runs.data ?? []).filter((run) => (source === "ALL" || run.source === source) && inState(run.status, state))
    .sort((a, b) => activityRank(a.status) - activityRank(b.status)).slice(0, 100);
  const selected = displayed.find((run) => run.id === selectedId) ?? displayed[0];
  const request = useQuery({
    queryKey: ["ai-run-request", selected?.id], queryFn: () => getAiRunRequest(selected!.id),
    enabled: Boolean(selected && advanced && showRequest),
    refetchInterval: selected?.status === "RUNNING" ? 1_200 : false,
  });
  useEffect(() => { setAdvanced(false); setShowRequest(false); }, [selected?.id]);
  function duration(run: AiRun) {
    if (!run.finishedAt) return "";
    const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.createdAt)) / 1000);
    return Number.isFinite(seconds) && seconds >= 0 ? `${seconds} 秒` : "";
  }
  return <section className="ai-runs-history" aria-label="AI 运行记录">
    <div className="activity-toolbar">
      <ActivityFilters value={state} onChange={setState} />
      <select aria-label="AI 运行分类" value={source} onChange={(event) => setSource(event.target.value)}>
        <option value="ALL">全部类型</option>{Object.entries(sourceLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </select>
      <button className="icon-command" type="button" onClick={() => void runs.refetch()} disabled={runs.isFetching}
        aria-label="刷新 AI 运行记录" title="刷新 AI 运行记录"><RefreshCw size={15} /></button>
    </div>
    {action.isError ? <p className="project-error" role="alert">{errorMessage(action.error)}</p> : null}
    {runs.isPending ? <p className="plan-empty" role="status">正在加载 AI 运行记录…</p> : runs.isError ? <p className="project-error" role="alert">{errorMessage(runs.error)}
      <button type="button" className="secondary-action" disabled={runs.isFetching} onClick={() => void runs.refetch()}><RefreshCw size={14} />重试加载</button></p>
      : displayed.length ? <div className="jobs-workspace">
        <div className="jobs-list">{displayed.map((run) => <button className="job-row activity-record" type="button" key={run.id}
          data-selected={selected?.id === run.id || undefined} aria-pressed={selected?.id === run.id} onClick={() => setSelectedId(run.id)}>
          <span className="job-main"><strong>{actionLabels[run.action] ?? actionLabels[run.taskKey] ?? "AI 调用"} · {run.chapterTitle}</strong>
            <small>{run.profileName} · {sourceLabels[run.source] ?? run.source} · {new Date(run.createdAt).toLocaleString()}</small></span>
          <span className={`job-status job-${run.status === "COMPLETED" ? "succeeded" : run.status.toLowerCase()}`}>{statusLabels[run.status]}</span>
        </button>)}</div>
        <aside className="job-detail" aria-label="AI 运行详情">{selected ? <>
          <div className="job-detail-heading"><div><span>{actionLabels[selected.action] ?? actionLabels[selected.taskKey] ?? "AI 调用"}</span><h2>{selected.chapterTitle}</h2></div>
            <span className={`job-status job-${selected.status === "COMPLETED" ? "succeeded" : selected.status.toLowerCase()}`}>{statusLabels[selected.status]}</span></div>
          <dl><div><dt>模型</dt><dd>{selected.profileName}</dd></div><div><dt>时间</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div>
            {duration(selected) ? <div><dt>耗时</dt><dd>{duration(selected)}</dd></div> : null}
            <div><dt>输入 / 输出</dt><dd>约 {selected.estimatedInputTokens.toLocaleString()} / {selected.estimatedOutputTokens.toLocaleString()} tokens</dd></div>
            <div><dt>估算费用</dt><dd>{formatCost(selected.estimatedCostMicros, selected.priceCurrency)}</dd></div></dl>
          <p className="job-result">{selected.errorCode ? classifyAiFailure(selected.errorCode).label
            : selected.status === "COMPLETED" ? "模型调用已完成" : selected.status === "CANCELLED" ? "调用已取消" : "等待模型返回"}</p>
          {selected.chapterId && (selected.source === "WRITING" || selected.source === "KNOWLEDGE_EXTRACTION") ? <a className="secondary-action"
            href={`/writing?${selected.source === "WRITING" ? "assistant=ai" : "tab=extraction"}&referenceChapter=${encodeURIComponent(selected.chapterId)}#${encodeURIComponent(selected.chapterId)}`}>打开章节</a> : null}
          {selected.status === "RUNNING" ? <button className="secondary-action" type="button" disabled={action.isPending}
            onClick={() => action.mutate(selected.id)}><Square size={14} />取消调用</button> : null}
          <details className="activity-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
            <summary>高级详情</summary>
            <dl><div><dt>运行编号</dt><dd>{selected.id}</dd></div><div><dt>提示词版本</dt><dd>{selected.promptVersion}</dd></div>
              <div><dt>尝试次数</dt><dd>{selected.attemptCount}</dd></div>
              {selected.retryReason ? <div><dt>回退原因</dt><dd>{selected.retryReason}</dd></div> : null}
              {selected.errorCode ? <div><dt>错误代码</dt><dd>{selected.errorCode}</dd></div> : null}</dl>
            <button type="button" className="secondary-action" aria-expanded={showRequest} onClick={() => setShowRequest((value) => !value)}>
              {showRequest ? "收起请求快照" : "查看完整请求"}</button>
            {advanced && showRequest ? <RequestSnapshot snapshot={request.data} pending={request.isPending} error={request.error} /> : null}
          </details>
        </> : null}</aside>
      </div> : <div className="activity-empty"><History size={24} /><p>当前筛选没有 AI 运行记录</p>
        {state !== "ALL" || source !== "ALL" ? <button type="button" className="secondary-action" onClick={() => { setState("ALL"); setSource("ALL"); }}>查看全部记录</button> : null}</div>}
  </section>;
}

export function JobsView() {
  const client = useQueryClient();
  const jobs = useJobs();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const [view, setView] = useState(() => window.location.hash === "#ai-runs" ? "AI_RUNS" : "JOBS");
  const [state, setState] = useState<ActivityState>(() => new URLSearchParams(window.location.search).has("jobId") ? "ALL" : "RECENT");
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("jobId"));
  const [advanced, setAdvanced] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSettled: () => client.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const displayed = (jobs.data ?? []).filter((job) => inState(job.status, state))
    .sort((a, b) => activityRank(a.status) - activityRank(b.status));
  const missingTarget = Boolean(selectedId && jobs.isSuccess && !(jobs.data ?? []).some((job) => job.id === selectedId));
  const selected = missingTarget ? undefined : displayed.find((job) => job.id === selectedId) ?? displayed[0];
  const failedCount = (jobs.data ?? []).filter((job) => job.status === "FAILED" && !job.acknowledgedAt).length;
  const events = useQuery({
    queryKey: ["job-events", selected?.id], queryFn: () => listJobEvents(selected!.id), enabled: Boolean(selected && view === "JOBS"),
    refetchInterval: selected?.status === "RUNNING" || selected?.status === "QUEUED" ? 1_200 : false,
  });
  const request = useQuery({
    queryKey: ["planning-ai-request", selected?.id], queryFn: () => getPlanningAiJobRequest(selected!.id),
    enabled: Boolean(selected && view === "JOBS" && isAiJob(selected) && advanced && showRequest),
    refetchInterval: selected?.status === "RUNNING" ? 1_200 : false,
  });
  useEffect(() => { setAdvanced(false); setShowRequest(false); }, [selected?.id]);
  useEffect(() => {
    const sync = () => setView(window.location.hash === "#ai-runs" ? "AI_RUNS" : "JOBS");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (selected?.status === "SUCCEEDED" && selected.jobType === "REBUILD_SEARCH_INDEX") {
      void client.invalidateQueries({ queryKey: ["project-search"] });
    }
  }, [client, selected?.id, selected?.status, selected?.jobType]);
  function target(job: Job) {
    const input = payload(job);
    const chapterId = text(input.chapterId);
    return text(input.sectionTitle) || (chapterId ? nodes.data?.find((node) => node.id === chapterId)?.title : "")
      || text(input.target) || text(input.source) || project.data?.name || "当前作品";
  }
  function href(job: Job) {
    const input = payload(job);
    if (text(input.chapterId)) return `/writing?referenceChapter=${encodeURIComponent(text(input.chapterId))}#${encodeURIComponent(text(input.chapterId))}`;
    if (isAiJob(job) && text(input.sectionId)) {
      const kind = nodes.data?.find((node) => `plan-node:${node.id}` === input.sectionId)?.kind;
      return planningTargetHref(text(input.sectionId), project.data?.projectId, kind);
    }
    return "/settings#data-management";
  }
  const result = [...(events.data ?? [])].reverse().find((event) => event.stage === "RESULT")?.message;

  return <section className="jobs-view activity-workspace">
    <div className="workspace-heading"><h1>后台活动</h1><a className="secondary-action" href="/settings#ai-usage">用量与效果</a></div>
    <WorkspaceTabs prefix="activity" label="活动记录类型" value={view}
      tabs={[{ value: "JOBS", label: "后台任务", icon: ClipboardList }, { value: "AI_RUNS", label: "AI 运行记录", icon: History }]}
      onChange={(key) => {
        setView(key);
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${key === "AI_RUNS" ? "#ai-runs" : ""}`);
      }} />
    <div className="activity-panel" role="tabpanel" id={`activity-panel-${view}`} aria-labelledby={`activity-tab-${view}`}>
    {view === "AI_RUNS" ? <AiRunsHistory /> : <>
      <div className="activity-toolbar"><ActivityFilters value={state} onChange={setState} />
        {failedCount ? <button className="secondary-action" type="button" disabled={action.isPending}
          onClick={() => action.mutate(() => acknowledgeFailedJobs())}><BellOff size={14} />清除失败提醒 {failedCount}</button> : null}
        <button className="icon-command" type="button" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}
          aria-label="刷新任务" title="刷新任务"><RefreshCw size={15} /></button>
      </div>
      {action.isError ? <p className="project-error" role="alert">任务操作失败：{errorMessage(action.error)}</p> : null}
      {jobs.isPending ? <p className="plan-empty" role="status">正在加载任务…</p> : jobs.isError ? <p className="project-error" role="alert">{errorMessage(jobs.error)}
        <button type="button" className="secondary-action" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}><RefreshCw size={14} />重试加载</button></p>
        : missingTarget ? <p className="project-error" role="alert">目标任务已不可用或不属于当前作品。<button type="button" onClick={() => setSelectedId(null)}>查看当前活动</button></p>
        : displayed.length ? <div className="jobs-workspace"><div className="jobs-list">
          {displayed.map((job) => <button className="job-row activity-record" type="button" key={job.id}
            aria-pressed={selected?.id === job.id} data-selected={selected?.id === job.id || undefined} onClick={() => setSelectedId(job.id)}>
            <span className="job-main"><strong>{typeLabels[job.jobType]}</strong><small>{target(job)}</small></span>
            <span className={`job-status job-${job.status.toLowerCase()}`}>{statusLabels[job.status]}</span>
            <span className="job-progress"><span style={{ width: `${job.progress}%` }} /></span><small>{job.progress}%</small>
          </button>)}
        </div><aside className="job-detail" aria-label="任务详情">{selected ? <>
          <div className="job-detail-heading"><div><span>{typeLabels[selected.jobType]}</span><h2>{target(selected)}</h2></div>
            <span className={`job-status job-${selected.status.toLowerCase()}`}>{statusLabels[selected.status]}</span></div>
          <dl><div><dt>创建时间</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div>
            <div><dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div></dl>
          <div className="job-detail-progress"><div><strong>{selected.cancelRequested ? "正在取消" : "执行进度"}</strong><span>{selected.progress}%</span></div>
            <progress max={100} value={selected.progress} aria-label="任务进度" /></div>
          <p className={selected.errorSummary ? "project-error job-result" : "job-result"}>
            {selected.errorSummary ?? result ?? (selected.status === "SUCCEEDED" ? "任务已完成"
              : selected.status === "CANCELLED" ? "任务已取消" : selected.cancelRequested ? "已提交取消请求" : "任务处理中")}</p>
          <div className="maintenance-actions"><a className="secondary-action" href={href(selected)}>{isAiJob(selected) || text(payload(selected).chapterId) ? "打开目标" : "数据管理"}</a>
            {selected.status === "FAILED" ? <button className="secondary-action" type="button" disabled={action.isPending}
              onClick={() => action.mutate(() => retryJob(selected.id))}><RotateCcw size={14} />重试</button> : null}
            {selected.status === "RUNNING" || selected.status === "QUEUED" ? <button className="secondary-action" type="button"
              disabled={action.isPending || selected.cancelRequested} onClick={() => action.mutate(() => cancelJob(selected.id))}><Square size={14} />取消任务</button> : null}</div>
          <details className="activity-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
            <summary>高级详情</summary>
            <dl><div><dt>任务编号</dt><dd>{selected.id}</dd></div><div><dt>尝试次数</dt><dd>{selected.attemptCount}</dd></div>
              {selected.acknowledgedAt ? <div><dt>提醒已确认</dt><dd>{new Date(selected.acknowledgedAt).toLocaleString()}</dd></div> : null}</dl>
            {isAiJob(selected) ? <><button className="secondary-action" type="button" aria-expanded={showRequest}
              onClick={() => setShowRequest((value) => !value)}>{showRequest ? "收起请求快照" : "查看完整请求"}</button>
              {advanced && showRequest ? <RequestSnapshot snapshot={request.data} pending={request.isPending} error={request.error} /> : null}</> : null}
            <h3>运行日志</h3>
            {events.isPending ? <p>正在加载日志…</p> : events.isError ? <p className="project-error" role="alert">{errorMessage(events.error)}</p>
              : <div className="job-log">{events.data?.map((event) => <div className="job-log-entry" key={event.id}><span>{event.progress}%</span>
                <div><p>{event.message}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div></div>)}</div>}
          </details>
        </> : null}</aside></div> : <div className="activity-empty"><ClipboardList size={24} /><p>当前筛选没有后台任务</p>
          {state !== "ALL" ? <button type="button" className="secondary-action" onClick={() => setState("ALL")}>查看全部记录</button> : null}</div>}
    </>}
    </div>
  </section>;
}
