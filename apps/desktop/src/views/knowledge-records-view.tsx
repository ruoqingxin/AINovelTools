import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Milestone, Pencil, Plus, Save, Sparkles, UserRoundCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { manuscriptSourceHref } from "../lib/manuscript-source";
import "./library-workspace.css";
import { SearchField } from "./search-field";
import { recordTypeLabels } from "../lib/content-taxonomy";
import { AiWorkspaceLink, ContentTypeLabel, useInAiWorkspace } from "./content-identity";

type RecordTab = "relations" | "events" | "beliefs" | "foreshadowings";

const tabs: Array<{ id: RecordTab; label: string; icon: typeof Link2 }> = [
  { id: "relations", label: "关系", icon: Link2 },
  { id: "events", label: "事件", icon: Milestone },
  { id: "beliefs", label: recordTypeLabels.beliefs, icon: UserRoundCheck },
  { id: "foreshadowings", label: "伏笔", icon: Sparkles },
];

export function KnowledgeRecordsView() {
  const aiWorkspace = useInAiWorkspace();
  const searchParams = new URLSearchParams(window.location.search);
  const client = useQueryClient();
  const [tab, setTab] = useState<RecordTab>(() => tabs.some((item) => item.id === searchParams.get("tab")) ? searchParams.get("tab") as RecordTab : "relations");
  const [selectedId, setSelectedId] = useState<string | null>(() => aiWorkspace ? searchParams.get("objectId") : null);
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [search, setSearch] = useState("");
  const inFlight = useRef(false);
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
  }, [beliefs.data, chapterList, events.data, factLabels, foreshadowings.data, relations.data, tab]);
  const visibleRecords = content.filter((item) => (lifecycleFilter === "ALL" || item.status === lifecycleFilter || item.status.startsWith(`${lifecycleFilter} ·`))
    && `${item.title} ${item.detail}`.toLowerCase().includes(search.trim().toLowerCase()));
  const draftSignature = JSON.stringify({ fields: { relations: relation, events: event, beliefs: belief, foreshadowings: foreshadowing }[tab], evidenceIds, lifecycleStatus });
  const [baseline, setBaseline] = useState(draftSignature);
  const recordDirty = editing && draftSignature !== baseline;
  useUnsavedChangesGuard(recordDirty || busy, "当前剧情记录有未保存内容或正在保存。");
  function mayLeave() { return !inFlight.current && (!recordDirty || window.confirm("当前剧情记录有未保存内容，确定放弃吗？")); }

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

  function reset(nextTab = tab) {
    setSelectedId(null);
    setLifecycleStatus("ACTIVE");
    setEvidenceIds([]);
    setRelation({ fromKnowledgeId: "", toKnowledgeId: "", relationType: "" });
    setEvent({ name: "", occurredAt: "", participantFactIds: [] });
    setBelief({ holderKnowledgeId: "", proposition: "" });
    setForeshadowing({ title: "", targetChapterId: "", status: "PLANTED" });
    setError(null);
    setNotice(null);
    setEditVersion(0);
    setBaseline(JSON.stringify({ fields: {
      relations: { fromKnowledgeId: "", toKnowledgeId: "", relationType: "" },
      events: { name: "", occurredAt: "", participantFactIds: [] },
      beliefs: { holderKnowledgeId: "", proposition: "" },
      foreshadowings: { title: "", targetChapterId: "", status: "PLANTED" },
    }[nextTab], evidenceIds: [], lifecycleStatus: "ACTIVE" }));
  }
  function startNew() {
    if (!mayLeave()) return;
    reset(); setEditing(true);
  }

  function switchTab(nextTab: RecordTab) {
    if (nextTab === tab) return;
    if (!mayLeave()) return;
    setTab(nextTab);
    reset(nextTab); setEditing(false); setSearch("");
  }

  function startEdit(id: string) {
    if (!mayLeave()) return;
    const relationRecord = (relations.data ?? []).find((item) => item.id === id);
    const eventRecord = (events.data ?? []).find((item) => item.id === id);
    const beliefRecord = (beliefs.data ?? []).find((item) => item.id === id);
    const foreshadowingRecord = (foreshadowings.data ?? []).find((item) => item.id === id);
    if (tab === "relations" && relationRecord) {
      const fields = { fromKnowledgeId: relationRecord.fromKnowledgeId, toKnowledgeId: relationRecord.toKnowledgeId, relationType: relationRecord.relationType };
      setRelation(fields);
      setEditVersion(relationRecord.relationVersion);
      setBaseline(JSON.stringify({ fields, evidenceIds: relationRecord.evidenceAnchorIds, lifecycleStatus: relationRecord.lifecycleStatus }));
      setEvidenceIds(relationRecord.evidenceAnchorIds);
      setLifecycleStatus(relationRecord.lifecycleStatus);
    } else if (tab === "events" && eventRecord) {
      const fields = { name: eventRecord.name, occurredAt: eventRecord.occurredAt, participantFactIds: eventRecord.participantFactIds };
      setEvent(fields); setEditVersion(eventRecord.eventVersion);
      setBaseline(JSON.stringify({ fields, evidenceIds: eventRecord.evidenceAnchorIds, lifecycleStatus: eventRecord.lifecycleStatus }));
      setEvidenceIds(eventRecord.evidenceAnchorIds);
      setLifecycleStatus(eventRecord.lifecycleStatus);
    } else if (tab === "beliefs" && beliefRecord) {
      const fields = { holderKnowledgeId: beliefRecord.holderKnowledgeId, proposition: beliefRecord.proposition };
      setBelief(fields); setEditVersion(beliefRecord.beliefVersion);
      setBaseline(JSON.stringify({ fields, evidenceIds: beliefRecord.evidenceAnchorIds, lifecycleStatus: beliefRecord.lifecycleStatus }));
      setEvidenceIds(beliefRecord.evidenceAnchorIds);
      setLifecycleStatus(beliefRecord.lifecycleStatus);
    } else if (tab === "foreshadowings" && foreshadowingRecord) {
      const fields = { title: foreshadowingRecord.title, targetChapterId: foreshadowingRecord.targetChapterId ?? "", status: foreshadowingRecord.status };
      setForeshadowing(fields); setEditVersion(foreshadowingRecord.foreshadowingVersion);
      setBaseline(JSON.stringify({ fields, evidenceIds: foreshadowingRecord.evidenceAnchorIds, lifecycleStatus: foreshadowingRecord.lifecycleStatus }));
      setEvidenceIds(foreshadowingRecord.evidenceAnchorIds);
      setLifecycleStatus(foreshadowingRecord.lifecycleStatus);
    }
    setSelectedId(id);
    setError(null);
    setNotice(null);
    setEditing(true);
  }

  async function save() {
    if (!project.data || !canSave() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const common = {
      id: selectedId ?? crypto.randomUUID(),
      projectId: project.data.projectId,
      evidenceAnchorIds: evidenceIds,
      lifecycleStatus,
      createdBy: activeRecord?.createdBy ?? "desktop-user",
      createdAt: activeRecord?.createdAt ?? "",
      updatedAt: "",
    };
    const activeVersion = editVersion;
    try {
      if ((await getCurrentProject())?.projectId !== project.data.projectId) throw new Error("作品已切换，未保存记录。");
      if (tab === "relations") {
        const value = { ...common, relationVersion: activeVersion + 1, fromKnowledgeId: relation.fromKnowledgeId, toKnowledgeId: relation.toKnowledgeId, relationType: relation.relationType.trim() };
        if (selectedId) await updateRelation(value, activeVersion); else await createRelation(value);
        setRelation({ fromKnowledgeId: "", toKnowledgeId: "", relationType: "" });
      } else if (tab === "events") {
        const value = { ...common, eventVersion: activeVersion + 1, name: event.name.trim(), occurredAt: event.occurredAt, participantFactIds: event.participantFactIds };
        if (selectedId) await updateEvent(value, activeVersion); else await createEvent(value);
        setEvent({ name: "", occurredAt: "", participantFactIds: [] });
      } else if (tab === "beliefs") {
        const value = { ...common, beliefVersion: activeVersion + 1, holderKnowledgeId: belief.holderKnowledgeId, proposition: belief.proposition.trim() };
        if (selectedId) await updateBelief(value, activeVersion); else await createBelief(value);
        setBelief({ holderKnowledgeId: "", proposition: "" });
      } else {
        const value = { ...common, foreshadowingVersion: activeVersion + 1, title: foreshadowing.title.trim(), targetChapterId: foreshadowing.targetChapterId || null, status: foreshadowing.status.trim() };
        if (selectedId) await updateForeshadowing(value, activeVersion); else await createForeshadowing(value);
        setForeshadowing({ title: "", targetChapterId: "", status: "PLANTED" });
      }
      setEvidenceIds([]);
      setSelectedId(null);
      setEditing(false);
      await client.invalidateQueries({ queryKey: [tab] });
      setNotice(activeRecord ? `已追加为 v${activeVersion + 1}` : `已创建${tabs.find((item) => item.id === tab)?.label}记录`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  return (
    <section className="story-bible-view knowledge-records-view library-workspace">
      {!aiWorkspace && <div className="workspace-heading">
        <h1>剧情记录</h1>
      </div>}
      <KnowledgeSectionNav />
      <div className="library-toolbar">
        <select aria-label="记录类型" value={tab} disabled={busy} onChange={(event) => switchTab(event.target.value as RecordTab)}>{tabs.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select>
        <select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value as "ALL" | KnowledgeLifecycleStatus)} aria-label="审核状态筛选">
          <option value="ALL">全部审核状态</option>
          <option value="ACTIVE">有效</option>
          <option value="NEEDS_REVIEW">待复核</option>
          <option value="ARCHIVED">已归档</option>
        </select>
        <SearchField label="搜索剧情记录" value={search} onChange={setSearch} placeholder="搜索记录" />
        {aiWorkspace ? <button type="button" className="primary-action" disabled={busy || !project.data} onClick={startNew}><Plus size={15} />新建记录</button>
          : project.data && <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "records", tab }}>去构思整理{recordTypeLabels[tab]}</AiWorkspaceLink>}
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {notice ? <p className="project-notice" role="status">{notice}</p> : null}

      {project.isError ? <p role="alert" className="project-error">{errorMessage(project.error)}
        <button type="button" className="secondary-action" disabled={project.isFetching} onClick={() => void project.refetch()}>重试作品信息</button></p> : null}
      <div className="library-layout">
        <aside className="library-list" aria-label="剧情记录列表">
          {query.isError ? <p className="project-error" role="alert">无法加载记录：{errorMessage(query.error)}<button type="button" onClick={() => void query.refetch()}>重试</button></p> : null}
          {query.isPending ? <p className="plan-empty">正在加载记录…</p> : null}
          {query.isSuccess && !visibleRecords.length ? <div className="library-list-empty">
            <p className="plan-empty">{content.length ? "没有符合条件的记录。" : `暂无${tabs.find((item) => item.id === tab)?.label}记录`}</p>
            {search || lifecycleFilter !== "ALL" ? <button type="button" className="secondary-action" onClick={() => {
              setSearch(""); setLifecycleFilter("ALL");
            }}>重置筛选</button> : null}</div> : null}
          {visibleRecords.map((item) => <button type="button" className="library-item" data-selected={selectedId === item.id} disabled={busy} key={item.id} onClick={() => {
            if (item.id === selectedId || !mayLeave()) return;
            setSelectedId(item.id); setEditing(false); setError(null); setNotice(null);
          }}><strong>{item.title}</strong><span>{item.detail}</span><small>v{item.version} · {item.status.replace("ACTIVE", "有效").replace("NEEDS_REVIEW", "待复核").replace("ARCHIVED", "已归档").replace("PLANTED", "已埋设").replace("ADVANCING", "推进中").replace("RESOLVED", "已回收")} · {item.evidence} 条证据</small></button>)}
        </aside>
        <div className="library-detail">
        {!editing && activeRecord ? <>
          <ContentTypeLabel identity={{ category: "RECORD", subtype: recordTypeLabels[tab] }} />
          <h2>{content.find((item) => item.id === selectedId)?.title}</h2><p className="library-content">{content.find((item) => item.id === selectedId)?.detail}</p>
          <p className="library-meta">v{activeVersion} · {activeRecord.evidenceAnchorIds.length} 条证据</p>
          {aiWorkspace ? <button type="button" className="secondary-action" onClick={() => startEdit(activeRecord.id)}><Pencil size={15} />编辑记录</button>
            : project.data && <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "records", targetId: activeRecord.id, tab }}>去构思处理此{recordTypeLabels[tab]}记录</AiWorkspaceLink>}
          <div className="library-evidence">{activeRecord.evidenceAnchorIds.map((id) => {
            const anchor = anchors.data?.find((item) => item.id === id);
            return anchor ? <a key={id} href={manuscriptSourceHref({ projectId: project.data?.projectId, evidenceAnchorId: id }, "/knowledge/records")}>
              {chapterList.find((chapter) => chapter.id === anchor.chapterId)?.title ?? "未命名章节"} · 查看来源证据</a> : <p key={id}>证据暂不可用</p>;
          })}</div>
        </> : !editing ? <div className="library-empty"><p role={selectedId && query.isSuccess ? "alert" : undefined}>{query.isPending ? "正在加载记录…" : query.isError ? "记录暂不可用"
          : selectedId ? "指定的剧情记录不存在或不属于当前作品，未打开其他记录。"
          : !content.length ? "尚未添加剧情记录" : "选择一条剧情记录"}</p></div> : null}
        {editing ? <form className="library-form" onSubmit={(form) => { form.preventDefault(); void save(); }}>
          <div className="section-heading"><h2>{selectedId ? `编辑${tabs.find((item) => item.id === tab)?.label}记录` : `新建${tabs.find((item) => item.id === tab)?.label}记录`}</h2><span>{selectedId ? `编辑基于 v${editVersion}` : `${evidenceIds.length} 条证据`}</span></div>
          {selectedId && editVersion !== activeVersion ? <p role="status" className="project-notice">记录已有新版本，本地修改仍保留。保存时将检查版本冲突。</p> : null}
          <fieldset className="entity-import-lock library-form" disabled={busy}>
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
          <fieldset className="knowledge-select-list"><legend>证据锚点</legend>{anchors.isPending ? <span>正在加载证据…</span> : null}{anchors.isError ? <span role="alert">{errorMessage(anchors.error)}</span> : null}{!anchors.isPending && !(anchors.data ?? []).length ? <span>尚无证据锚点，请先在正文事实审核流程中建立证据。</span> : null}{(anchors.data ?? []).map((item, index) => <label key={item.id}><input type="checkbox" checked={evidenceIds.includes(item.id)} onChange={() => toggle(evidenceIds, item.id, setEvidenceIds)} />{chapterList.find((chapter) => chapter.id === item.chapterId)?.title ?? "未命名章节"} · 证据 {index + 1}</label>)}</fieldset>
          <div className="inspector-actions"><button type="submit" className="primary-action" disabled={!canSave()}><Save size={15} />{busy ? "保存中…" : selectedId ? `保存为 v${editVersion + 1}` : `创建${tabs.find((item) => item.id === tab)?.label}`}</button>
            <button type="button" className="secondary-action" disabled={busy} onClick={() => { if (mayLeave()) setEditing(false); }}>取消</button></div>
          </fieldset>
        </form> : null}
        </div>
      </div>
    </section>
  );
}
