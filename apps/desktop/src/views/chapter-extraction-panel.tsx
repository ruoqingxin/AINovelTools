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
  listCurrentFacts,
  listEvidenceAnchors,
  listModelProfiles,
  updateExtractionItem,
  type ChapterExtractionItem,
  type ExtractionItemStatus,
  type Fact,
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
  const fromHint = item.payload.fromHint;
  const toHint = item.payload.toHint;
  const relationType = item.payload.relationType;
  if (typeof fromHint === "string" && typeof toHint === "string" && typeof relationType === "string") {
    return `${fromHint} · ${relationType} · ${toHint}`;
  }
  const title = item.payload.title;
  return typeof title === "string" && title.trim() ? title : "未命名候选";
}

function factLabel(fact: Fact) {
  return `${fact.subject} · ${fact.predicate} · ${fact.object}`;
}

function stringValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function uuidValues(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
  const facts = useQuery({
    queryKey: ["current-facts"],
    queryFn: listCurrentFacts,
    enabled: Boolean(props.chapterId),
  });
  const profile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "knowledgeExtraction");
  const preference = resolveTaskPreference(aiPreferences.data, "knowledgeExtraction");
  const [guidance, setGuidance] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function draftPayload(item: ChapterExtractionItem) {
    const draft = drafts[item.id];
    if (!draft) return item.payload;
    try {
      const value = JSON.parse(draft) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : item.payload;
    } catch {
      return item.payload;
    }
  }

  function updateDraftField(item: ChapterExtractionItem, key: string, value: unknown) {
    const payload = { ...draftPayload(item), [key]: value };
    setDrafts((current) => ({ ...current, [item.id]: JSON.stringify(payload, null, 2) }));
  }

  function canAdopt(item: ChapterExtractionItem) {
    if (item.kind === "RELATION") {
      const payload = draftPayload(item);
      return Boolean(
        stringValue(payload, "fromKnowledgeId")
        && stringValue(payload, "toKnowledgeId")
        && stringValue(payload, "relationType").trim(),
      );
    }
    if (item.kind === "EVENT") {
      const payload = draftPayload(item);
      return Boolean(stringValue(payload, "name").trim() && stringValue(payload, "occurredAt").trim());
    }
    return true;
  }

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
      if (drafts[item.id]) {
        await updateExtractionItem({
          id: item.id,
          payload: draftPayload(item),
          expectedStatus: item.status,
        });
      }
      const adopted = await adoptExtractionItem({ id: item.id, expectedStatus: item.status });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] }),
        client.invalidateQueries({ queryKey: ["entities", false] }),
        client.invalidateQueries({ queryKey: ["knowledge-candidates", props.chapterId] }),
        client.invalidateQueries({ queryKey: ["foreshadowings"] }),
        client.invalidateQueries({ queryKey: ["relations"] }),
        client.invalidateQueries({ queryKey: ["events"] }),
      ]);
      setNotice(item.kind === "FACT"
        ? "已转入正文事实审核，仍需批准并在审核页定稿。"
        : item.kind === "ENTITY"
          ? "已创建实体修订，可在实体库继续调整。"
          : item.kind === "RELATION"
            ? `已创建关系记录 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`
            : item.kind === "EVENT"
              ? `已创建事件记录 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`
              : `已创建伏笔记录 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`);
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
        const payload = draftPayload(item);
        return <article className="chapter-extraction-item" data-status={item.status.toLowerCase()} key={item.id}>
          <div className="chapter-extraction-item-heading">
            <div><span>{kindLabels[item.kind]}</span><strong>{itemTitle(item)}</strong></div>
            <small>{statusLabels[item.status]}</small>
          </div>
          {editable && item.kind === "RELATION" ? <div className="chapter-extraction-fields">
            <label><span>起点事实</span><select aria-label={`${itemTitle(item)}起点事实`} value={stringValue(payload, "fromKnowledgeId")} onChange={(event) => updateDraftField(item, "fromKnowledgeId", event.target.value)}><option value="">选择当前事实</option>{(facts.data ?? []).map((fact) => <option key={fact.knowledgeId} value={fact.knowledgeId}>{factLabel(fact)}</option>)}</select></label>
            <label><span>终点事实</span><select aria-label={`${itemTitle(item)}终点事实`} value={stringValue(payload, "toKnowledgeId")} onChange={(event) => updateDraftField(item, "toKnowledgeId", event.target.value)}><option value="">选择当前事实</option>{(facts.data ?? []).map((fact) => <option key={fact.knowledgeId} value={fact.knowledgeId}>{factLabel(fact)}</option>)}</select></label>
            <label><span>关系类型</span><input aria-label={`${itemTitle(item)}关系类型`} value={stringValue(payload, "relationType")} onChange={(event) => updateDraftField(item, "relationType", event.target.value)} placeholder="例如：师徒、敌对、隶属" /></label>
            {stringValue(payload, "fromHint") || stringValue(payload, "toHint") ? <p>原文线索：{stringValue(payload, "fromHint") || "未注明"} → {stringValue(payload, "toHint") || "未注明"}</p> : null}
          </div> : null}
          {editable && item.kind === "EVENT" ? <div className="chapter-extraction-fields">
            <label><span>事件名称</span><input aria-label={`${itemTitle(item)}事件名称`} value={stringValue(payload, "name")} onChange={(event) => updateDraftField(item, "name", event.target.value)} placeholder="例如：初入北境" /></label>
            <label><span>发生时间</span><input aria-label={`${itemTitle(item)}发生时间`} value={stringValue(payload, "occurredAt")} onChange={(event) => updateDraftField(item, "occurredAt", event.target.value)} placeholder="例如：第三日清晨 / 原文未注明" /></label>
            <fieldset><legend>参与事实（可选）</legend>{(facts.data ?? []).map((fact) => <label key={fact.knowledgeId}><input type="checkbox" checked={uuidValues(payload, "participantFactIds").includes(fact.knowledgeId)} onChange={() => updateDraftField(item, "participantFactIds", uuidValues(payload, "participantFactIds").includes(fact.knowledgeId) ? uuidValues(payload, "participantFactIds").filter((id) => id !== fact.knowledgeId) : [...uuidValues(payload, "participantFactIds"), fact.knowledgeId])} />{factLabel(fact)}</label>)}</fieldset>
          </div> : null}
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
            <button type="button" className="primary-action" onClick={() => void adopt(item)} disabled={busy !== null || !canAdopt(item)}><Check size={13} />采用</button>
          </div> : null}
        </article>;
      })}
    </div>
  </section>;
}
