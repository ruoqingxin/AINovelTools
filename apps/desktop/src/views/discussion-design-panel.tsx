import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FilePenLine, History, Save, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmDiscussionDesign, DISCUSSION_LIMITS, errorMessage, getDiscussionWorkspace,
  listDiscussionDesignProposals, listDiscussionDraftRevisions, listEntityRevisions,
  saveDiscussionWorkspace, summarizeDiscussionDesign,
  type DiscussionDesignEntity, type DiscussionDesignProposal, type DiscussionWorkspace,
  type EntityType, type ModelProfile, type AiTaskPreference,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

export const discussionTopics = [
  { id: "FREE", label: "自由构思" },
  { id: "CHARACTER", label: "角色" },
  { id: "ITEM", label: "物品" },
  { id: "LOCATION", label: "环境与地点" },
  { id: "PLOT", label: "剧情" },
] as const;

const entityLabels: Record<EntityType, string> = {
  CHARACTER: "角色", ITEM: "物品", LOCATION: "地点", FACTION: "势力", CONCEPT: "概念",
};
const chars = (value: string) => Array.from(value).length;
const draftFields = [
  { id: "chosen", label: "已选定内容", shortLabel: "已选定", placeholder: "已确定的角色特征、能力规则或剧情走向…" },
  { id: "alternatives", label: "备选方向", shortLabel: "备选方向", placeholder: "值得保留、还未决定采用的想法…" },
  { id: "questions", label: "未决问题", shortLabel: "未决问题", placeholder: "尚待推敲的动机、逻辑或设定冲突…" },
] as const;

function proposalEdits(proposal: DiscussionDesignProposal) {
  const fallback = {
    entities: proposal.entities, selected: proposal.entities.map(() => true),
    attributes: proposal.entities.map((entity) => JSON.stringify(entity.attributes, null, 2)),
    aliasTexts: proposal.entities.map((entity) => entity.aliases.join("、")),
    tagTexts: proposal.entities.map((entity) => entity.tags.join("、")),
  };
  try {
    const raw = localStorage.getItem(`discussion-design-editor:${proposal.id}`);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as typeof fallback;
    if (Array.isArray(saved.entities) && saved.entities.length === proposal.entities.length
      && saved.entities.every((entity) => typeof entity.name === "string" && typeof entity.description === "string"
        && Array.isArray(entity.aliases) && Array.isArray(entity.tags) && Array.isArray(entity.settings))
      && Array.isArray(saved.selected) && saved.selected.length === saved.entities.length
      && saved.selected.every((value) => typeof value === "boolean")
      && Array.isArray(saved.attributes) && saved.attributes.length === saved.entities.length
      && saved.attributes.every((value) => typeof value === "string")) return {
        ...saved,
        aliasTexts: Array.isArray(saved.aliasTexts) && saved.aliasTexts.length === saved.entities.length
          && saved.aliasTexts.every((value) => typeof value === "string")
          ? saved.aliasTexts : saved.entities.map((entity) => entity.aliases.join("、")),
        tagTexts: Array.isArray(saved.tagTexts) && saved.tagTexts.length === saved.entities.length
          && saved.tagTexts.every((value) => typeof value === "string")
          ? saved.tagTexts : saved.entities.map((entity) => entity.tags.join("、")),
      };
  } catch { /* A malformed local draft must not block the saved server proposal. */ }
  return fallback;
}

function workspaceBackup(sessionId: string): DiscussionWorkspace | null {
  try {
    const text = localStorage.getItem(`discussion-workspace:${sessionId}`);
    if (!text) return null;
    const value = JSON.parse(text) as DiscussionWorkspace;
    if (value.sessionId === sessionId && typeof value.version === "number"
      && discussionTopics.some((topic) => topic.id === value.topicKind)
      && value.draft && typeof value.draft.chosen === "string"
      && typeof value.draft.alternatives === "string" && typeof value.draft.questions === "string") return value;
  } catch { /* Server data remains the recovery baseline. */ }
  return null;
}

