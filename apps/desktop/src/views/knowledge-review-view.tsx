import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileCheck2, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  detectCandidateConflicts,
  errorMessage,
  finalizeKnowledgeCandidates,
  listKnowledgeCandidates,
  listPlanNodes,
  reviewKnowledgeCandidate,
  type CandidateStatus,
} from "../lib/tauri-client";

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
      <div className="story-bible-toolbar">
        <label>章节<select value={selectedChapterId} onChange={(event) => setChapterId(event.target.value)} disabled={!chapterList.length}>
          {!chapterList.length ? <option value="">暂无章节</option> : null}
          {chapterList.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
        </select></label>
        <button type="button" className="secondary-action" onClick={() => void candidates.refetch()} disabled={!selectedChapterId || candidates.isFetching}><RefreshCw size={14} />刷新</button>
        <button type="button" className="primary-action" onClick={() => void finalize()} disabled={!approved.length || busy !== null || Boolean(conflicts.data?.some((conflict) => conflict.highRisk))}><FileCheck2 size={14} />{busy === "finalize" ? "定稿中…" : `定稿 ${approved.length} 条`}</button>
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {conflicts.data?.length ? <div className="knowledge-conflict-banner" role="alert"><AlertTriangle size={16} /><span>检测到 {conflicts.data.length} 项冲突{conflicts.data.some((conflict) => conflict.highRisk) ? "，高风险冲突已阻断定稿" : "。"}</span></div> : null}
      <div className="knowledge-review-list">
        {candidates.isPending ? <p className="plan-empty">正在加载候选…</p> : null}
        {!candidates.isPending && !candidates.data?.length ? <p className="plan-empty">本章节暂无候选事实。</p> : null}
        {candidates.data?.map((candidate) => (
          <article className="knowledge-candidate-row" key={candidate.id}>
            <div className="knowledge-candidate-main"><strong>{candidate.fact.subject} · {candidate.fact.predicate} · {candidate.fact.object}</strong><span>证据 {candidate.fact.evidenceAnchorIds.length} 条 · {candidate.candidateStatus}</span></div>
            {candidate.candidateStatus === "PENDING" || candidate.candidateStatus === "NEEDS_REVIEW" ? <div className="inspector-actions"><button type="button" className="secondary-action" onClick={() => void decide(candidate.id, candidate.candidateStatus, "REJECT")} disabled={busy !== null}><X size={14} />拒绝</button><button type="button" className="primary-action" onClick={() => void decide(candidate.id, candidate.candidateStatus, "APPROVE")} disabled={busy !== null}><Check size={14} />批准</button></div> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
