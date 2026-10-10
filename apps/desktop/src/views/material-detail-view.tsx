import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, RefreshCw } from "lucide-react";
import { materialHref, parseMaterialTarget, summaryManuscriptHref } from "../lib/knowledge-navigation";
import { sourceReturnTo } from "../lib/manuscript-source";
import { errorMessage, getCurrentProject, getSummaryMaterial, getWritingCard } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import "./material-detail-view.css";

export function MaterialDetailView({ target }: { target: NonNullable<ReturnType<typeof parseMaterialTarget>> }) {
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, staleTime: 30_000 });
  const valid = Boolean(target.kind && target.id && target.projectId && project.data?.projectId === target.projectId);
  const summary = useQuery({
    queryKey: ["summary-material", project.data?.projectId, target.id],
    queryFn: () => getSummaryMaterial(target.id, target.projectId),
    enabled: valid && target.kind === "SUMMARY", retry: false,
  });
  const card = useQuery({
    queryKey: ["writing-card", project.data?.projectId, target.id],
    queryFn: () => getWritingCard(target.id, target.projectId),
    enabled: valid && target.kind === "CARD", retry: false,
  });
  const result = target.kind === "SUMMARY" ? summary : card;
  const currentSummary = valid && target.kind === "SUMMARY" ? summary.data : undefined;
  const currentCard = valid && target.kind === "CARD" ? card.data : undefined;
  const item = valid ? result.data : undefined;
  const returnTo = sourceReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
  const selfHref = target.kind ? materialHref(target.kind, target.id, target.projectId, returnTo ?? undefined) : "";
  const sourceHref = currentSummary ? summaryManuscriptHref(currentSummary, selfHref) : null;
  const unavailable = !project.isPending && !project.isError && !valid;

  return <section className="materials-view material-detail-view">
    <div className="workspace-heading"><p className="eyebrow">知识资料</p><h1>{target.kind === "SUMMARY" ? "当前摘要" : "当前写作卡片"}</h1>
      <div className="material-detail-actions">
        {returnTo ? <a className="secondary-action" href={returnTo}><ArrowLeft size={15} />返回来源</a> : null}
        <a className="secondary-action" href="/knowledge/materials"><BookOpenText size={15} />资料管理</a>
        {valid ? <button className="secondary-action" type="button" disabled={result.isFetching} onClick={() => void result.refetch()}><RefreshCw size={15} />刷新当前内容</button> : null}
      </div>
    </div>
    <KnowledgeSectionNav />
    {project.isPending || valid && result.isPending ? <p role="status">正在读取资料…</p> : null}
    {unavailable ? <p className="project-error" role="alert">资料链接无效或不属于当前项目，未打开其他资料。</p> : null}
    {project.isError || valid && result.isError ? <div className="project-error" role="alert">资料读取失败：{errorMessage(project.error ?? result.error)}
      <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : result.refetch())}><RefreshCw size={15} />重试</button>
    </div> : null}
    {item && !result.isError ? <div className="material-detail-body">
      <h2>{currentCard?.title ?? (currentSummary?.generationMode === "EXTRACTIVE_AUTO" ? "章节记忆" : currentSummary?.generationMode === "EXTRACTIVE_AUTO_SETTINGS" ? "设定概览" : currentSummary?.generationMode === "EXTRACTIVE_AUTO_PROJECT" ? "项目概览" : "参考摘要")}</h2>
      <dl className="material-detail-metadata">
        <div><dt>对象</dt><dd><code>{item.id}</code></dd></div>
        <div><dt>来源标识</dt><dd><code>{item.sourceVersion ?? "无"}</code></dd></div>
        <div><dt>更新于</dt><dd>{item.updatedAt}</dd></div>
        {currentSummary ? <div><dt>状态</dt><dd>{currentSummary.lifecycleStatus === "ACTIVE" ? "有效" : currentSummary.lifecycleStatus === "CANDIDATE" ? "AI 候选" : "已失效"}</dd></div> : null}
        {currentCard ? <div><dt>状态 / 范围</dt><dd>{currentCard.enabled ? "已启用" : "已停用"} · {currentCard.scope}</dd></div> : null}
      </dl>
      <p className="material-detail-content">{item.content}</p>
      {sourceHref ? <a className="secondary-action" href={sourceHref}><BookOpenText size={15} />查看摘要来源正文</a> : null}
    </div> : null}
  </section>;
}
