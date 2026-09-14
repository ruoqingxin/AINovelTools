import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, FilePlus2, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  adoptExtractionItem,
  currentManuscript,
  decideExtractionItem,
  errorMessage,
  extractChapterCandidates,
  listChapterExtractions,
  listEvidenceAnchors,
  listModelProfiles,
  updateExtractionItem,
  type ChapterExtractionItem,
  type ExtractionItemStatus,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";

const kindLabels = {
  ENTITY: "实体",
  FACT: "事实",
  RELATION: "关系",
  EVENT: "事件",
  FORESHADOWING: "伏笔",
} as const;

const statusLabels: Record<ExtractionItemStatus, string> = {
  PENDING_REVIEW: "待审核",
  ACCEPTED: "已采用",
  DEFERRED: "已延期",
  REJECTED: "已拒绝",
};

function itemTitle(item: ChapterExtractionItem) {
  const name = item.payload.name;
  if (typeof name === "string" && name.trim()) return name;
  const subject = item.payload.subject;
  const predicate = item.payload.predicate;
  const object = item.payload.object;
  if (typeof subject === "string" && typeof predicate === "string" && typeof object === "string") {
    return `${subject} · ${predicate} · ${object}`;
  }
  const title = item.payload.title;
  return typeof title === "string" && title.trim() ? title : "未命名候选";
}