function EntityProposalEditor({ proposal, currentWorkspaceVersion, onConfirmed, onPendingChange }: {
  proposal: DiscussionDesignProposal; onConfirmed: () => Promise<void>;
  currentWorkspaceVersion: number | undefined;
  onPendingChange: (pending: boolean) => void;
}) {
  const [initial] = useState(() => proposalEdits(proposal));
  const [entities, setEntities] = useState(initial.entities);
  const [selected, setSelected] = useState(initial.selected);
  const [attributes, setAttributes] = useState(initial.attributes);
  const [aliasTexts, setAliasTexts] = useState(initial.aliasTexts);
  const [tagTexts, setTagTexts] = useState(initial.tagTexts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = currentWorkspaceVersion !== undefined && currentWorkspaceVersion !== proposal.workspaceVersion;
  const linkedId = proposal.entities.find((entity) => entity.targetEntityId)?.targetEntityId;
  const revisions = useQuery({
    queryKey: ["entity-revisions", linkedId],
    queryFn: () => listEntityRevisions(linkedId!),
    enabled: Boolean(linkedId),
  });
  const dirty = proposal.status === "PENDING" && (
    JSON.stringify(entities) !== JSON.stringify(proposal.entities)
    || selected.some((value) => !value)
    || attributes.some((value, index) => value !== JSON.stringify(proposal.entities[index].attributes, null, 2))
    || aliasTexts.some((value, index) => value !== proposal.entities[index].aliases.join("、"))
    || tagTexts.some((value, index) => value !== proposal.entities[index].tags.join("、"))
  );
  useUnsavedChangesGuard(dirty, "整理结果有尚未确认的编辑。");
  useEffect(() => {
    try {
      if (proposal.status === "CONFIRMED") localStorage.removeItem(`discussion-design-editor:${proposal.id}`);
      else localStorage.setItem(`discussion-design-editor:${proposal.id}`, JSON.stringify({ entities, selected, attributes, aliasTexts, tagTexts }));
    } catch { setError("整理结果的编辑无法缓存到本机，关闭前请确认入库。"); }
  }, [aliasTexts, attributes, entities, proposal.id, proposal.status, selected, tagTexts]);

  function update(index: number, changes: Partial<DiscussionDesignEntity>) {
    setEntities((current) => current.map((entity, item) => item === index ? { ...entity, ...changes } : entity));
  }

  async function confirm() {
    if (stale) return;
    setError(null);
    const chosen: DiscussionDesignEntity[] = [];
    try {
      entities.forEach((entity, index) => {
        if (!selected[index]) return;
        const parsed: unknown = JSON.parse(attributes[index]);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("属性必须是 JSON 对象。");
        if (!entity.name.trim()) throw new Error("请填写选中实体的名称。");
        chosen.push({ ...entity, name: entity.name.trim(), attributes: parsed as Record<string, unknown>,
          aliases: aliasTexts[index].split(/[、,，]/).map((item) => item.trim()).filter(Boolean),
          tags: tagTexts[index].split(/[、,，]/).map((item) => item.trim()).filter(Boolean),
          settings: entity.settings.map((item) => item.trim()).filter(Boolean) });
      });
      if (!chosen.length) throw new Error("请至少选择一个实体。");
      if (chars(JSON.stringify(chosen)) > DISCUSSION_LIMITS.proposalChars) throw new Error("整理内容超过 10 万字，请分主题入库。");
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    if (chosen.some((entity) => entity.targetEntityId)
      && !window.confirm("确认将选中的修改保存为已有实体的新修订？旧版本会保留。")) return;
    setBusy(true);
    onPendingChange(true);
    try {
      await confirmDiscussionDesign(proposal.id, chosen);
      await onConfirmed();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      onPendingChange(false);
    }
  }

  if (proposal.status === "CONFIRMED") return <div className="discussion-design-confirmed">
    <Check size={14} /><span>已确认 {proposal.promotedEntityIds.length} 个实体</span>
    <a href="/knowledge">实体库</a><a href="/knowledge/settings">作者设定</a>
  </div>;

  return <section className="discussion-proposal-editor">
    <div className="section-heading"><h3>待确认设定</h3><span>{proposal.sourceMessageIds.length} 条讨论 · 草稿 v{proposal.workspaceVersion}</span></div>
    {stale ? <p className="project-notice" role="status">构思草稿已更新，请重新整理后确认。</p> : null}
    {proposal.omittedMessageCount > 0 ? <p className="project-notice" role="status">
      本次未纳入较早的 {proposal.omittedMessageCount} 条消息。原文完整保留；可先把重要选择补进草稿，再重新整理。
    </p> : null}
    {entities.map((entity, index) => <article className="discussion-entity-proposal" key={index}>
      <div className="discussion-entity-select">
        <label><input type="checkbox" disabled={busy} checked={selected[index]} onChange={(event) =>
          setSelected((current) => current.map((value, item) => item === index ? event.target.checked : value))} />
          {entityLabels[entity.entityType]}</label>
        <span>{entity.targetEntityId ? `更新已有实体 v${entity.expectedEntityVersion}` : "新实体"}</span>
      </div>
      <fieldset disabled={!selected[index] || busy}>
        <label>名称<input value={entity.name} maxLength={200} onChange={(event) => update(index, { name: event.target.value })} /></label>
        <label>描述<textarea rows={4} value={entity.description} onChange={(event) => update(index, { description: event.target.value })} /></label>
        <label>别名<input value={aliasTexts[index]} onChange={(event) => setAliasTexts((current) =>
          current.map((value, item) => item === index ? event.target.value : value))} /></label>
        <label>标签<input value={tagTexts[index]} onChange={(event) => setTagTexts((current) =>
          current.map((value, item) => item === index ? event.target.value : value))} /></label>
        <label>作者设定<textarea rows={4} value={entity.settings.join("\n")} onChange={(event) => update(index, {
          settings: event.target.value.split("\n"),
        })} /></label>
        <label>公开状态<select value={entity.visibility} onChange={(event) =>
          update(index, { visibility: event.target.value as DiscussionDesignEntity["visibility"] })}>
          <option value="AUTHOR_ONLY">作者保留／尚未揭示</option><option value="PUBLIC">可向读者揭示</option>
        </select></label>
        <details><summary>结构化属性</summary><textarea aria-label={`${entity.name}的结构化属性`} rows={6}
          value={attributes[index]} onChange={(event) => setAttributes((current) =>
            current.map((value, item) => item === index ? event.target.value : value))} /></details>
        {entity.targetEntityId ? <details><summary>与已有设定对照</summary>
          {revisions.isPending ? <p>正在加载旧版本…</p> : revisions.isError ? <p role="alert">旧版本加载失败，请先回实体库检查。</p>
            : <div className="discussion-existing-version">
              <strong>原名称</strong><p>{revisions.data?.[0]?.name}</p>
              <strong>原描述</strong><p>{revisions.data?.[0]?.description}</p>
              <strong>原属性</strong><pre>{revisions.data?.[0]?.fixedAttributesJson}</pre>
            </div>}
        </details> : null}
      </fieldset>
    </article>)}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    <button type="button" className="primary-action" onClick={() => void confirm()}
      disabled={busy || stale || !selected.some(Boolean) || Boolean(linkedId && !revisions.isSuccess)}>
      <Check size={14} />{busy ? "确认中…" : "确认选中内容入库"}
    </button>
  </section>;
}

export function DiscussionDesignPanel({ sessionId, profile, preference, hasDiscussion, conversationBusy, draftFocus, onPendingChange }: {
  sessionId: string; profile: ModelProfile | undefined; preference: AiTaskPreference;
  hasDiscussion: boolean;
  conversationBusy: boolean;
  draftFocus: { field: "chosen" | "alternatives" } | null;
  onPendingChange: (pending: boolean) => void;
}) {
  const client = useQueryClient();
  const workspaceQuery = useQuery({
    queryKey: ["discussion-workspace", sessionId], queryFn: () => getDiscussionWorkspace(sessionId),
  });
  const proposals = useQuery({
    queryKey: ["discussion-design-proposals", sessionId],
    queryFn: () => listDiscussionDesignProposals(sessionId),
  });
  const [workspace, setWorkspace] = useState<DiscussionWorkspace | null>(null);
  const [saved, setSaved] = useState<DiscussionWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [activeField, setActiveField] = useState<typeof draftFields[number]["id"]>("chosen");
  const [olderVersions, setOlderVersions] = useState<DiscussionWorkspace[]>([]);
  const [olderProposals, setOlderProposals] = useState<DiscussionDesignProposal[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [recovery, setRecovery] = useState<DiscussionWorkspace | null>(null);
  const hasMoreVersions = useRef(true);
  const hasMoreProposals = useRef(true);
  const initialized = useRef(false);
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  const history = useQuery({
    queryKey: ["discussion-draft-revisions", sessionId],
    queryFn: () => listDiscussionDraftRevisions(sessionId), enabled: showHistory,
  });
  const dirty = Boolean(workspace && saved && JSON.stringify(workspace) !== JSON.stringify(saved));
  useUnsavedChangesGuard(dirty, "构思草稿尚未保存。");
  const totalChars = workspace
    ? chars(workspace.draft.chosen) + chars(workspace.draft.alternatives) + chars(workspace.draft.questions)
    : 0;
  const hasContent = hasDiscussion || Boolean(workspace && Object.values(workspace.draft).some((value) => value.trim()));

  useEffect(() => {
    if (!draftFocus) return;
    setActiveField(draftFocus.field);
    setShowResults(false);
  }, [draftFocus]);

  useEffect(() => {
    if (workspaceQuery.data && (!initialized.current || !dirty && workspaceQuery.data.version > (saved?.version ?? -1))) {
      if (!initialized.current) {
        const backup = workspaceBackup(sessionId);
        if (backup && JSON.stringify(backup.draft) !== JSON.stringify(workspaceQuery.data.draft)) {
          if (backup.version === workspaceQuery.data.version) {
            setWorkspace(backup);
            setSaved(workspaceQuery.data);
            initialized.current = true;
            return;
          }
          setRecovery(backup);
        }
      }
      initialized.current = true;
      setWorkspace(workspaceQuery.data);
      setSaved(workspaceQuery.data);
    }
  }, [dirty, saved?.version, sessionId, workspaceQuery.data]);

  useEffect(() => {
    if (!workspace) return;
    try {
      if (dirty) localStorage.setItem(`discussion-workspace:${sessionId}`, JSON.stringify(workspace));
      else if (!recovery) localStorage.removeItem(`discussion-workspace:${sessionId}`);
    } catch { setError("构思草稿无法缓存到本机，请手动保存后再关闭。"); }
  }, [dirty, recovery, sessionId, workspace]);

  useEffect(() => {
    onPendingChange(busy || dirty);
    return () => onPendingChange(false);
  }, [busy, dirty, onPendingChange]);

  const save = useCallback(async () => {
    if (!workspace) return null;
    if (totalChars > DISCUSSION_LIMITS.draftChars) {
      setError("构思草稿合计最多 50000 字，请拆成多个讨论。");
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await saveDiscussionWorkspace(workspace);
      setRecovery(null);
      setSaved(next);
      setWorkspace((current) => JSON.stringify(current) === JSON.stringify(workspace)
        ? next : current ? { ...current, version: next.version } : next);
      client.setQueryData(["discussion-workspace", sessionId], next);
      await client.invalidateQueries({ queryKey: ["discussion-draft-revisions", sessionId] });
      setNotice(`草稿已保存 · v${next.version}`);
      return next;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, [client, sessionId, totalChars, workspace]);

  useEffect(() => {
    if (!dirty || busy || error || totalChars > DISCUSSION_LIMITS.draftChars) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [busy, dirty, error, save, totalChars]);

  async function summarize() {
    if (!workspace || !profile?.hasSecret || busy || conversationBusy || !hasContent) return;
    const snapshot = dirty ? await save() : workspace;
    if (!snapshot || JSON.stringify(latestWorkspace.current?.draft) !== JSON.stringify(snapshot.draft)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await summarizeDiscussionDesign({
        sessionId, profileId: profile.id, expectedWorkspaceVersion: snapshot.version,
        ...(preference.temperature !== null ? { temperature: preference.temperature } : {}),
        maxOutputTokens: Math.min(preference.maxOutputTokens ?? 8192, 16384),
      });
      await client.invalidateQueries({ queryKey: ["discussion-design-proposals", sessionId] });
      setShowResults(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmed() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["discussion-design-proposals", sessionId] }),
      client.invalidateQueries({ queryKey: ["entities"] }),
      client.invalidateQueries({ queryKey: ["entity-revisions"] }),
      client.invalidateQueries({ queryKey: ["author-settings"] }),
    ]);
    setNotice("已确认入库。");
  }

  async function olderHistory() {
    const versions = [...(history.data ?? []), ...olderVersions];
    if (!versions.length) return;
    setHistoryBusy(true);
    try {
      const page = await listDiscussionDraftRevisions(sessionId, versions[versions.length - 1].version);
      setOlderVersions((current) => [...current, ...page]);
      hasMoreVersions.current = page.length === 50;
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setHistoryBusy(false); }
  }

  async function loadOlderProposals() {
    const all = [...(proposals.data ?? []), ...olderProposals];
    if (!all.length) return;
    setHistoryBusy(true);
    try {
      const page = await listDiscussionDesignProposals(sessionId, all[all.length - 1].id);
      setOlderProposals((current) => [...current, ...page]);
      hasMoreProposals.current = page.length === 20;
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setHistoryBusy(false); }
  }

  function restore(version: DiscussionWorkspace) {
    if (!workspace || !window.confirm(`将 v${version.version} 恢复为当前草稿？现有历史版本仍保留。`)) return;
    setWorkspace({ ...version, version: workspace.version });
    setError(null);
    setNotice(null);
  }

  return <aside className="discussion-design-panel" aria-label="构思草稿">
    <div className="section-heading"><h2><FilePenLine size={17} />{showResults ? "整理结果" : "构思草稿"}</h2>
      {showResults ? <button type="button" className="secondary-action discussion-icon-button"
        aria-label="返回构思草稿" title="返回构思草稿" onClick={() => setShowResults(false)}><ArrowLeft size={15} /></button>
        : <span className="discussion-save-state" data-dirty={dirty || undefined}>
          {busy ? "处理中…" : dirty ? "待保存" : workspace ? `已保存 · v${saved?.version ?? 0}` : "加载中…"}
        </span>}</div>
    {workspaceQuery.isError ? <p className="project-error" role="alert">{errorMessage(workspaceQuery.error)}
      <button type="button" onClick={() => void workspaceQuery.refetch()}>重试</button></p> : null}
    {!workspace && workspaceQuery.isPending ? <p>正在加载草稿…</p> : null}
    {workspace && !showResults ? <>
      {recovery ? <section className="discussion-local-recovery">
        <p>发现未保存的本机草稿，保存版本已变化。</p>
        <button type="button" className="secondary-action" disabled={busy} onClick={() => {
          if (!window.confirm("载入本机草稿进行编辑？再次保存会创建新版本，原保存版本仍保留。")) return;
          setWorkspace({ ...recovery, version: workspace.version });
          setRecovery(null);
          setError(null);
        }}><History size={13} />载入本机草稿</button>
      </section> : null}
      <label>构思主题<select aria-label="构思主题" value={workspace.topicKind} disabled={busy} onChange={(event) => {
        setWorkspace({ ...workspace, topicKind: event.target.value as DiscussionWorkspace["topicKind"] });
        setError(null);
      }}>{discussionTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.label}</option>)}</select></label>
      <div className="discussion-draft-tabs" role="tablist" aria-label="构思内容">
        {draftFields.map((field) => <button key={field.id} type="button" role="tab"
          id={`draft-tab-${sessionId}-${field.id}`} aria-controls={`draft-field-${sessionId}-${field.id}`}
          aria-selected={activeField === field.id} tabIndex={activeField === field.id ? 0 : -1}
          onClick={() => setActiveField(field.id)} onKeyDown={(event) => {
            const index = draftFields.findIndex((item) => item.id === activeField);
            const next = event.key === "ArrowRight" ? (index + 1) % draftFields.length
              : event.key === "ArrowLeft" ? (index + draftFields.length - 1) % draftFields.length
                : event.key === "Home" ? 0 : event.key === "End" ? draftFields.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            setActiveField(draftFields[next].id);
            document.getElementById(`draft-tab-${sessionId}-${draftFields[next].id}`)?.focus();
          }}>
          {field.shortLabel}{workspace.draft[field.id].trim() ? <span className="discussion-draft-dot" aria-label="有内容" /> : null}
        </button>)}
      </div>
      {draftFields.map((field) => <div key={field.id} role="tabpanel" className="discussion-draft-field"
        id={`draft-field-${sessionId}-${field.id}`} aria-labelledby={`draft-tab-${sessionId}-${field.id}`}
        hidden={activeField !== field.id}>
        <label>{field.label}
        <textarea aria-label={field.label} placeholder={field.placeholder}
          rows={10} disabled={busy} value={workspace.draft[field.id]}
          onChange={(event) => {
            setWorkspace({ ...workspace, draft: { ...workspace.draft, [field.id]: event.target.value } });
            setError(null); setNotice(null);
          }} />
        </label>
      </div>)}
      <div className="discussion-draft-toolbar"><span>{totalChars.toLocaleString()} / 50,000 字</span>
        <button type="button" className="secondary-action discussion-icon-button" aria-label="保存草稿" title="保存草稿"
          onClick={() => void save()} disabled={busy || !dirty}>
          <Save size={15} /></button>
        <button type="button" className="secondary-action discussion-icon-button" aria-label="历史版本" title="历史版本"
          onClick={() => setShowHistory((current) => !current)} aria-expanded={showHistory}>
          <History size={15} /></button>
      </div>
      <button type="button" className="primary-action" onClick={() => void summarize()}
        disabled={busy || conversationBusy || !profile?.hasSecret || !hasContent || totalChars > DISCUSSION_LIMITS.draftChars}>
        <Sparkles size={14} />{busy ? "处理中…" : "整理为实体与设定"}
      </button>
      {!profile?.hasSecret ? <p className="discussion-panel-state">模型未就绪</p>
        : !hasContent ? <p className="discussion-panel-state">暂无可整理内容</p> : null}
    </> : null}
    {!showResults && proposals.data?.length ? <button type="button" className="secondary-action"
      onClick={() => setShowResults(true)}><Check size={14} />查看整理结果 · {proposals.data.length}</button> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {showHistory && !showResults ? <section className="discussion-draft-history">
      {history.isError ? <p role="alert">{errorMessage(history.error)}</p> : null}
      {[...(history.data ?? []), ...olderVersions].map((version) =>
        <details key={version.version}><summary>草稿 v{version.version}</summary>
          <p>{version.draft.chosen || "没有已选定内容"}</p>
          <p>{version.draft.alternatives}</p><p>{version.draft.questions}</p>
          <button type="button" className="secondary-action" onClick={() => restore(version)} disabled={busy}><History size={12} />恢复此版本</button>
        </details>)}
      {history.isSuccess && !history.data.length ? <p>暂无历史版本。</p> : null}
      {hasMoreVersions.current && (olderVersions.length ? olderVersions.length % 50 === 0 : history.data?.length === 50)
        ? <button type="button" className="secondary-action" disabled={historyBusy} onClick={() => void olderHistory()}>更早版本</button> : null}
    </section> : null}
    {proposals.isError ? <p className="project-error" role="alert">{errorMessage(proposals.error)}</p> : null}
    {showResults ? [...(proposals.data ?? []), ...olderProposals].map((proposal, index) => index === 0
      ? <EntityProposalEditor key={proposal.id} proposal={proposal} currentWorkspaceVersion={saved?.version} onConfirmed={confirmed} onPendingChange={onPendingChange} />
      : <details className="discussion-older-proposal" key={proposal.id}><summary>
        {proposal.status === "CONFIRMED" ? "已确认" : "待确认"} · {proposal.entities.map((entity) => entity.name).join("、")}
      </summary><EntityProposalEditor proposal={proposal} currentWorkspaceVersion={saved?.version} onConfirmed={confirmed} onPendingChange={onPendingChange} /></details>) : null}
    {showResults && hasMoreProposals.current && (olderProposals.length ? olderProposals.length % 20 === 0 : proposals.data?.length === 20)
      ? <button type="button" className="secondary-action" disabled={historyBusy} onClick={() => void loadOlderProposals()}>更早整理结果</button> : null}
  </aside>;
}
