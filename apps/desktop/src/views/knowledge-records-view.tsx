import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Link2, Milestone, Pencil, Plus, Save, Sparkles, UserRoundCheck } from "lucide-react";
import { useMemo, useState } from "react";
import {
  createBelief,
  createEvent,
  createForeshadowing,
  createRelation,
  errorMessage,
  getCurrentProject,
  listBeliefs,
  listCurrentFacts,
  listEvents,
  listEvidenceAnchors,
  listForeshadowings,
  listPlanNodes,
  listRelations,
  type KnowledgeLifecycleStatus,
  updateBelief,
  updateEvent,
  updateForeshadowing,
  updateRelation,
} from "../lib/tauri-client";

type RecordTab = "relations" | "events" | "beliefs" | "foreshadowings";

const tabs: Array<{ id: RecordTab; label: string; icon: typeof Link2 }> = [
  { id: "relations", label: "关系", icon: Link2 },
  { id: "events", label: "事件", icon: Milestone },
  { id: "beliefs", label: "信念", icon: UserRoundCheck },
  { id: "foreshadowings", label: "伏笔", icon: Sparkles },
];

export function KnowledgeRecordsView() {
  const client = useQueryClient();
  const [tab, setTab] = useState<RecordTab>("relations");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lifecycleFilter, setLifecycleFilter] = useState<"ALL" | KnowledgeLifecycleStatus>("ALL");
  const [lifecycleStatus, setLifecycleStatus] = useState<KnowledgeLifecycleStatus>("ACTIVE");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [relation, setRelation] = useState({ fromKnowledgeId: "", toKnowledgeId: "", relationType: "" });
  const [event, setEvent] = useState({ name: "", occurredAt: "", participantFactIds: [] as string[] });
  const [belief, setBelief] = useState({ holderKnowledgeId: "", proposition: "" });
  const [foreshadowing, setForeshadowing] = useState({ title: "", targetChapterId: "", status: "PLANTED" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const facts = useQuery({ queryKey: ["current-facts"], queryFn: listCurrentFacts, enabled: Boolean(project.data) });
  const anchors = useQuery({ queryKey: ["evidence-anchors"], queryFn: listEvidenceAnchors, enabled: Boolean(project.data) });
  const chapters = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes, enabled: Boolean(project.data) });
  const relations = useQuery({ queryKey: ["relations"], queryFn: listRelations });
  const events = useQuery({ queryKey: ["events"], queryFn: listEvents });
  const beliefs = useQuery({ queryKey: ["beliefs"], queryFn: listBeliefs });
  const foreshadowings = useQuery({ queryKey: ["foreshadowings"], queryFn: listForeshadowings });
  const query = { relations, events, beliefs, foreshadowings }[tab];
  const chapterList = useMemo(() => (chapters.data ?? []).filter((item) => item.kind === "CHAPTER"), [chapters.data]);
  const factLabels = useMemo(
    () => new Map((facts.data ?? []).map((item) => [item.knowledgeId, `${item.subject} · ${item.predicate} · ${item.object}`])),
    [facts.data],
  );
  const activeRecord = useMemo(() => {
    if (!selectedId) return null;
    if (tab === "relations") return (relations.data ?? []).find((item) => item.id === selectedId) ?? null;
    if (tab === "events") return (events.data ?? []).find((item) => item.id === selectedId) ?? null;
    if (tab === "beliefs") return (beliefs.data ?? []).find((item) => item.id === selectedId) ?? null;
    return (foreshadowings.data ?? []).find((item) => item.id === selectedId) ?? null;
  }, [beliefs.data, events.data, foreshadowings.data, relations.data, selectedId, tab]);
  const activeVersion = activeRecord
    ? "relationVersion" in activeRecord
      ? activeRecord.relationVersion
      : "eventVersion" in activeRecord
        ? activeRecord.eventVersion
        : "beliefVersion" in activeRecord
          ? activeRecord.beliefVersion
          : activeRecord.foreshadowingVersion
    : 0;
  const content = useMemo(() => {
    if (tab === "relations") return (relations.data ?? []).map((item) => ({ id: item.id, title: item.relationType, detail: `${factLabels.get(item.fromKnowledgeId) ?? item.fromKnowledgeId} -> ${factLabels.get(item.toKnowledgeId) ?? item.toKnowledgeId}`, status: item.lifecycleStatus, evidence: item.evidenceAnchorIds.length, version: item.relationVersion }));
    if (tab === "events") return (events.data ?? []).map((item) => ({ id: item.id, title: item.name, detail: item.occurredAt, status: item.lifecycleStatus, evidence: item.evidenceAnchorIds.length, version: item.eventVersion }));
    if (tab === "beliefs") return (beliefs.data ?? []).map((item) => ({ id: item.id, title: item.proposition, detail: `持有者 ${factLabels.get(item.holderKnowledgeId) ?? item.holderKnowledgeId}`, status: item.lifecycleStatus, evidence: item.evidenceAnchorIds.length, version: item.beliefVersion }));
    return (foreshadowings.data ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.targetChapterId ? `目标章节 ${chapterList.find((chapter) => chapter.id === item.targetChapterId)?.title ?? item.targetChapterId}` : "尚未指定目标章节", status: `${item.lifecycleStatus} · ${item.status}`, evidence: item.evidenceAnchorIds.length, version: item.foreshadowingVersion }));
  }, [beliefs.data, chapterList, events.data, factLabels, foreshadowings.data, relations.data, tab]).filter((item) => lifecycleFilter === "ALL" || item.status === lifecycleFilter || item.status.startsWith(`${lifecycleFilter} ·`));

  function toggle(values: string[], id: string, update: (next: string[]) => void) {
    update(values.includes(id) ? values.filter((item) => item !== id) : [...values, id]);
  }

  function canSave() {
    if (!project.data || !evidenceIds.length || busy) return false;
    if (tab === "relations") return Boolean(relation.fromKnowledgeId && relation.toKnowledgeId && relation.fromKnowledgeId !== relation.toKnowledgeId && relation.relationType.trim());
    if (tab === "events") return Boolean(event.name.trim() && event.occurredAt);
    if (tab === "beliefs") return Boolean(belief.holderKnowledgeId && belief.proposition.trim());
    return Boolean(foreshadowing.title.trim() && foreshadowing.status.trim());
  }

  function startNew() {
    setSelectedId(null);
    setLifecycleStatus("ACTIVE");
    setEvidenceIds([]);
    setRelation({ fromKnowledgeId: "", toKnowledgeId: "", relationType: "" });
    setEvent({ name: "", occurredAt: "", participantFactIds: [] });
    setBelief({ holderKnowledgeId: "", proposition: "" });
    setForeshadowing({ title: "", targetChapterId: "", status: "PLANTED" });
    setError(null);
    setNotice(null);
  }

  function startEdit(id: string) {
    const relationRecord = (relations.data ?? []).find((item) => item.id === id);
    const eventRecord = (events.data ?? []).find((item) => item.id === id);
    const beliefRecord = (beliefs.data ?? []).find((item) => item.id === id);
    const foreshadowingRecord = (foreshadowings.data ?? []).find((item) => item.id === id);
    if (tab === "relations" && relationRecord) {
      setRelation({ fromKnowledgeId: relationRecord.fromKnowledgeId, toKnowledgeId: relationRecord.toKnowledgeId, relationType: relationRecord.relationType });
      setEvidenceIds(relationRecord.evidenceAnchorIds);
      setLifecycleStatus(relationRecord.lifecycleStatus);
    } else if (tab === "events" && eventRecord) {
      setEvent({ name: eventRecord.name, occurredAt: eventRecord.occurredAt, participantFactIds: eventRecord.participantFactIds });
      setEvidenceIds(eventRecord.evidenceAnchorIds);
      setLifecycleStatus(eventRecord.lifecycleStatus);
    } else if (tab === "beliefs" && beliefRecord) {
      setBelief({ holderKnowledgeId: beliefRecord.holderKnowledgeId, proposition: beliefRecord.proposition });
      setEvidenceIds(beliefRecord.evidenceAnchorIds);
      setLifecycleStatus(beliefRecord.lifecycleStatus);
    } else if (tab === "foreshadowings" && foreshadowingRecord) {
      setForeshadowing({ title: foreshadowingRecord.title, targetChapterId: foreshadowingRecord.targetChapterId ?? "", status: foreshadowingRecord.status });
      setEvidenceIds(foreshadowingRecord.evidenceAnchorIds);
      setLifecycleStatus(foreshadowingRecord.lifecycleStatus);
    }
    setSelectedId(id);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!project.data || !canSave()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const common = {
      id: selectedId ?? crypto.randomUUID(),
      projectId: project.data.projectId,
      evidenceAnchorIds: evidenceIds,
      lifecycleStatus,
      createdBy: "desktop-user",
      createdAt: "",
      updatedAt: "",
    };
    try {
      if (tab === "relations") {
        const value = { ...common, relationVersion: activeVersion + 1, fromKnowledgeId: relation.fromKnowledgeId, toKnowledgeId: relation.toKnowledgeId, relationType: relation.relationType.trim() };
        if (activeRecord) await updateRelation(value, activeVersion); else await createRelation(value);
        setRelation({ fromKnowledgeId: "", toKnowledgeId: "", relationType: "" });
      } else if (tab === "events") {
        const value = { ...common, eventVersion: activeVersion + 1, name: event.name.trim(), occurredAt: event.occurredAt, participantFactIds: event.participantFactIds };
        if (activeRecord) await updateEvent(value, activeVersion); else await createEvent(value);
        setEvent({ name: "", occurredAt: "", participantFactIds: [] });
      } else if (tab === "beliefs") {
        const value = { ...common, beliefVersion: activeVersion + 1, holderKnowledgeId: belief.holderKnowledgeId, proposition: belief.proposition.trim() };
        if (activeRecord) await updateBelief(value, activeVersion); else await createBelief(value);
        setBelief({ holderKnowledgeId: "", proposition: "" });
      } else {
        const value = { ...common, foreshadowingVersion: activeVersion + 1, title: foreshadowing.title.trim(), targetChapterId: foreshadowing.targetChapterId || null, status: foreshadowing.status.trim() };
        if (activeRecord) await updateForeshadowing(value, activeVersion); else await createForeshadowing(value);
        setForeshadowing({ title: "", targetChapterId: "", status: "PLANTED" });
      }
      setEvidenceIds([]);
      setSelectedId(null);
      await client.invalidateQueries({ queryKey: [tab] });
      setNotice(activeRecord ? `已追加为 v${activeVersion + 1}` : `已创建${tabs.find((item) => item.id === tab)?.label}记录`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="story-bible-view knowledge-records-view">
      <div className="workspace-heading">
        <p className="eyebrow">知识工作区</p>
        <h1>知识记录</h1>
        <p className="workspace-lede">创建并查看关系、事件、信念和伏笔；每条记录保留独立版本与证据锚点。</p>
      </div>
      <div className="knowledge-record-tabs" role="tablist" aria-label="知识记录类型">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={tab === id} data-active={tab === id || undefined} onClick={() => { setTab(id); startNew(); }}><Icon size={15} />{label}</button>)}
      </div>
      <div className="story-bible-toolbar knowledge-record-filter">
        <select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value as "ALL" | KnowledgeLifecycleStatus)} aria-label="审核状态筛选">
          <option value="ALL">全部审核状态</option>
          <option value="ACTIVE">有效</option>
          <option value="NEEDS_REVIEW">待复核</option>
          <option value="ARCHIVED">已归档</option>
        </select>
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {notice ? <p className="project-notice" role="status">{notice}</p> : null}

      <div className="knowledge-record-workbench">
        <form className="knowledge-record-form" onSubmit={(form) => { form.preventDefault(); void save(); }}>
          <div className="section-heading"><h2>{activeRecord ? `编辑${tabs.find((item) => item.id === tab)?.label}记录` : `新建${tabs.find((item) => item.id === tab)?.label}记录`}</h2><span>{activeRecord ? `当前 v${activeVersion}` : `${evidenceIds.length} 条证据`}</span></div>
          {tab === "relations" ? <div className="entity-form-grid">
            <label>起点事实<select value={relation.fromKnowledgeId} onChange={(item) => setRelation((current) => ({ ...current, fromKnowledgeId: item.target.value }))}><option value="">选择当前事实</option>{(facts.data ?? []).map((item) => <option key={item.knowledgeId} value={item.knowledgeId}>{factLabels.get(item.knowledgeId)}</option>)}</select></label>
            <label>终点事实<select value={relation.toKnowledgeId} onChange={(item) => setRelation((current) => ({ ...current, toKnowledgeId: item.target.value }))}><option value="">选择当前事实</option>{(facts.data ?? []).map((item) => <option key={item.knowledgeId} value={item.knowledgeId}>{factLabels.get(item.knowledgeId)}</option>)}</select></label>
            <label className="entity-form-wide">关系类型<input value={relation.relationType} onChange={(item) => setRelation((current) => ({ ...current, relationType: item.target.value }))} placeholder="例如：师徒、敌对、隶属" /></label>
          </div> : null}
          {tab === "events" ? <div className="entity-form-grid">
            <label>事件名称<input value={event.name} onChange={(item) => setEvent((current) => ({ ...current, name: item.target.value }))} placeholder="例如：初入北境" /></label>
            <label>发生时间<input type="datetime-local" value={event.occurredAt} onChange={(item) => setEvent((current) => ({ ...current, occurredAt: item.target.value }))} /></label>
            <fieldset className="knowledge-select-list entity-form-wide"><legend>关联事实（可选）</legend>{(facts.data ?? []).map((item) => <label key={item.knowledgeId}><input type="checkbox" checked={event.participantFactIds.includes(item.knowledgeId)} onChange={() => toggle(event.participantFactIds, item.knowledgeId, (participantFactIds) => setEvent((current) => ({ ...current, participantFactIds })))} />{factLabels.get(item.knowledgeId)}</label>)}</fieldset>
          </div> : null}
          {tab === "beliefs" ? <div className="entity-form-grid">
            <label>持有者事实<select value={belief.holderKnowledgeId} onChange={(item) => setBelief((current) => ({ ...current, holderKnowledgeId: item.target.value }))}><option value="">选择当前事实</option>{(facts.data ?? []).map((item) => <option key={item.knowledgeId} value={item.knowledgeId}>{factLabels.get(item.knowledgeId)}</option>)}</select></label>
            <label>命题<input value={belief.proposition} onChange={(item) => setBelief((current) => ({ ...current, proposition: item.target.value }))} placeholder="例如：相信北境无路可通" /></label>
          </div> : null}
          {tab === "foreshadowings" ? <div className="entity-form-grid">
            <label>标题<input value={foreshadowing.title} onChange={(item) => setForeshadowing((current) => ({ ...current, title: item.target.value }))} placeholder="例如：旧钥匙的来历" /></label>
            <label>状态<select value={foreshadowing.status} onChange={(item) => setForeshadowing((current) => ({ ...current, status: item.target.value }))}><option value="PLANTED">已埋设</option><option value="ADVANCING">推进中</option><option value="RESOLVED">已回收</option></select></label>
            <label className="entity-form-wide">目标章节（可选）<select value={foreshadowing.targetChapterId} onChange={(item) => setForeshadowing((current) => ({ ...current, targetChapterId: item.target.value }))}><option value="">尚未指定</option>{chapterList.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          </div> : null}
          <div className="entity-form-grid">
            <label>审核状态<select value={lifecycleStatus} onChange={(event) => setLifecycleStatus(event.target.value as KnowledgeLifecycleStatus)}>
              <option value="ACTIVE">有效</option>
              <option value="NEEDS_REVIEW">退回复核</option>
              <option value="ARCHIVED">归档</option>
            </select></label>
          </div>
          <fieldset className="knowledge-select-list"><legend>证据锚点</legend>{anchors.isPending ? <span>正在加载证据…</span> : null}{!anchors.isPending && !(anchors.data ?? []).length ? <span>尚无证据锚点，请先在章节审核流程中建立证据。</span> : null}{(anchors.data ?? []).map((item) => <label key={item.id}><input type="checkbox" checked={evidenceIds.includes(item.id)} onChange={() => toggle(evidenceIds, item.id, setEvidenceIds)} />章节 {item.chapterId.slice(0, 8)} · 区块 {item.blockId}</label>)}</fieldset>
          <div className="inspector-actions"><button type="submit" className="primary-action" disabled={!canSave()}><Save size={15} />{busy ? "保存中…" : activeRecord ? `保存为 v${activeVersion + 1}` : `创建${tabs.find((item) => item.id === tab)?.label}`}</button>{activeRecord ? <button type="button" className="secondary-action" onClick={startNew} disabled={busy}><Plus size={15} />新建记录</button> : null}</div>
        </form>

        <div className="knowledge-record-list">
          {query.isError ? <p className="project-error" role="alert">无法加载记录：{errorMessage(query.error)}</p> : null}
          {query.isPending ? <p className="plan-empty">正在加载记录…</p> : null}
          {!query.isPending && !content.length ? <p className="plan-empty">暂无已创建的{tabs.find((item) => item.id === tab)?.label}记录。</p> : null}
          {content.map((item) => <article className="knowledge-record-row" key={item.id}><div><strong>{item.title}</strong><span>{item.detail}</span></div><div><span className="entity-type-badge">v{item.version} · {item.status}</span><span className="knowledge-evidence"><BookMarked size={13} />{item.evidence}</span><button type="button" className="icon-command" aria-label={`编辑${item.title}`} title="编辑并追加新版本" onClick={() => startEdit(item.id)}><Pencil size={14} /></button></div></article>)}
        </div>
      </div>
    </section>
  );
}
