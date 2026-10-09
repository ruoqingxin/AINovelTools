import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, Check, Clock3, FilePlus2, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  adoptExtractionItem,
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
import { manuscriptQuery } from "../lib/manuscript-query";
import { useCandidateEdits, useCandidateEditGuard } from "./use-candidate-edits";
import { manuscriptSourceHref } from "../lib/manuscript-source";
import { evidenceSourceRequest } from "./evidence-source";

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

export function ChapterExtractionPanel(props: { chapterId: string; active?: boolean; onPendingChange?: (pending: boolean) => void; onOpenFactReview?: () => void; onOpenManuscript?: () => void }) {
  const client = useQueryClient();
  const active = props.active !== false;
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles, enabled: active });
  const aiPreferences = useAiTaskPreferences(active);
  const revision = useQuery({ ...manuscriptQuery(props.chapterId), enabled: active && Boolean(props.chapterId) });
  const proposals = useQuery({
    queryKey: ["chapter-extractions", props.chapterId],
    queryFn: () => listChapterExtractions(props.chapterId),
    enabled: active && Boolean(props.chapterId),
  });
  const anchors = useQuery({
    queryKey: ["evidence-anchors"],
    queryFn: listEvidenceAnchors,
    enabled: active && Boolean(props.chapterId),
  });
  const facts = useQuery({
    queryKey: ["current-facts"],
    queryFn: listCurrentFacts,
    enabled: active && Boolean(props.chapterId),
  });
  const profile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "knowledgeExtraction");
  const preference = resolveTaskPreference(aiPreferences.data, "knowledgeExtraction");
  const [guidance, setGuidance] = useState("");
  const [guidanceBaseline, setGuidanceBaseline] = useState("");
  const edits = useCandidateEdits();
  const guidanceEdits = useCandidateEdits();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useCandidateEditGuard(edits.dirty || guidanceEdits.dirty, busy !== null, props.onPendingChange);

  function parsePayload(value: string) {
    const payload: unknown = JSON.parse(value);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("候选内容必须是 JSON 对象。");
    }
    return payload as Record<string, unknown>;
  }

  function itemDraft(item: ChapterExtractionItem) {
    const entry = edits.entries[item.id];
    return entry && (entry.value !== entry.baseline || busy === `save:${item.id}`)
      ? entry.value : JSON.stringify(item.payload, null, 2);
  }

  function setItemDraft(item: ChapterExtractionItem, value: string) {
    edits.edit(item.id, value, JSON.stringify(item.payload, null, 2));
  }

  function checkedPayload(item: ChapterExtractionItem) {
    const entry = edits.entries[item.id];
    if (entry && entry.value !== entry.baseline && entry.baseline !== JSON.stringify(item.payload, null, 2)) {
      throw new Error("候选已有新内容，本地修改仍保留。请复制需要保留的内容后，放弃修改并重新核对。");
    }
    return parsePayload(itemDraft(item));
  }

  function draftPayload(item: ChapterExtractionItem) {
    try {
      return parsePayload(itemDraft(item));
    } catch {
      return item.payload;
    }
  }

  function updateDraftField(item: ChapterExtractionItem, key: string, value: unknown) {
    try {
      const payload = { ...parsePayload(itemDraft(item)), [key]: value };
      setItemDraft(item, JSON.stringify(payload, null, 2));
    } catch {
      setError("JSON 格式无效，请先修正候选内容，再修改字段。");
    }
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
    const submittedGuidance = guidance;
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
      guidanceEdits.acknowledge("guidance", submittedGuidance);
      setGuidanceBaseline(submittedGuidance);
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
      const submitted = itemDraft(item);
      const payload = checkedPayload(item);
      const saved = await updateExtractionItem({ id: item.id, payload, expectedStatus: item.status });
      await client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] });
      edits.acknowledge(item.id, submitted, JSON.stringify(saved.payload, null, 2));
      setNotice("候选修改已保存。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function decide(item: ChapterExtractionItem, decision: "DEFERRED" | "REJECTED") {
    const changed = edits.entries[item.id]?.value !== edits.entries[item.id]?.baseline;
    if (decision === "REJECTED" && changed && !window.confirm("这条候选有未保存修改。拒绝将丢弃这些修改，确定继续吗？")) return;
    setBusy(`decide:${item.id}`);
    setError(null);
    try {
      if (decision === "DEFERRED" && changed) {
        const submitted = itemDraft(item);
        const saved = await updateExtractionItem({ id: item.id, payload: checkedPayload(item), expectedStatus: item.status });
        await client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] });
        edits.acknowledge(item.id, submitted, JSON.stringify(saved.payload, null, 2));
      }
      await decideExtractionItem({ id: item.id, expectedStatus: item.status, decision });
      edits.discard(item.id);
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
      const payload = checkedPayload(item);
      if (edits.entries[item.id] && edits.entries[item.id]!.value !== edits.entries[item.id]!.baseline) {
        const submitted = itemDraft(item);
        const saved = await updateExtractionItem({
          id: item.id,
          payload,
          expectedStatus: item.status,
        });
        await client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] });
        edits.acknowledge(item.id, submitted, JSON.stringify(saved.payload, null, 2));
      }
      const adopted = await adoptExtractionItem({ id: item.id, expectedStatus: item.status });
      edits.discard(item.id);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["chapter-extractions", props.chapterId] }),
        client.invalidateQueries({ queryKey: ["entities", false] }),
        client.invalidateQueries({ queryKey: ["knowledge-candidates", props.chapterId] }),
        client.invalidateQueries({ queryKey: ["foreshadowings"] }),
        client.invalidateQueries({ queryKey: ["relations"] }),
        client.invalidateQueries({ queryKey: ["events"] }),
        client.invalidateQueries({ queryKey: ["knowledge-conflicts", props.chapterId] }),
      ]);
      setNotice(item.kind === "FACT"
        ? "已转入本章事实审核，批准并定稿后才成为正式事实。"
        : item.kind === "ENTITY"
          ? "已创建实体修订，可在实体库继续调整。"
          : item.kind === "RELATION"
            ? `已创建关系记录 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`
            : item.kind === "EVENT"
              ? `已创建事件记录 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`
              : `已创建伏笔记录 ${adopted.finalObjectId?.slice(0, 8) ?? ""}。`);
      if (item.kind === "FACT") props.onOpenFactReview?.();
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
    <AiModelNote active={active} taskLabel="知识提取" taskKey="knowledgeExtraction" profile={profile} preference={preference} />
    <label className="chapter-extraction-guidance"><span>提取要求（可选）</span><textarea rows={2} value={guidance} onChange={(event) => { setGuidance(event.target.value); guidanceEdits.edit("guidance", event.target.value, guidanceBaseline); }} placeholder="例如：优先提取本批新增角色、地点和可验证事实，忽略重复描写" /></label>
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
        const entry = edits.entries[item.id];
        const dirty = Boolean(entry && entry.value !== entry.baseline);
        const locked = busy === `adopt:${item.id}` || busy === `decide:${item.id}`;
        return <article className="chapter-extraction-item" data-status={item.status.toLowerCase()} key={item.id}>
          <div className="chapter-extraction-item-heading">
            <div><span>{kindLabels[item.kind]}</span><strong>{itemTitle(item)}</strong></div>
            <small>{statusLabels[item.status]}</small>
          </div>
          <fieldset disabled={locked} className="chapter-extraction-edit-fields">
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
          <textarea rows={5} value={itemDraft(item)} readOnly={!editable} onChange={(event) => setItemDraft(item, event.target.value)} aria-label={`${itemTitle(item)} payload`} />
          </fieldset>
          {dirty ? <div className="inspector-actions candidate-edit-status"><span>{editable ? "候选修改未保存" : "候选状态已变化，本地修改仍保留"}</span><button type="button" className="secondary-action" disabled={busy !== null} onClick={() => {
            if (window.confirm("放弃这条候选的本地修改吗？")) edits.discard(item.id);
          }}>放弃修改</button></div> : null}
          <footer>
            <span>{anchor ? `${anchor.sourceVersion} · ${anchor.blockId}` : "证据待载入"}</span>
            {anchor ? <a href={manuscriptSourceHref(evidenceSourceRequest(anchor), `/writing?tab=extraction#${encodeURIComponent(props.chapterId)}`)}><BookOpenText size={14} />定位原文</a> : null}
            {props.onOpenManuscript
              ? <button type="button" className="secondary-action" onClick={props.onOpenManuscript}>查看已保存正文</button>
              : <a href={`/writing#${props.chapterId}`}>打开正文</a>}
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
