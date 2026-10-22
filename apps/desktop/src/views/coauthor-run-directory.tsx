import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { errorMessage, listCoauthorRuns, type CoauthorScope } from "../lib/tauri-client";

const statuses: Record<string, string> = {
  RUNNING: "进行中", COMPLETED: "已完成", CANCELLED: "已停止", SUPERSEDED: "已替代",
  INTERRUPTED: "已中断", FAILED: "失败", LIMIT_REACHED: "达到预算",
};

export function CoauthorRunDirectory({ scope, selected, onSelect }: {
  scope: CoauthorScope; selected: string; onSelect: (id: string) => void;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const beforeRunId = cursors[cursors.length - 1];
  const page = useQuery({
    queryKey: ["coauthor-runs", scope.projectId, scope.sessionId, beforeRunId],
    queryFn: () => listCoauthorRuns({ scope, beforeRunId }), retry: false,
  });
  return <section className="coauthor-run-directory" aria-label="运行目录">
    <div className="coauthor-run-picker">
      <select aria-label="查看运行" value={selected} disabled={!page.data || page.isFetching || page.isError}
        onChange={(event) => onSelect(event.target.value)}>
        <option value="">选择运行</option>
        {selected && !page.data?.runs.some((run) => run.id === selected)
          && <option value={selected}>当前记录 · {selected.slice(0, 8)}</option>}
        {page.data?.runs.map((run) => <option key={run.id} value={run.id}>
          {statuses[run.status] ?? run.status} · {run.id.slice(0, 8)} · 稿件 v{run.documentVersion}
        </option>)}
      </select>
      <button type="button" className="icon-command" title="刷新运行目录" aria-label="刷新运行目录"
        disabled={page.isFetching} onClick={() => void page.refetch()}><RefreshCw size={16} /></button>
    </div>
    {page.isPending && <p role="status">正在读取运行目录…</p>}
    {page.error && <p role="alert" className="project-error">运行目录无法核实：{errorMessage(page.error)}</p>}
    {page.data && (page.isFetching || page.isError) && <p role="status">当前显示缓存目录，状态尚未核实。</p>}
    {page.data && !page.data.runs.length && <p>此页没有运行记录。</p>}
    {page.data && (cursors.length > 1 || page.data.hasMore) && <nav className="coauthor-check-pagination" aria-label="运行目录分页">
      <button type="button" className="icon-command" title="较新运行" aria-label="较新运行"
        disabled={cursors.length === 1 || page.isFetching} onClick={() => setCursors((values) => values.slice(0, -1))}><ArrowLeft size={16} /></button>
      <span>第 {cursors.length} 页</span>
      <button type="button" className="icon-command" title="更早运行" aria-label="更早运行"
        disabled={!page.data.hasMore || page.isFetching || page.isError || !page.data.runs.length}
        onClick={() => setCursors((values) => [...values, page.data!.runs[page.data!.runs.length - 1].id])}><ArrowRight size={16} /></button>
    </nav>}
  </section>;
}
