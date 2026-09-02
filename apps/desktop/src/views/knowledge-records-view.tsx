import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Link2, Milestone, Save, Sparkles, UserRoundCheck } from "lucide-react";
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
  const content = useMemo(() => {
    if (tab === "relations") return (relations.data ?? []).map((item) => ({ id: item.id, title: item.relationType, detail: `${factLabels.get(item.fromKnowledgeId) ?? item.fromKnowledgeId} -> ${factLabels.get(item.toKnowledgeId) ?? item.toKnowledgeId}`, status: item.lifecycleStatus, evidence: item.evidenceAnchorIds.length }));
    if (tab === "events") return (events.data ?? []).map((item) => ({ id: item.id, title: item.name, detail: item.occurredAt, status: item.lifecycleStatus, evidence: item.evidenceAnchorIds.length }));
    if (tab === "beliefs") return (beliefs.data ?? []).map((item) => ({ id: item.id, title: item.proposition, detail: `持有者 ${factLabels.get(item.holderKnowledgeId) ?? item.holderKnowledgeId}`, status: item.lifecycleStatus, evidence: item.evidenceAnchorIds.length }));
    return (foreshadowings.data ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.targetChapterId ? `目标章节 ${chapterList.find((chapter) => chapter.id === item.targetChapterId)?.title ?? item.targetChapterId}` : "尚未指定目标章节", status: `${item.lifecycleStatus} · ${item.status}`, evidence: item.evidenceAnchorIds.length }));
  }, [beliefs.data, chapterList, events.data, factLabels, foreshadowings.data, relations.data, tab]);

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

  async function save() {
    if (!project.data || !canSave()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const common = {
      id: crypto.randomUUID(),
      projectId: project.data.projectId,
      evidenceAnchorIds: evidenceIds,
      lifecycleStatus: "ACTIVE" as const,
      createdBy: "desktop-user",
      createdAt: "",
      updatedAt: "",
    };
    try {
      if (tab === "relations") {
        await createRelation({ ...common, relationVersion: 1, fromKnowledgeId: relation.fromKnowledgeId, toKnowledgeId: relation.toKnowledgeId, relationType: relation.relationType.trim() });
        setRelation({ fromKnowledgeId: "", toKnowledgeId: "", relationType: "" });
      } else if (tab === "events") {
        await createEvent({ ...common, eventVersion: 1, name: event.name.trim(), occurredAt: event.occurredAt, participantFactIds: event.participantFactIds });
        setEvent({ name: "", occurredAt: "", participantFactIds: [] });
      } else if (tab === "beliefs") {
        await createBelief({ ...common, beliefVersion: 1, holderKnowledgeId: belief.holderKnowledgeId, proposition: belief.proposition.trim() });
        setBelief({ holderKnowledgeId: "", proposition: "" });
      } else {
        await createForeshadowing({ ...common, foreshadowingVersion: 1, title: foreshadowing.title.trim(), targetChapterId: foreshadowing.targetChapterId || null, status: foreshadowing.status.trim() });
        setForeshadowing({ title: "", targetChapterId: "", status: "PLANTED" });
      }
      setEvidenceIds([]);
      await client.invalidateQueries({ queryKey: [tab] });
      setNotice(`已创建${tabs.find((item) => item.id === tab)?.label}记录`);
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
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={tab === id} data-active={tab === id || undefined} onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {notice ? <p className="project-notice" role="status">{notice}</p> : null}

      <div className="knowledge-record-workbench">
        <form className="knowledge-record-form" onSubmit={(form) => { form.preventDefault(); void save(); }}>
          <div className="section-heading"><h2>新建{tabs.find((item) => item.id === tab)?.label}记录</h2><span>{evidenceIds.length} 条证据</span></div>
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
          <fieldset className="knowledge-select-list"><legend>证据锚点</legend>{anchors.isPending ? <span>正在加载证据…</span> : null}{!anchors.isPending && !(anchors.data ?? []).length ? <span>尚无证据锚点，请先在章节审核流程中建立证据。</span> : null}{(anchors.data ?? []).map((item) => <label key={item.id}><input type="checkbox" checked={evidenceIds.includes(item.id)} onChange={() => toggle(evidenceIds, item.id, setEvidenceIds)} />章节 {item.chapterId.slice(0, 8)} · 区块 {item.blockId}</label>)}</fieldset>
          <div className="inspector-actions"><button type="submit" className="primary-action" disabled={!canSave()}><Save size={15} />{busy ? "创建中…" : `创建${tabs.find((item) => item.id === tab)?.label}`}</button></div>
        </form>

        <div className="knowledge-record-list">
          {query.isError ? <p className="project-error" role="alert">无法加载记录：{errorMessage(query.error)}</p> : null}
          {query.isPending ? <p className="plan-empty">正在加载记录…</p> : null}
          {!query.isPending && !content.length ? <p className="plan-empty">暂无已创建的{tabs.find((item) => item.id === tab)?.label}记录。</p> : null}
          {content.map((item) => <article className="knowledge-record-row" key={item.id}><div><strong>{item.title}</strong><span>{item.detail}</span></div><div><span className="entity-type-badge">{item.status}</span><span className="knowledge-evidence"><BookMarked size={13} />{item.evidence}</span></div></article>)}
        </div>
      </div>
    </section>
  );
}
