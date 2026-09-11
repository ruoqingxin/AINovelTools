import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, ClipboardList, History, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCost } from "../lib/ai-cost-estimate";
import { acknowledgeFailedJobs, cancelJob, enqueueJob, errorMessage, getPlanningAiJobRequest, listAiRuns, listJobEvents, listJobs, retryJob, runNextJob, type AiRun, type Job, type JobType, type PlanningAiJobInput } from "../lib/tauri-client";

const systemTypes: JobType[] = ["BACKUP", "RESTORE_VERIFY", "HEALTH_SCAN", "REBUILD_SEARCH_INDEX"];
const typeLabels: Record<JobType, string> = {
  BACKUP: "创建备份",
  RESTORE_VERIFY: "恢复校验",
  HEALTH_SCAN: "健康扫描",
  REBUILD_SEARCH_INDEX: "重建索引",
  AI_PLANNING_GENERATE: "规划 AI 推导",
  AI_PLANNING_EXTRACT: "规划文件处理",
};
const statusLabels = { QUEUED: "等待中", RUNNING: "执行中", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消" } as const;
const stageLabels: Record<string, string> = {
  QUEUED: "已排队", PREPARING: "准备任务", RETRIEVAL: "检索上下文", CONTEXT: "整理上下文", REQUESTING: "等待模型",
  RECEIVING: "接收内容", FALLBACK: "切换备用模型", SAVING: "保存结果", COMPLETED: "执行完成", FAILED: "执行失败",
  CANCEL_REQUESTED: "正在取消", CANCELLED: "已取消", RETRY: "重新执行",
};
const runStatusLabels: Record<string, string> = {
  RUNNING: "执行中",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};
const runActionLabels: Record<string, string> = {
  DRAFT: "整章创作",
  CONTINUE: "续写",
  REWRITE: "重写",
  POLISH: "润色",
  SUMMARIZE: "摘要",
  workDesign: "作品设定",
  outline: "大纲主线",
  volumePlanning: "分卷规划",
  chapterSplit: "章节拆分",
  writing: "正文书写",
  knowledgeExtraction: "知识提炼",
};
const runSourceLabels: Record<string, string> = {
  WRITING: "正文创作",
  PLANNING: "规划",
  KNOWLEDGE_EXTRACTION: "知识提炼",
};
const runSourceFilters = [
  { value: "ALL", label: "全部" },
  { value: "WRITING", label: "正文创作" },
  { value: "PLANNING", label: "规划" },
  { value: "KNOWLEDGE_EXTRACTION", label: "知识提炼" },
] as const;
type RunSourceFilter = (typeof runSourceFilters)[number]["value"];

function isAiJob(job: Job) {
  return job.jobType === "AI_PLANNING_GENERATE" || job.jobType === "AI_PLANNING_EXTRACT";
}

function planningInput(job: Job): PlanningAiJobInput | null {
  if (!isAiJob(job)) return null;
  try { return JSON.parse(job.payload) as PlanningAiJobInput; }
  catch { return null; }
}

function jobSummary(job: Job) {
  const input = planningInput(job);
  if (!input) return job.errorSummary ?? "系统维护任务";
  const sourceNames = Array.isArray(input.sourceName)
    ? input.sourceName.filter((name): name is string => typeof name === "string" && name.length > 0)
    : typeof input.sourceName === "string" && input.sourceName.length > 0
      ? [input.sourceName]
      : [];
  return sourceNames.length ? `${input.sectionTitle} · ${sourceNames.join("、")}` : input.sectionTitle;
}

function formatRunDuration(createdAt: string, finishedAt: string | null) {
  if (!finishedAt) return null;
  const startedAt = Date.parse(createdAt);
  const completedAt = Date.parse(finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return null;
  const totalSeconds = Math.max(1, Math.round((completedAt - startedAt) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function runStatusClass(run: AiRun) {
  return run.status === "COMPLETED" ? "succeeded" : run.status.toLowerCase();
}

function AiRunsHistory() {
  const [source, setSource] = useState<RunSourceFilter>("ALL");
  const runs = useQuery({
    queryKey: ["ai-runs", 80],
    queryFn: () => listAiRuns(80),
    refetchInterval: 3_000,
  });
  const filteredRuns = (runs.data ?? []).filter((run) => source === "ALL" || run.source === source);

  return <section className="ai-run-records" aria-label="AI 运行记录">
    <div className="jobs-toolbar">
      <div className="jobs-filters" aria-label="AI 运行分类">
        {runSourceFilters.map((item) => <button type="button" key={item.value} data-active={source === item.value || undefined} onClick={() => setSource(item.value)}>{item.label}</button>)}
      </div>
      <button className="icon-command" type="button" onClick={() => void runs.refetch()} disabled={runs.isFetching} aria-label="刷新 AI 运行记录" title="刷新 AI 运行记录"><RefreshCw size={14} /></button>
    </div>
    {runs.isPending ? <p className="plan-empty">正在加载 AI 运行记录…</p> : runs.isError ? <p className="project-error" role="alert">AI 运行记录加载失败：{errorMessage(runs.error)}</p> : filteredRuns.length ? <div className="ai-run-list">
      {filteredRuns.map((run) => {
        const duration = formatRunDuration(run.createdAt, run.finishedAt);
        const estimatedTokens = run.estimatedInputTokens + run.estimatedOutputTokens;
        return <article className="ai-run-row" key={run.id}>
          <div>
            <strong>{runActionLabels[run.action] ?? run.taskKey} · {run.chapterTitle}</strong>
            <small>{new Date(run.createdAt).toLocaleString()} · {run.profileName} · {runSourceLabels[run.source] ?? run.source}</small>
          </div>
          <span className={`job-status job-${runStatusClass(run)}`}>{runStatusLabels[run.status] ?? run.status}</span>
          <small>尝试 {run.attemptCount}{duration ? ` · 耗时 ${duration}` : ""} · 约 {estimatedTokens.toLocaleString()} tokens · {formatCost(run.estimatedCostMicros, run.priceCurrency)}{run.retryReason ? ` · 回退原因 ${run.retryReason}` : ""}{run.errorCode ? ` · ${run.errorCode}` : ""}</small>
        </article>;
      })}
    </div> : <div className="jobs-empty"><History size={22} /><span>当前分类还没有 AI 运行记录</span></div>}
  </section>;
}

export function JobsView() {
  const client = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 1200 });
  const [recordView, setRecordView] = useState<"JOBS" | "AI_RUNS">("JOBS");
  const [filter, setFilter] = useState<"ALL" | "AI" | "SYSTEM">("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(false);
  const action = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSettled: () => client.invalidateQueries({ queryKey: ["jobs"] }) });
  const filteredJobs = (jobs.data ?? []).filter((job) => filter === "ALL" || (filter === "AI" ? isAiJob(job) : !isAiJob(job)));
  const unacknowledgedFailedCount = (jobs.data ?? []).filter((job) => job.status === "FAILED" && !job.acknowledgedAt).length;
  const selected = (jobs.data ?? []).find((job) => job.id === selectedId) ?? filteredJobs[0] ?? null;
  const events = useQuery({ queryKey: ["job-events", selected?.id], queryFn: () => listJobEvents(selected!.id), enabled: Boolean(selected), refetchInterval: selected?.status === "RUNNING" || selected?.status === "QUEUED" ? 1000 : false });
  const requestPreview = useQuery({
    queryKey: ["planning-ai-request", selected?.id],
    queryFn: () => getPlanningAiJobRequest(selected!.id),
    enabled: Boolean(selected && isAiJob(selected) && showRequest),
    refetchInterval: selected?.status === "RUNNING" || selected?.status === "QUEUED" ? 1000 : false,
  });

  useEffect(() => {
    if (selectedId && !(jobs.data ?? []).some((job) => job.id === selectedId)) setSelectedId(null);
  }, [jobs.data, selectedId]);

  useEffect(() => setShowRequest(false), [selected?.id]);

  useEffect(() => {
    if (showRequest && selected && isAiJob(selected)) void requestPreview.refetch();
  }, [selected?.updatedAt, showRequest]);

  return <section className="jobs-view">
    <div className="page-heading"><div><p className="eyebrow">后台工作</p><h1>任务</h1><p className="page-subtitle">规划、正文创作、知识提炼和系统维护记录都可以在这里查看。</p></div>{recordView === "JOBS" ? <button className="secondary-action" type="button" onClick={() => void action.mutateAsync(() => runNextJob())} disabled={action.isPending}><Play size={15} />执行下一项系统任务</button> : <a className="secondary-action" href="/settings#ai-records">查看预算与记录</a>}</div>
    <div className="jobs-view-switch" role="tablist" aria-label="任务记录类型">
      <button type="button" role="tab" aria-selected={recordView === "JOBS"} data-active={recordView === "JOBS" || undefined} onClick={() => setRecordView("JOBS")}>后台任务</button>
      <button type="button" role="tab" aria-selected={recordView === "AI_RUNS"} data-active={recordView === "AI_RUNS" || undefined} onClick={() => setRecordView("AI_RUNS")}>AI 运行记录</button>
    </div>
    {recordView === "AI_RUNS" ? <AiRunsHistory /> : <>
      <div className="jobs-toolbar"><div className="jobs-filters" aria-label="任务分类">{(["ALL", "AI", "SYSTEM"] as const).map((value) => <button type="button" key={value} data-active={filter === value || undefined} onClick={() => { setFilter(value); setSelectedId(null); }}>{value === "ALL" ? "全部" : value === "AI" ? "AI 任务" : "系统任务"}</button>)}</div><div className="jobs-toolbar-actions">{unacknowledgedFailedCount ? <button className="secondary-action" type="button" onClick={() => void action.mutateAsync(() => acknowledgeFailedJobs())} disabled={action.isPending}><BellOff size={14} />清除失败提醒 {unacknowledgedFailedCount}</button> : null}<button className="icon-command" type="button" onClick={() => void jobs.refetch()} disabled={jobs.isFetching} aria-label="刷新任务" title="刷新任务"><RefreshCw size={14} /></button></div></div>
      <details className="jobs-system-create"><summary>新建系统任务</summary><div>{systemTypes.map((type) => <button key={type} className="secondary-action" type="button" onClick={() => void action.mutateAsync(() => enqueueJob(type))} disabled={action.isPending}>{typeLabels[type]}</button>)}</div></details>
      {action.isError ? <p className="project-error" role="alert">任务操作失败：{errorMessage(action.error)}</p> : null}
      {jobs.isPending ? <p className="plan-empty">正在加载任务…</p> : jobs.isError ? <p className="project-error" role="alert">加载失败：{errorMessage(jobs.error)}</p> : <div className="jobs-workspace">
      <div className="jobs-list">{filteredJobs.length ? filteredJobs.map((job) => <article className="job-row" data-selected={selected?.id === job.id || undefined} key={job.id} role="button" tabIndex={0} aria-pressed={selected?.id === job.id} aria-label={`${typeLabels[job.jobType]}，${statusLabels[job.status]}，进度 ${job.progress}%`} onClick={() => setSelectedId(job.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(job.id); } }}><div className="job-main"><strong>{typeLabels[job.jobType]}</strong><small>{jobSummary(job)}</small><code>{job.id.slice(0, 8)}</code></div><span className={`job-status job-${job.status.toLowerCase()}`}>{statusLabels[job.status]}</span><div className="job-progress"><span style={{ width: `${job.progress}%` }} /></div><small>{job.progress}% · 尝试 {job.attemptCount}</small><div className="job-actions">{job.status === "FAILED" ? <button className="icon-action" type="button" title="重试" aria-label="重试" disabled={action.isPending} onClick={(event) => { event.stopPropagation(); void action.mutateAsync(() => retryJob(job.id)); }}><RotateCcw size={14} /></button> : null}{job.status === "QUEUED" || job.status === "RUNNING" ? <button className="icon-action" type="button" title="取消" aria-label="取消" disabled={action.isPending} onClick={(event) => { event.stopPropagation(); void action.mutateAsync(() => cancelJob(job.id)); }}><Square size={14} /></button> : null}</div></article>) : <div className="jobs-empty"><ClipboardList size={22} /><span>当前分类还没有任务</span></div>}</div>
      <aside className="job-detail" aria-label="任务详情">{selected ? <><div className="job-detail-heading"><div><span>{typeLabels[selected.jobType]}</span><h2>{jobSummary(selected)}</h2></div><span className={`job-status job-${selected.status.toLowerCase()}`}>{statusLabels[selected.status]}</span></div><dl><div><dt>任务编号</dt><dd>{selected.id}</dd></div><div><dt>创建时间</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div>{planningInput(selected) ? <div><dt>目标节点</dt><dd>{planningInput(selected)!.sectionTitle}</dd></div> : null}</dl>{isAiJob(selected) ? <section className="job-request-preview"><button type="button" className="job-request-toggle" aria-expanded={showRequest} onClick={() => setShowRequest((value) => !value)}><span>AI 最终收到的请求</span><small>{showRequest ? "收起" : "查看完整请求"}</small></button>{showRequest ? requestPreview.isPending ? <p>正在读取最终请求…</p> : requestPreview.isError ? <p className="project-error">读取失败：{errorMessage(requestPreview.error)}</p> : requestPreview.data?.requestBody ? <div className="job-request-content"><div className="job-request-meta"><span><b>POST</b>{requestPreview.data.endpoint}</span>{requestPreview.data.estimatedInputTokens !== null ? <small>估算输入 {requestPreview.data.estimatedInputTokens} tokens</small> : null}</div><pre>{requestPreview.data.requestBody}</pre><p>请求体来自实际执行快照；Authorization 与 API Key 不会记录。</p></div> : <div className="job-request-empty"><strong>{selected.status === "QUEUED" ? "尚未发送" : "未记录执行快照"}</strong><span>{selected.status === "QUEUED" ? "任务开始请求模型后，这里会显示 AI 实际收到的完整 JSON。" : "旧任务或请求模型前失败的任务没有最终请求记录。"}</span></div> : null}</section> : null}<div className="job-detail-progress"><div><strong>执行进度</strong><span>{selected.progress}%</span></div><div className="job-progress"><span style={{ width: `${selected.progress}%` }} /></div></div>{selected.errorSummary ? <p className="project-error">{selected.errorSummary}</p> : null}<div className="job-log-heading"><strong>运行日志</strong><span>{events.data?.length ?? 0} 条</span></div><div className="job-log">{events.isPending ? <p>正在加载日志…</p> : events.data?.length ? events.data.map((event) => <div className="job-log-entry" key={event.id}><span>{event.progress}%</span><div><strong>{stageLabels[event.stage] ?? event.stage}</strong><p>{event.message}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div></div>) : <p>该任务还没有阶段日志。</p>}</div></> : <div className="jobs-empty"><ClipboardList size={22} /><span>选择一个任务查看详情</span></div>}</aside>
      </div>}
    </>}
  </section>;
}
