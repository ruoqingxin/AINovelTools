import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileCheck2, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  detectCandidateConflicts,
  errorMessage,
  finalizeKnowledgeCandidates,
  listEvidenceAnchors,
  listKnowledgeCandidates,
  listManuscriptRevisions,
  listPlanNodes,
  reviewKnowledgeCandidate,
  type CandidateStatus,
} from "../lib/tauri-client";
import { KnowledgeSectionNav } from "./knowledge-section-nav";

const candidateStatusLabels: Record<CandidateStatus, string> = {
  PENDING: "待审核",
  NEEDS_REVIEW: "需复核",
  APPROVED: "已批准",
  REJECTED: "已拒绝",
  FINALIZED: "已定稿",
};

const conflictKindLabels = {
  DUPLICATE_FACT: "重复事实",
  CONTRADICTORY_OBJECT: "结论冲突",
} as const;

function extractBlockText(documentJson: string, blockId: string) {
  try {
    const document = JSON.parse(documentJson) as {
      content?: Array<{ attrs?: { blockId?: string }; content?: Array<{ text?: string }> }>;
    };
    const block = (document.content ?? []).find((item) => item.attrs?.blockId === blockId);
    return (block?.content ?? []).map((item) => item.text ?? "").join("");
  } catch {
    return "";
  }
}

