import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { cancelJob, enqueueJob, listJobs, retryJob, runNextJob, type JobType } from "../lib/tauri-client";
import { errorMessage } from "../lib/tauri-client";

const types: JobType[] = ["BACKUP", "RESTORE_VERIFY", "HEALTH_SCAN", "REBUILD_SEARCH_INDEX"];

export function JobsView() {
  const client = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 3000 });
  const action = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSettled: () => client.invalidateQueries({ queryKey: ["jobs"] }) });
  return <section className="jobs-view">
    <div className="page-heading"><div><p className="eyebrow">可靠性</p><h1>后台任务</h1><p className="page-subtitle">查看任务进度、取消运行中的任务，或重试失败任务。</p></div><button className="secondary-action" type="button" onClick={() => void action.mutateAsync(() => runNextJob())}><Play size={15} />执行下一项</button></div>
    <div className="jobs-toolbar"><span>新建任务</span>{types.map((type) => <button key={type} className="secondary-action" type="button" onClick={() => void action.mutateAsync(() => enqueueJob(type))}>{type}</button>)}<button className="secondary-action" type="button" onClick={() => void jobs.refetch()}><RefreshCw size={14} />刷新</button></div>
    {jobs.isPending ? <p className="plan-empty">正在加载任务…</p> : jobs.isError ? <p className="project-error" role="alert">加载失败：{errorMessage(jobs.error)}</p> : <div className="jobs-list">{jobs.data?.map((job) => <article className="job-row" key={job.id}><div><strong>{job.jobType}</strong><code>{job.id.slice(0, 8)}</code></div><span className={`job-status job-${job.status.toLowerCase()}`}>{job.status}</span><div className="job-progress"><span style={{ width: `${job.progress}%` }} /></div><small>尝试 {job.attemptCount} · {job.errorSummary ?? "无错误"}</small><div className="job-actions">{job.status === "FAILED" ? <button className="icon-action" title="重试" aria-label="重试" onClick={() => void action.mutateAsync(() => retryJob(job.id))}><RotateCcw size={14} /></button> : null}{job.status === "QUEUED" || job.status === "RUNNING" ? <button className="icon-action" title="取消" aria-label="取消" onClick={() => void action.mutateAsync(() => cancelJob(job.id))}><Square size={14} /></button> : null}</div></article>)}</div>}
  </section>;
}
