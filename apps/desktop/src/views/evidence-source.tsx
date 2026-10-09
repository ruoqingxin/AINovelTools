import { BookOpenText, RefreshCw } from "lucide-react";
import { manuscriptSourceHref, useManuscriptSource } from "../lib/manuscript-source";
import { errorMessage, type EvidenceAnchor } from "../lib/tauri-client";

export function evidenceSourceRequest(anchor: EvidenceAnchor) {
  return {
    projectId: anchor.projectId, evidenceAnchorId: anchor.id, revisionId: anchor.sourceRevisionId,
    chapterId: anchor.chapterId, blockId: anchor.blockId,
  };
}

export function EvidenceSource({ anchor, active, returnTo }: { anchor: EvidenceAnchor; active: boolean; returnTo: string }) {
  const request = evidenceSourceRequest(anchor);
  const { project, source } = useManuscriptSource(request, active);
  const failed = project.isError || source.isError;
  return <blockquote>
    <p>{failed ? `原文校验失败：${errorMessage(project.error ?? source.error)}。未使用其他修订。`
      : !project.isPending && !project.data ? "未打开来源项目。"
      : source.data ? source.data.quote : "正在校验原文证据…"}</p>
    <footer><span>{anchor.sourceVersion}</span><code>{anchor.blockId}</code>
      <a href={manuscriptSourceHref(request, returnTo)}><BookOpenText size={14} />定位原文</a>
      {failed ? <button type="button" className="secondary-action" onClick={() => void (project.isError ? project.refetch() : source.refetch())}><RefreshCw size={14} />重试</button> : null}
    </footer>
  </blockquote>;
}
