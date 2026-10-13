import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Database, FolderOpen, HardDriveDownload, ShieldCheck, Stethoscope } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { enqueueJob, errorMessage, getCurrentProject, type Job, type JobType } from "../lib/tauri-client";
import { useJobs } from "../lib/jobs-query";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import "./activity-workspace.css";

type Operation = "BACKUP" | "VERIFY" | "RESTORE" | "HEALTH_SCAN" | "REBUILD_SEARCH_INDEX";
const operations = [
  { key: "BACKUP", label: "创建备份", icon: HardDriveDownload },
  { key: "VERIFY", label: "校验备份", icon: ShieldCheck },
  { key: "RESTORE", label: "恢复为新作品", icon: FolderOpen },
  { key: "HEALTH_SCAN", label: "检查数据健康", icon: Stethoscope },
  { key: "REBUILD_SEARCH_INDEX", label: "重建搜索索引", icon: Database },
] as const;
const statuses = { QUEUED: "等待执行", RUNNING: "执行中", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消" };

export function DataManagementView({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const jobs = useJobs();
  const [operation, setOperation] = useState<Operation>("BACKUP");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Job | null>(null);
  const dirty = Boolean(source || target) || busy;
  useUnsavedChangesGuard(dirty, "数据管理有未提交路径或正在提交的维护操作。");
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const needsSource = operation === "VERIFY" || operation === "RESTORE";
  const currentJob = jobs.data?.find((job) => job.id === receipt?.id) ?? receipt;

  async function choosePath(field: "source" | "target") {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const path = field === "source"
        ? await open({ title: "选择当前作品的备份目录", directory: true, multiple: false })
        : await save({ title: "新作品目录（必须尚不存在）", defaultPath: "RestoredNovel" });
      if (typeof path === "string" && path) {
        if (field === "source") setSource(path); else setTarget(path);
      }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); locked.current = false; }
  }

  async function submit() {
    if (locked.current || !project.data || needsSource && !source.trim() || operation === "RESTORE" && !target.trim()) return;
    if (operation === "RESTORE" && !window.confirm(`校验备份后，将恢复到新目录：\n${target.trim()}\n当前作品不会被覆盖或切换。确定继续吗？`)) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const type: JobType = needsSource ? "RESTORE_VERIFY" : operation as JobType;
      const payload = needsSource ? { source: source.trim(), ...(operation === "RESTORE" ? { target: target.trim() } : {}) } : {};
      const saved = await enqueueJob(type, JSON.stringify(payload));
      setReceipt(saved);
      setSource("");
      setTarget("");
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); locked.current = false; }
  }

  return <section className="settings-content activity-workspace data-management">
    <div className="settings-content-heading"><div><span className="settings-scope-label">当前作品 · {project.data?.name ?? "未打开作品"}</span><h2>数据管理</h2></div>
      {project.data ? <a className="secondary-action" href="/jobs">后台活动</a> : null}</div>
    <div className="maintenance-operations" role="group" aria-label="维护操作">
      {operations.map(({ key, icon: Icon }) => <button type="button" className="secondary-action" key={key}
        aria-pressed={operation === key} disabled={busy} onClick={() => { setOperation(key); setError(null); }}>
        <Icon size={15} />{key === "BACKUP" ? "备份" : key === "VERIFY" ? "校验" : key === "RESTORE" ? "恢复" : key === "HEALTH_SCAN" ? "数据健康" : "搜索索引"}</button>)}
    </div>
    {project.isError ? <p className="project-error" role="alert">无法读取当前作品：{errorMessage(project.error)}</p> : null}
    {!project.data ? <p className="plan-empty">{project.isPending ? "正在读取作品…" : "请先打开作品"}</p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {project.data ? <form className="maintenance-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3>{operations.find((item) => item.key === operation)!.label}</h3>
      <fieldset disabled={busy}>
        {needsSource ? <label>备份目录<div className="maintenance-path"><input aria-label="备份目录" value={source}
          onChange={(event) => setSource(event.target.value)} required />
          <button type="button" className="icon-command" title="选择备份目录" aria-label="选择备份目录" onClick={() => void choosePath("source")}><FolderOpen size={16} /></button>
        </div></label> : null}
        {operation === "RESTORE" ? <label>新作品目录<div className="maintenance-path"><input aria-label="新作品目录" value={target}
          onChange={(event) => setTarget(event.target.value)} required />
          <button type="button" className="icon-command" title="选择新作品位置" aria-label="选择新作品位置" onClick={() => void choosePath("target")}><FolderOpen size={16} /></button>
        </div></label> : null}
        <p className="maintenance-safety">{operation === "BACKUP" ? "备份保存到当前作品的 snapshots 目录；仅包含已经写入本地的数据。"
          : operation === "RESTORE" ? "只接受当前作品的备份；目标目录必须不存在。先校验再恢复，不覆盖当前作品。"
          : operation === "VERIFY" ? "校验当前作品备份的文件完整性，不写入或恢复作品。"
          : operation === "HEALTH_SCAN" ? "检查本地数据库完整性和作品目录，不修改正文。"
          : "重新建立检索索引，不修改正文与资料。"}</p>
        <div className="maintenance-actions"><button type="submit" className="primary-action"
          disabled={busy || needsSource && !source.trim() || operation === "RESTORE" && !target.trim()}>
          {busy ? "提交中…" : operation === "RESTORE" ? "校验并恢复" : operations.find((item) => item.key === operation)!.label}</button></div>
      </fieldset>
    </form> : null}
    {currentJob ? <div className="maintenance-result" role="status"><strong>{statuses[currentJob.status]}</strong>
      <p>{currentJob.errorSummary ?? `${currentJob.progress}%`}</p>
      <a className="secondary-action" href={`/jobs?jobId=${encodeURIComponent(currentJob.id)}`}>查看任务结果</a></div> : null}
  </section>;
}
