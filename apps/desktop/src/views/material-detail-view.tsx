import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { materialHref, parseMaterialTarget, summaryManuscriptHref } from "../lib/knowledge-navigation";
import { sourceReturnTo } from "../lib/manuscript-source";
import { errorMessage, getCurrentProject, getSummaryMaterial, getWritingCard } from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import "./material-detail-view.css";
import "./library-workspace.css";
import { automaticSummary, MaterialEditor, SummaryActions } from "./material-controls";
import { aiWorkspaceHref, summaryIdentity, writingCardTypeLabels } from "../lib/content-taxonomy";
import { AiWorkspaceLink, ContentTypeLabel, useInAiWorkspace } from "./content-identity";
import { WorkspaceLink } from "./workspace-link";

export function MaterialDetailView({ target }: { target: NonNullable<ReturnType<typeof parseMaterialTarget>> }) {
  const aiWorkspace = useInAiWorkspace();
  const [editing, setEditing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  return <section className="materials-view material-detail-view library-workspace">
    <div className="workspace-heading">{!aiWorkspace && <h1>{target.kind === "SUMMARY" ? "当前摘要" : "当前写作卡片"}</h1>}
      <div className="material-detail-actions">
        {!aiWorkspace && returnTo ? <WorkspaceLink className="secondary-action" href={returnTo}><ArrowLeft size={15} />返回来源</WorkspaceLink> : null}
        <WorkspaceLink className="secondary-action" href={aiWorkspace ? aiWorkspaceHref({ workflow: "materials", projectId: target.projectId, materialKind: target.kind ?? undefined }) : "/knowledge/materials"}><BookOpenText size={15} />{aiWorkspace ? "参考列表" : "资料管理"}</WorkspaceLink>
        {valid ? <button className="secondary-action" type="button" disabled={editing || actionBusy || result.isFetching} onClick={() => void result.refetch()}><RefreshCw size={15} />刷新当前内容</button> : null}
      </div>
    </div>
    <KnowledgeSectionNav />
    {notice ? <p role="status" className="project-notice">{notice}</p> : null}
    {project.isPending || valid && result.isPending ? <p role="status">正在读取资料…</p> : null}
    {unavailable ? <p className="project-error" role="alert">资料链接无效或不属于当前项目，未打开其他资料。</p> : null}
    {project.isError || valid && result.isError ? <div className="project-error" role="alert">资料读取失败：{errorMessage(project.error ?? result.error)}
      <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : result.refetch())}><RefreshCw size={15} />重试</button>
    </div> : null}
    {item && !result.isError ? <div className="material-detail-body">
      <ContentTypeLabel identity={currentSummary ? summaryIdentity(currentSummary) : { category: "REFERENCE", subtype: currentCard ? writingCardTypeLabels[currentCard.cardType] : "参考摘要" }} />
      <h2>{currentCard?.title ?? (currentSummary?.generationMode === "EXTRACTIVE_AUTO" ? "章节记忆" : currentSummary?.generationMode === "EXTRACTIVE_AUTO_SETTINGS" ? "设定概览" : currentSummary?.generationMode === "EXTRACTIVE_AUTO_PROJECT" ? "项目概览" : "参考摘要")}</h2>
      {editing && project.data && target.kind ? <MaterialEditor key={item.id} kind={target.kind} projectId={project.data.projectId}
        summary={currentSummary ?? undefined} card={currentCard ?? undefined} onCancel={() => setEditing(false)}
        onSaved={(id) => {
          if (id !== item.id) {
            // Release the saved editor's leave guard before native navigation.
            flushSync(() => setEditing(false));
            const href = aiWorkspace
              ? aiWorkspaceHref({ workflow: "materials", projectId: target.projectId, targetId: id, materialKind: "SUMMARY", returnTo: returnTo ?? undefined })
              : materialHref("SUMMARY", id, target.projectId, returnTo ?? undefined);
            window.location.assign(href);
          }
          else { setEditing(false); setNotice("资料已保存"); }
        }} /> : <>
      <details className="library-advanced"><summary>来源与高级信息</summary><dl className="material-detail-metadata">
        <div><dt>对象</dt><dd><code>{item.id}</code></dd></div>
        <div><dt>来源标识</dt><dd><code>{item.sourceVersion ?? "无"}</code></dd></div>
        <div><dt>更新于</dt><dd>{item.updatedAt}</dd></div>
        {currentSummary ? <div><dt>状态</dt><dd>{currentSummary.lifecycleStatus === "ACTIVE" ? "有效" : currentSummary.lifecycleStatus === "CANDIDATE" ? "AI 候选" : "已失效"}</dd></div> : null}
        {currentCard ? <div><dt>状态 / 范围</dt><dd>{currentCard.enabled ? "已启用" : "已停用"} · {currentCard.scope}</dd></div> : null}
      </dl></details>
      <p className="material-detail-content">{item.content}</p>
      <div className="library-actions">{aiWorkspace ? <button type="button" className="secondary-action" disabled={actionBusy} onClick={() => { setEditing(true); setNotice(null); }}><Pencil size={15} />
        {currentSummary && automaticSummary(currentSummary) ? "编辑参考副本" : "编辑资料"}</button>
        : target.kind && <AiWorkspaceLink target={{ projectId: target.projectId, workflow: "materials", targetId: target.id, materialKind: target.kind }}>去构思处理此参考</AiWorkspaceLink>}</div>
      {currentSummary ? <SummaryActions item={currentSummary} onBusyChange={setActionBusy} /> : null}
      {sourceHref ? <a className="secondary-action" href={sourceHref}><BookOpenText size={15} />查看摘要来源正文</a> : null}
      </>}
    </div> : null}
  </section>;
}