export function KnowledgeReviewView() {
  const client = useQueryClient();
  const chapters = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const chapterList = useMemo(() => (chapters.data ?? []).filter((node) => node.kind === "CHAPTER"), [chapters.data]);
  const [chapterId, setChapterId] = useState("");
  const selectedChapterId = chapterId || chapterList[0]?.id || "";
  const candidates = useQuery({
    queryKey: ["knowledge-candidates", selectedChapterId],
    queryFn: () => listKnowledgeCandidates(selectedChapterId),
    enabled: Boolean(selectedChapterId),
  });
  const conflicts = useQuery({
    queryKey: ["knowledge-conflicts", selectedChapterId],
    queryFn: () => detectCandidateConflicts(selectedChapterId),
    enabled: Boolean(selectedChapterId),
  });
  const anchors = useQuery({ queryKey: ["evidence-anchors"], queryFn: listEvidenceAnchors, enabled: Boolean(selectedChapterId) });
  const revisions = useQuery({
    queryKey: ["manuscript-history", selectedChapterId],
    queryFn: () => listManuscriptRevisions(selectedChapterId),
    enabled: Boolean(selectedChapterId),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approved = (candidates.data ?? []).filter((candidate) => candidate.candidateStatus === "APPROVED");

  async function decide(id: string, expectedStatus: CandidateStatus, decision: "APPROVE" | "REJECT") {
    setBusy(id);
    setError(null);
    try {
      await reviewKnowledgeCandidate({ id, expectedStatus, decision, reviewer: "desktop-user" });
      await client.invalidateQueries({ queryKey: ["knowledge-candidates", selectedChapterId] });
      await client.invalidateQueries({ queryKey: ["knowledge-conflicts", selectedChapterId] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function finalize() {
    if (!approved.length) return;
    setBusy("finalize");
    setError(null);
    try {
      await finalizeKnowledgeCandidates({ chapterId: selectedChapterId, candidateIds: approved.map((candidate) => candidate.id), actor: "desktop-user" });
      await client.invalidateQueries({ queryKey: ["knowledge-candidates", selectedChapterId] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="story-bible-view knowledge-review-view">
      <div className="workspace-heading">
        <p className="eyebrow">知识工作区</p>
        <h1>章节审核</h1>
        <p className="workspace-lede">逐条确认候选事实、查看冲突，并将已批准内容原子定稿。</p>
      </div>
      <KnowledgeSectionNav />
      <div className="story-bible-toolbar">
        <label>章节<select value={selectedChapterId} onChange={(event) => setChapterId(event.target.value)} disabled={!chapterList.length}>
          {!chapterList.length ? <option value="">暂无章节</option> : null}
          {chapterList.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
        </select></label>
        <button type="button" className="secondary-action" onClick={() => void candidates.refetch()} disabled={!selectedChapterId || candidates.isFetching}><RefreshCw size={14} />刷新</button>
        <button type="button" className="primary-action" onClick={() => void finalize()} disabled={!approved.length || busy !== null || Boolean(conflicts.data?.some((conflict) => conflict.highRisk))}><FileCheck2 size={14} />{busy === "finalize" ? "定稿中…" : `定稿 ${approved.length} 条`}</button>
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {conflicts.data?.length ? <section className="knowledge-conflict-panel" role="alert">
        <div className="knowledge-conflict-heading"><AlertTriangle size={16} /><div><strong>检测到 {conflicts.data.length} 项冲突</strong><span>{conflicts.data.some((conflict) => conflict.highRisk) ? "高风险冲突已阻断定稿，请先定位候选并处理。" : "请确认这些候选的表述是否准确，再决定是否定稿。"}</span></div></div>
        <div className="knowledge-conflict-list">{conflicts.data.map((conflict, index) => <article key={`${conflict.kind}-${conflict.subject}-${conflict.predicate}-${index}`}>
          <div><span className="entity-type-badge">{conflictKindLabels[conflict.kind]}</span><strong>{conflict.subject} · {conflict.predicate}</strong></div>
          <p>{conflict.objects.join(" / ")}</p>
          <div>{conflict.candidateIds.map((candidateId) => <a key={candidateId} href={`#candidate-${candidateId}`}>定位候选 {candidateId.slice(0, 8)}</a>)}</div>
        </article>)}</div>
      </section> : null}
      <div className="knowledge-review-list">
        {candidates.isPending ? <p className="plan-empty">正在加载候选…</p> : null}
        {!candidates.isPending && !candidates.data?.length ? <p className="plan-empty">本章节暂无候选事实。</p> : null}
        {candidates.data?.map((candidate) => {
          const evidence = candidate.fact.evidenceAnchorIds
            .map((id) => anchors.data?.find((anchor) => anchor.id === id))
            .filter((anchor): anchor is NonNullable<typeof anchor> => Boolean(anchor));
          return <article className="knowledge-candidate-row" id={`candidate-${candidate.id}`} key={candidate.id}>
            <div className="knowledge-candidate-main"><strong>{candidate.fact.subject} · {candidate.fact.predicate} · {candidate.fact.object}</strong><span>证据 {candidate.fact.evidenceAnchorIds.length} 条 · {candidateStatusLabels[candidate.candidateStatus]}</span></div>
            {evidence.length ? <details className="knowledge-candidate-evidence">
              <summary>查看原文证据<span>{evidence.length} 条</span></summary>
              <div>{evidence.map((anchor) => {
                const revision = revisions.data?.find((item) => item.id === anchor.sourceRevisionId);
                const snippet = revision ? extractBlockText(revision.documentJson, anchor.blockId) : "";
                return <blockquote key={anchor.id}>
                  <p>{snippet ? `${snippet.slice(0, 260)}${snippet.length > 260 ? "…" : ""}` : "原文版本已不可用，请根据来源版本复核。"}</p>
                  <footer><span>{anchor.sourceVersion}</span><code>{anchor.blockId}</code><a href={`/writing#${anchor.chapterId}`}>打开正文定位</a></footer>
                </blockquote>;
              })}</div>
            </details> : <p className="knowledge-candidate-no-evidence">这条候选没有可展示的证据锚点。</p>}
            {candidate.candidateStatus === "PENDING" || candidate.candidateStatus === "NEEDS_REVIEW" ? <div className="inspector-actions"><button type="button" className="secondary-action" onClick={() => void decide(candidate.id, candidate.candidateStatus, "REJECT")} disabled={busy !== null}><X size={14} />拒绝</button><button type="button" className="primary-action" onClick={() => void decide(candidate.id, candidate.candidateStatus, "APPROVE")} disabled={busy !== null}><Check size={14} />批准</button></div> : null}
          </article>;
        })}
      </div>
    </section>
  );
}
