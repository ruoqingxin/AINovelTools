import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookOpenText, RefreshCw } from "lucide-react";
import { useState } from "react";
import { entityChapterHref, entityHref } from "../lib/entity-navigation";
import { errorMessage, listEntityChapters, listPlanNodes } from "../lib/tauri-client";
import "./entity-references.css";

export function EntityChapters({ projectId, entityId }: { projectId: string; entityId: string }) {
  const [open, setOpen] = useState(false);
  const [chapterId, setChapterId] = useState("");
  const chapters = useQuery({ queryKey: ["entity-chapters", projectId, entityId],
    queryFn: () => listEntityChapters(projectId, entityId), enabled: open, retry: false });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes, enabled: open });
  const available = (nodes.data ?? []).filter((node) => node.kind === "CHAPTER" && !node.archived);
  return <details className="entity-chapters" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><BookOpenText size={14} />关联章节</summary>
    {open ? <div>
      {chapters.isError ? <p role="alert" className="project-error">{errorMessage(chapters.error)}
        <button type="button" className="secondary-action" onClick={() => void chapters.refetch()}><RefreshCw size={14} />重试</button></p>
        : chapters.isPending ? <p role="status">正在读取关联章节…</p>
        : chapters.data.length ? <ul>{chapters.data.map((chapter) => <li key={chapter.chapterId}>
          {chapter.archived ? <span>{chapter.title} · 已归档</span>
            : <a href={entityChapterHref(chapter.chapterId, projectId, entityHref(entityId, projectId))}><ArrowUpRight size={14} />{chapter.title}</a>}
        </li>)}</ul> : <p>暂无关联章节。</p>}
      {nodes.isError ? <p className="project-error" role="alert">{errorMessage(nodes.error)}</p> : null}
      {available.length ? <div className="entity-reference-actions">
        <select aria-label="选择关联目标章节" value={chapterId} onChange={(event) => setChapterId(event.target.value)}>
          <option value="">选择章节</option>{available.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
        </select>
        {available.some((node) => node.id === chapterId) ? <a className="secondary-action" href={entityChapterHref(chapterId, projectId, entityHref(entityId, projectId))}><ArrowUpRight size={14} />打开章节计划</a> : null}
      </div> : null}
    </div> : null}
  </details>;
}
