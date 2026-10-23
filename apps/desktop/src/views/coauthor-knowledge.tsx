import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { manuscriptSourceHref } from "../lib/manuscript-source";
import {
  errorMessage, listCoauthorKnowledgeAnchors, listCoauthorRelatedKnowledge, readCoauthorKnowledgeEvidence,
  type CoauthorKnowledgeAnchor, type CoauthorScope, type CoauthorSource,
} from "../lib/tauri-client";

const anchorStatuses: Record<string, string> = {
  CURRENT_REVISION: "原修订仍在用，原文范围尚未核验", STALE: "正文已有新修订，仅作历史",
  ARCHIVED: "证据或章节已归档", INVALID: "证据身份或版本不匹配", MISSING: "证据缺失或不属于本项目",
  NEEDS_REVIEW: "证据状态待核对",
};

function KnowledgeEvidence({ scope, source, anchor, directoryUnavailable = false }: {
  scope: CoauthorScope; source: CoauthorSource; anchor: CoauthorKnowledgeAnchor; directoryUnavailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets[offsets.length - 1];
  const evidence = useQuery({
    queryKey: ["coauthor-knowledge-evidence", scope.projectId, scope.sessionId, source.key, source.revision, anchor.id, offset],
    queryFn: () => readCoauthorKnowledgeEvidence({
      scope, key: source.key, revision: source.revision, anchorId: anchor.id, offset, limit: 2000,
    }), enabled: open && !directoryUnavailable, retry: false,
  });
  const verified = Boolean(evidence.data && !evidence.isFetching && !evidence.isError && !directoryUnavailable);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>正文证据 · {anchor.blockId ?? anchor.id}</summary>
    {open && <>
      <small>{anchor.status === "CURRENT_REVISION" && verified ? "原修订仍在用" : anchorStatuses[anchor.status] ?? anchor.status}</small>
      {directoryUnavailable && <p role="status">目录版本尚未核实，已有证据仅供历史对照。</p>}
      {evidence.isPending && !directoryUnavailable && <p role="status">正在校验原文证据…</p>}
      {evidence.error && <p role="alert" className="project-error">证据无法核实：{errorMessage(evidence.error)}</p>}
      {evidence.data && <>
        {(evidence.isFetching || evidence.isError || directoryUnavailable) && <p role="status">以下为缓存证据，当前状态尚未核实。</p>}
        {verified && <p role="status">
          原文身份与范围已核验 · 本段 {evidence.data.offset} 至 {evidence.data.nextOffset} / {evidence.data.totalChars} 字符
        </p>}
        {!evidence.data.isCurrentRevision && <p role="status">历史原文，不代表当前正文仍采用此版本。</p>}
        <small>块内字符 {evidence.data.start + evidence.data.offset} 至 {evidence.data.start + evidence.data.nextOffset}</small>
        <blockquote>{evidence.data.content}</blockquote>
        <a href={manuscriptSourceHref({
          projectId: scope.projectId, evidenceAnchorId: anchor.id, revisionId: evidence.data.revisionId,
          chapterId: evidence.data.chapterId, blockId: evidence.data.blockId,
        }, `/discussion?targetProject=${encodeURIComponent(scope.projectId)}&targetSession=${encodeURIComponent(scope.sessionId)}`)}>
          定位原修订
        </a>
        {(offsets.length > 1 || evidence.data.nextOffset < evidence.data.totalChars) && <nav className="coauthor-check-pagination" aria-label="证据分页">
          <button type="button" className="icon-command" aria-label="上一段证据" title="上一段证据"
            disabled={offsets.length === 1 || evidence.isFetching} onClick={() => setOffsets((values) => values.slice(0, -1))}><ArrowLeft size={16} /></button>
          <span>第 {offsets.length} 段</span>
          <button type="button" className="icon-command" aria-label="下一段证据" title="下一段证据"
            disabled={directoryUnavailable || evidence.isFetching || evidence.isError || evidence.data.nextOffset >= evidence.data.totalChars}
            onClick={() => setOffsets((values) => [...values, evidence.data!.nextOffset])}><ArrowRight size={16} /></button>
        </nav>}
      </>}
      <button type="button" className="icon-command" aria-label="刷新原文证据" title="刷新原文证据"
        disabled={directoryUnavailable || evidence.isFetching} onClick={() => void evidence.refetch()}><RefreshCw size={16} /></button>
    </>}
  </details>;
}

function KnowledgeAnchors({ scope, source }: { scope: CoauthorScope; source: CoauthorSource }) {
  const [offset, setOffset] = useState(0);
  const [requested, setRequested] = useState(false);
  const context = source.knowledgeContext!;
  const page = useQuery({
    queryKey: ["coauthor-knowledge-anchors", scope.projectId, scope.sessionId, source.key, source.revision, offset],
    queryFn: () => listCoauthorKnowledgeAnchors({ scope, key: source.key, revision: source.revision, offset }),
    enabled: requested, retry: false,
  });
  const anchors = requested ? page.data?.anchors : context.anchors;
  const total = requested ? page.data?.totalAnchors : context.totalAnchors || context.anchors.length;
  const next = requested ? page.data?.nextOffset : context.anchors.length;
  const hasMore = requested ? next !== undefined && total !== undefined && next < total : context.hasMoreAnchors;
  const navigate = (value: number) => { setRequested(true); setOffset(value); };
  return <section aria-label="证据目录">
    <p>{anchors ? `证据目录 · ${offset + (anchors.length ? 1 : 0)} 至 ${offset + anchors.length} / ${total} 条`
      : `证据目录 · 第 ${Math.floor(offset / 16) + 1} 页`}</p>
    {requested && page.isPending && <p role="status">正在核对证据目录…</p>}
    {requested && page.error && <p role="alert" className="project-error">证据目录无法核实：{errorMessage(page.error)}</p>}
    {requested && page.data && (page.isFetching || page.isError) && <p role="status">以下为缓存目录，当前状态尚未核实。</p>}
    {anchors?.map((anchor, index) => <KnowledgeEvidence key={`${offset + index}:${anchor.id}`}
      scope={scope} source={source} anchor={anchor} directoryUnavailable={requested && (page.isFetching || page.isError)} />)}
    {hasMore && <p role="status">还有证据未展示，目录状态不代表原文已核验。</p>}
    <nav className="coauthor-check-pagination" aria-label="证据目录分页">
      <button type="button" className="icon-command" aria-label="上一页证据" title="上一页证据"
        disabled={offset === 0 || (requested && page.isFetching)}
        onClick={() => navigate(Math.max(0, offset - 16))}><ArrowLeft size={16} /></button>
      <span>第 {Math.floor(offset / 16) + 1} 页</span>
      <button type="button" className="icon-command" aria-label="下一页证据" title="下一页证据"
        disabled={!hasMore || (requested && (page.isFetching || page.isError))}
        onClick={() => navigate(next!)}><ArrowRight size={16} /></button>
      <button type="button" className="icon-command" aria-label="刷新证据目录" title="刷新证据目录"
        disabled={requested && page.isFetching}
        onClick={() => { if (requested) void page.refetch(); else setRequested(true); }}><RefreshCw size={16} /></button>
    </nav>
  </section>;
}

export function CoauthorKnowledge({ scope, source, onRead }: {
  scope: CoauthorScope; source: CoauthorSource; onRead: (key: string, revision: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const context = source.knowledgeContext;
  const related = useQuery({
    queryKey: ["coauthor-related-knowledge", scope.projectId, scope.sessionId, source.key, source.revision, offset],
    queryFn: () => listCoauthorRelatedKnowledge({ scope, key: source.key, revision: source.revision, offset }),
    enabled: Boolean(context && open && source.kind === "FACT"), retry: false,
  });
  if (!context) return null;
  return <aside className="coauthor-knowledge" aria-label="读取时的事实与关系依据">
    <strong>{source.kind === "FACT" ? "已审核事实记录" : "关系记录"} · v{context.version}</strong>
    <p>{context.status === "CURRENT" ? "原证据修订仍在用，原文范围与适用条件尚须核对。"
      : "依据待核对，不能直接当作当前有效结论。"}</p>
    {context.facts.map((fact, index) => <button type="button" key={`${fact.key}:${index}`}
      onClick={() => onRead(fact.key, fact.revision)}>{index === 0 ? "起点事实" : "终点事实"} · {fact.title}</button>)}
    <KnowledgeAnchors key={`${scope.projectId}:${scope.sessionId}:${source.key}:${source.revision}`}
      scope={scope} source={source} />
    {source.kind === "FACT" && <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>直接关联关系</summary>
      {open && <>
        {related.isPending && <p role="status">正在读取直接关系…</p>}
        {related.error && <p role="alert" className="project-error">直接关系无法核实：{errorMessage(related.error)}</p>}
        {related.data && <>
          {(related.isFetching || related.isError) && <p role="status">以下为缓存关系，当前状态尚未核实。</p>}
          {!related.data.hits.length && !related.isError && <p>此页没有直接关系记录，不代表没有其他影响。</p>}
          {related.data.hits.map((hit) => <section key={hit.key}>
            <strong>{hit.title}</strong>
            <p>{hit.knowledgeContext?.status === "CURRENT" ? "原证据修订仍在用" : "依据待核对"}</p>
            <button type="button" disabled={related.isFetching || related.isError} onClick={() => onRead(hit.key, hit.revision)}>查看关系记录</button>
          </section>)}
          {(offset > 0 || related.data.hasMore) && <nav className="coauthor-check-pagination" aria-label="直接关系分页">
            <button type="button" className="icon-command" aria-label="上一页关系" title="上一页关系"
              disabled={!offset || related.isFetching} onClick={() => setOffset((value) => Math.max(0, value - 12))}><ArrowLeft size={16} /></button>
            <span>第 {offset / 12 + 1} 页</span>
            <button type="button" className="icon-command" aria-label="下一页关系" title="下一页关系"
              disabled={!related.data.hasMore || related.isFetching || related.isError}
              onClick={() => setOffset((value) => value + 12)}><ArrowRight size={16} /></button>
          </nav>}
        </>}
        <button type="button" className="icon-command" aria-label="刷新直接关系" title="刷新直接关系"
          disabled={related.isFetching} onClick={() => void related.refetch()}><RefreshCw size={16} /></button>
      </>}
    </details>}
  </aside>;
}