export function ChapterExtractionPanel(props: { chapterId: string }) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const revision = useQuery({
    queryKey: ["current-manuscript", props.chapterId],
    queryFn: () => currentManuscript(props.chapterId),
    enabled: Boolean(props.chapterId),
  });
  const proposals = useQuery({
    queryKey: ["chapter-extractions", props.chapterId],
    queryFn: () => listChapterExtractions(props.chapterId),
    enabled: Boolean(props.chapterId),
  });
  const anchors = useQuery({
    queryKey: ["evidence-anchors"],
    queryFn: listEvidenceAnchors,
    enabled: Boolean(props.chapterId),
  });
  const profile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "knowledgeExtraction");
  const preference = resolveTaskPreference(aiPreferences.data, "knowledgeExtraction");
  const [guidance, setGuidance] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function extract() {
    if (!profile || !revision.data) {
      setError("请先保存正文修订，并配置可用的知识提取模型。");
      return;
    }
    setBusy("extract");
    setError(null);
    setNotice(null);
    try {
      await extractChapterCandidates({
        profileId: profile.id,
        chapterId: props.chapterId,
        sourceRevisionId: revision.data.id,
        ...(guidance.trim() ? { userGuidance: guidance.trim() } : {}),
        ...(preference.temperature !== null ? { temperature: preference.temperature } : {}),
        ...(preference.maxOutputTokens !== null ? { maxOutputTokens: preference.maxOutputTokens } : {}),
      });
      await client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] });
      await client.invalidateQueries({ queryKey: ["evidence-anchors"] });
      setNotice("本章候选已提取并绑定正文证据，确认前不会写入正式知识。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function saveItem(item: ChapterExtractionItem) {
    setBusy(`save:${item.id}`);
    setError(null);
    try {
      const payload = JSON.parse(drafts[item.id] ?? JSON.stringify(item.payload)) as Record<string, unknown>;
      await updateExtractionItem({ id: item.id, payload, expectedStatus: item.status });
      await client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] });
      setNotice("候选修改已保存。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function decide(item: ChapterExtractionItem, decision: "DEFERRED" | "REJECTED") {
    setBusy(`decide:${item.id}`);
    setError(null);
    try {
      await decideExtractionItem({ id: item.id, expectedStatus: item.status, decision });
      await client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] });
      setNotice(decision === "DEFERRED" ? "候选已延期。" : "候选已拒绝。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function adopt(item: ChapterExtractionItem) {
    setBusy(`adopt:${item.id}`);
    setError(null);
    try {
      const adopted = await adoptExtractionItem({ id: item.id, expectedStatus: item.status });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] }),
        client.invalidateQueries({ queryKey: ["entities", false] }),
        client.invalidateQueries({ queryKey: ["knowledge-candidates", props.chapterId] }),
        client.invalidateQueries({ queryKey: ["foreshadowings"] }),
      ]);
      setNotice(item.kind === "FACT"
        ? "已转入章节审核候选，仍需批准并在知识审核页定稿。"
        : item.kind === "ENTITY"
          ? "已创建实体修订，可在实体库继续调整。"
          : `已采用候选 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const items = proposals.data?.flatMap((proposal) => proposal.items) ?? [];
  return <section className="chapter-extraction-panel" aria-label="本章候选提取">
    <div className="section-heading">
      <h3><FilePlus2 size={14} />本章候选提取</h3>
      <span>{revision.data ? `基于修订 ${revision.data.id.slice(0, 8)}` : "尚无正文修订"}</span>
    </div>
    <AiModelNote taskLabel="知识提取" taskKey="knowledgeExtraction" profile={profile} preference={preference} />
    <label className="chapter-extraction-guidance"><span>提取要求（可选）</span><textarea rows={2} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="例如：优先提取本批新增角色、地点和可验证事实，忽略重复描写" /></label>
    <div className="chapter-extraction-actions">
      <span>候选保留正文块、修订和原文哈希；只在作者采用后进入后续正式流程。</span>
      <button type="button" className="primary-action" onClick={() => void extract()} disabled={!profile?.hasSecret || !revision.data || busy !== null}>
        {busy === "extract" ? <LoaderCircle size={14} className="spin" /> : <FilePlus2 size={14} />}
        {busy === "extract" ? "提取中…" : "提取本章候选"}
      </button>
      <button type="button" className="secondary-action" onClick={() => void proposals.refetch()} disabled={proposals.isFetching}><RefreshCw size={13} />刷新</button>
    </div>
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {!items.length && !proposals.isPending ? <p className="plan-empty">还没有提取候选。保存正文修订后可手动发起。</p> : null}
    <div className="chapter-extraction-list">
      {items.map((item) => {
        const anchor = anchors.data?.find((candidate) => candidate.id === item.evidenceAnchorId);
        const editable = item.status === "PENDING_REVIEW" || item.status === "DEFERRED";
        return <article className="chapter-extraction-item" data-status={item.status.toLowerCase()} key={item.id}>
          <div className="chapter-extraction-item-heading">
            <div><span>{kindLabels[item.kind]}</span><strong>{itemTitle(item)}</strong></div>
            <small>{statusLabels[item.status]}</small>
          </div>
          <textarea rows={5} value={drafts[item.id] ?? JSON.stringify(item.payload, null, 2)} readOnly={!editable} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} aria-label={`${itemTitle(item)} payload`} />
          <footer>
            <span>{anchor ? `${anchor.sourceVersion} · ${anchor.blockId}` : "证据待载入"}</span>
            <a href={`/writing#${props.chapterId}`}>打开正文</a>
            {item.finalObjectId ? <code>{item.finalObjectId.slice(0, 8)}</code> : null}
          </footer>
          {editable ? <div className="inspector-actions">
            <button type="button" className="secondary-action" onClick={() => void saveItem(item)} disabled={busy !== null}><Save size={13} />保存修改</button>
            <button type="button" className="secondary-action" onClick={() => void decide(item, "DEFERRED")} disabled={busy !== null}><Clock3 size={13} />延期</button>
            <button type="button" className="secondary-action destructive-action" onClick={() => void decide(item, "REJECTED")} disabled={busy !== null}><X size={13} />拒绝</button>
            <button type="button" className="primary-action" onClick={() => void adopt(item)} disabled={busy !== null}><Check size={13} />采用</button>
          </div> : null}
        </article>;
      })}
    </div>
  </section>;
}
