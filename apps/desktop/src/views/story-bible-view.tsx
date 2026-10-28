import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, FileUp, MessageSquareText, Pencil, Plus, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { classifyAiFailure } from "../lib/ai-failure";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  errorMessage,
  createDiscussionSession,
  extractEntitiesFromText,
  getCurrentProject,
  importEntities as importEntityBatch,
  listEntityCards,
  listEntityRevisions,
  listModelProfiles,
  setEntityArchived,
  upsertEntity,
  type Entity,
  type EntityInput,
  type EntityType,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { sourceReturnTo } from "../lib/manuscript-source";
import { EntityChapters } from "./entity-chapters";
import { WorkspacePanel } from "./workspace-panel";
import "./library-workspace.css";
import { SearchField } from "./search-field";
import { entityIdentity, entityTypeLabels } from "../lib/content-taxonomy";
import { AiWorkspaceLink, ContentTypeLabel, useInAiWorkspace } from "./content-identity";

const typeLabels = entityTypeLabels;

const emptyForm: EntityInput = {
  entityType: "CHARACTER",
  name: "",
  aliases: [],
  description: "",
  fixedAttributesJson: "{}",
  tags: [],
};

function entitySignature(form: EntityInput, summaryText: string, scopeText: string) {
  return JSON.stringify({
    entityType: form.entityType,
    name: form.name,
    description: form.description,
    fixedAttributesJson: form.fixedAttributesJson,
    sourceVersion: form.sourceVersion ?? "",
    aliases: summaryText.split(/[、,，]/).map((value) => value.trim()).filter(Boolean),
    tags: scopeText.split(/[、,，]/).map((value) => value.trim()).filter(Boolean),
  });
}

export function StoryBibleView() {
  const aiWorkspace = useInAiWorkspace();
  const client = useQueryClient();
  const cards = useQuery({ queryKey: ["entity-cards", true], queryFn: () => listEntityCards(true), retry: false });
  const records = useMemo(() => cards.data?.map((card) => card.entity), [cards.data]);
  const entities = { ...cards, data: records };
  const currentRevisionByEntity = useMemo(() => new Map((cards.data ?? []).map((card) => [card.entity.id, card.revision])), [cards.data]);
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, retry: false });
  const params = new URLSearchParams(window.location.search);
  const requestedEntity = params.get("entity");
  const targetProject = params.get("targetProject");
  const returnTo = sourceReturnTo(params.get("returnTo"));
  const [targetResolved, setTargetResolved] = useState(requestedEntity === null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"ALL" | EntityType>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "ARCHIVED">("ACTIVE");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(aiWorkspace && params.get("action") === "new");
  const [showImport, setShowImport] = useState(aiWorkspace && params.get("action") === "import");
  const [importType, setImportType] = useState<EntityType>("CHARACTER");
  const [importTopic, setImportTopic] = useState("");
  const [importSummary, setImportSummary] = useState("");
  const [importScope, setImportScope] = useState("");
  const [form, setForm] = useState<EntityInput>(emptyForm);
  const [summaryText, setSummaryText] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [savedSignature, setSavedSignature] = useState(() => entitySignature(emptyForm, "", ""));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "archive" | "reload" | null>(null);
  const saveInFlight = useRef(false);
  const [importFileName, setImportFileName] = useState("");
  const [importItems, setImportItems] = useState<Array<{ name: string; description: string; aliases: string[]; tags: string[] }>>([]);
  const [importSourceText, setImportSourceText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importWriting, setImportWriting] = useState(false);
  const importInFlight = useRef(false);
  const [extractionFailed, setExtractionFailed] = useState(false);
  const modelProfiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const extractionProfile = resolveTaskChatProfile(modelProfiles.data, aiPreferences.data, "knowledgeExtraction");
  const extractionPreference = resolveTaskPreference(aiPreferences.data, "knowledgeExtraction");
  const [importGuidance, setImportGuidance] = useState("");
  const selected = entities.data?.find((entity) => entity.id === selectedId) ?? null;
  const entityDirty = entitySignature(form, summaryText, scopeText) !== savedSignature;
  const remoteChanged = selected && form.id === selected.id && form.expectedVersion !== selected.version;
  const revisions = useQuery({
    queryKey: ["entity-revisions", selectedId],
    queryFn: () => listEntityRevisions(selectedId!),
    enabled: Boolean(selectedId),
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (entities.data ?? []).filter((entity) => {
      if (typeFilter !== "ALL" && entity.entityType !== typeFilter) return false;
      if (statusFilter !== "ALL" && entity.lifecycleStatus !== statusFilter) return false;
      if (!query) return true;
      const revision = currentRevisionByEntity.get(entity.id);
      return revision ? [revision.name, ...revision.aliases, ...revision.tags, revision.description]
        .some((value) => value.toLocaleLowerCase().includes(query)) : false;
    });
  }, [currentRevisionByEntity, entities.data, search, statusFilter, typeFilter]);

  useEffect(() => {
    if (!selected) return;
    if (selected.id === form.id && (entityDirty || busy)) return;
    const revision = currentRevisionByEntity.get(selected.id);
    if (!revision) return;
    setForm({
      id: selected.id,
      entityType: selected.entityType,
      name: revision.name,
      aliases: revision.aliases,
      description: revision.description,
      fixedAttributesJson: revision.fixedAttributesJson,
      tags: revision.tags,
      baseRevisionId: revision.id,
      sourceVersion: revision.sourceVersion ?? undefined,
      expectedVersion: selected.version,
    });
    setSummaryText(revision.aliases.join("、"));
    setScopeText(revision.tags.join("、"));
    setSavedSignature(entitySignature({
      id: selected.id,
      entityType: selected.entityType,
      name: revision.name,
      aliases: revision.aliases,
      description: revision.description,
      fixedAttributesJson: revision.fixedAttributesJson,
      tags: revision.tags,
      sourceVersion: revision.sourceVersion ?? undefined,
    }, revision.aliases.join("、"), revision.tags.join("、")));
  }, [busy, currentRevisionByEntity, entityDirty, form.id, selected]);

  useEffect(() => {
    if (targetResolved || requestedEntity === null || cards.isPending || project.isPending) return;
    const target = cards.data?.find((card) => card.entity.id === requestedEntity);
    if (cards.isError || project.isError || !target || !project.data
      || target.entity.projectId !== project.data.projectId || targetProject !== null && targetProject !== project.data.projectId) {
      setTargetError("实体已不可用或不属于当前项目，未打开其他实体。");
    } else {
      setSelectedId(target.entity.id);
      setStatusFilter("ALL");
    }
    setTargetResolved(true);
  }, [cards.data, cards.isError, cards.isPending, project.data, project.isError, project.isPending, requestedEntity, targetProject, targetResolved]);
  useUnsavedChangesGuard(editing && entityDirty || busy !== null || importBusy || importItems.length > 0 || Boolean(importSourceText),
    "当前资料有未保存修改、导入候选或进行中的操作。");

  async function refreshEntities(id?: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["entity-cards"] }),
      client.invalidateQueries({ queryKey: ["entities"] }),
      client.invalidateQueries({ queryKey: ["chapter-entity-references"] }),
      client.invalidateQueries({ queryKey: ["ai-proposals"] }),
      ...(id ? [client.invalidateQueries({ queryKey: ["entity-revisions", id] })] : []),
    ]);
  }

  async function reloadEntity() {
    if (!selected || busy || entityDirty && !window.confirm("放弃本地实体修改并读取最新修订吗？")) return;
    setBusy("reload");
    try {
      const result = await cards.refetch();
      if (result.isError) throw result.error;
      const latest = result.data?.find((card) => card.entity.id === selected.id);
      if (!latest) throw new Error("实体已不可用，未打开其他实体。");
      const input: EntityInput = { id: latest.entity.id, entityType: latest.entity.entityType,
        name: latest.revision.name, description: latest.revision.description, aliases: latest.revision.aliases,
        tags: latest.revision.tags, fixedAttributesJson: latest.revision.fixedAttributesJson,
        sourceVersion: latest.revision.sourceVersion ?? undefined, baseRevisionId: latest.revision.id,
        expectedVersion: latest.entity.version };
      const aliases = input.aliases.join("、");
      const tags = input.tags.join("、");
      setForm(input); setSummaryText(aliases); setScopeText(tags);
      setSavedSignature(entitySignature(input, aliases, tags));
      setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function discussEntity() {
    if (!selected || entityDirty) return;
    try {
      const session = await createDiscussionSession({
        title: `${form.name} · 设定讨论`, scopeKind: "PROJECT", scopeId: null,
        scopeText: JSON.stringify({ kind: "content-target", category: "SETTING", subtype: typeLabels[selected.entityType],
          projectId: selected.projectId, key: `ENTITY:${selected.id}`, revision: selected.currentRevisionId, title: form.name }),
        topicKind: selected.entityType === "CHARACTER" || selected.entityType === "ITEM" || selected.entityType === "LOCATION"
          ? selected.entityType : "FREE",
        linkedEntityId: selected.id,
      });
      window.location.assign(`/discussion#${session.id}`);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  function startNew() {
    if (busy || importInFlight.current || entityDirty && !window.confirm("当前实体有未保存修改，确定新建并放弃这些修改吗？")) return;
    if (!discardImport()) return;
    setTargetError(null);
    setSelectedId(null);
    setEditing(true);
    setForm(emptyForm);
    setSummaryText("");
    setScopeText("");
    setSavedSignature(entitySignature(emptyForm, "", ""));
    setError(null);
    setNotice(null);
  }

  function selectEntity(entity: Entity) {
    if (busy || importInFlight.current) return;
    if (entity.id === selectedId) return;
    if (entity.id !== selectedId && entityDirty && !window.confirm("当前实体有未保存修改，确定切换吗？")) return;
    if (!discardImport()) return;
    setTargetError(null);
    setSelectedId(entity.id);
    setEditing(false);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!project.data || !form.name.trim() || busy || saveInFlight.current || importInFlight.current || form.id && !entityDirty) return;
    saveInFlight.current = true;
    setError(null);
    setNotice(null);
    setBusy("save");
    const input: EntityInput = {
      ...form,
      name: form.name.trim(),
      aliases: summaryText.split(/[、,，]/).map((value) => value.trim()).filter(Boolean),
      tags: scopeText.split(/[、,，]/).map((value) => value.trim()).filter(Boolean),
    };
    try {
      const saved = await upsertEntity(input);
      setForm((current) => ({ ...current, name: current.name === form.name ? input.name : current.name,
        id: saved.id, baseRevisionId: saved.currentRevisionId, expectedVersion: saved.version }));
      setSelectedId(saved.id);
      setSavedSignature(entitySignature(input, summaryText, scopeText));
      await refreshEntities(saved.id);
      setNotice("已保存为新修订");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      setError(code === "VERSION_CONFLICT" ? "实体已被其他操作更新，请重新载入后再保存。" : errorMessage(cause));
    } finally {
      saveInFlight.current = false;
      setBusy(null);
    }
  }

  async function toggleArchive() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setBusy("archive");
    try {
      await setEntityArchived({ id: selected.id, archived: selected.lifecycleStatus === "ACTIVE", expectedVersion: selected.version });
      await refreshEntities(selected.id);
      setNotice(selected.lifecycleStatus === "ACTIVE" ? "实体已归档" : "实体已恢复");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      setError(code === "VERSION_CONFLICT" ? "实体版本已变化，请重新载入后再操作。" : errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function readImportFile(file: File) {
    if (busy || importInFlight.current) return;
    if ((importItems.length || importSourceText) && !window.confirm("替换文件会放弃当前导入候选，确定继续吗？")) return;
    importInFlight.current = true;
    setImportBusy(true);
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      setImportSourceText(text);
      setImportFileName(file.name);
      setImportItems([]);
      setExtractionFailed(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      importInFlight.current = false;
      setImportBusy(false);
    }
  }

  async function extractImportItems() {
    if (!importSourceText || busy || importInFlight.current) return;
    if (!extractionProfile) { setError("请先在设置中配置一个可用的聊天模型"); return; }
    if (importItems.length && !window.confirm("重新提炼会替换当前导入候选，确定继续吗？")) return;
    importInFlight.current = true;
    setImportBusy(true); setError(null); setNotice(null); setExtractionFailed(false);
    try {
      if (!importTopic.trim() || !importSummary.trim() || !importScope.trim()) { setError("AI 提炼前必须填写提炼主题、简要概述和适用范围"); return; }
      const items = await extractEntitiesFromText(extractionProfile.id, importType, importTopic.trim(), importSummary.trim(), importScope.trim(), importSourceText, importGuidance.trim(), extractionPreference.temperature ?? undefined, extractionPreference.maxOutputTokens ?? undefined);
      setImportItems(items.slice(0, 200));
      if (!items.length) {
        setExtractionFailed(true);
        setError("AI 没有提炼出符合主题的信息，请调整主题或补充意见后重试。");
      }
    } catch (cause) {
      const detail = errorMessage(cause);
      const failure = classifyAiFailure(detail);
      setExtractionFailed(true);
      setError(`知识提炼失败（${failure.label}）：${detail}。${failure.hint}`);
    }
    finally { importInFlight.current = false; setImportBusy(false); }
  }

  async function importEntities() {
    if (!importItems.length || busy || importInFlight.current || !project.data) return;
    importInFlight.current = true;
    setImportBusy(true);
    setImportWriting(true);
    setError(null);
    const fileName = importFileName;
    const entityType = importType;
    const items = importItems.map((item) => ({
      ...emptyForm, entityType, ...item, sourceVersion: fileName,
    }));
    try {
      const saved = await importEntityBatch({ expectedProjectId: project.data.projectId, items });
      setNotice(`已从“${fileName}”导入 ${saved.length} 条${typeLabels[entityType]}信息`);
      setImportItems([]);
      setImportSourceText("");
      setImportFileName("");
      await refreshEntities();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      importInFlight.current = false;
      setImportBusy(false);
      setImportWriting(false);
    }
  }

  function discardImport() {
    if ((importItems.length || importSourceText) && !window.confirm("当前文件和导入候选尚未写入，确定放弃并切换吗？")) return false;
    setImportItems([]);
    setImportSourceText("");
    setImportFileName("");
    return true;
  }

  return (
    <section className="story-bible-view library-workspace">
      <div className="workspace-heading">
        <h1>设定</h1>
      </div>
      <KnowledgeSectionNav />
      {returnTo ? <a className="secondary-action" href={returnTo}>返回来源</a> : null}
      {targetError ? <p className="project-error" role="alert">{targetError}</p> : null}

      <div className="library-toolbar">
        <SearchField label="搜索实体" value={search} onChange={setSearch} placeholder="搜索名称、别名或描述" />
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "ALL" | EntityType)} aria-label="实体类型筛选">
          <option value="ALL">全部类型</option>
          {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "ACTIVE" | "ARCHIVED")} aria-label="实体状态筛选">
          <option value="ACTIVE">仅显示活动</option><option value="ALL">全部状态</option><option value="ARCHIVED">仅显示归档</option>
        </select>
        {!aiWorkspace && project.data ? <>
          <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "entity", action: "import" }}>去构思提取设定</AiWorkspaceLink>
          <AiWorkspaceLink target={{ projectId: project.data.projectId, workflow: "entity", action: "new" }}>去构思新建设定</AiWorkspaceLink>
        </> : null}
        {aiWorkspace && <button type="button" className="secondary-action" disabled={importBusy || busy !== null} onClick={() => {
          if (editing && entityDirty && !window.confirm("放弃当前实体修改并打开文件导入吗？")) return;
          setEditing(false); setForm(emptyForm); setSummaryText(""); setScopeText(""); setSavedSignature(entitySignature(emptyForm, "", ""));
          setShowImport(true); setError(null);
        }}><FileUp size={15} />从文件导入</button>}
        {aiWorkspace && <button type="button" className="primary-action" disabled={importBusy || busy !== null || !project.data} onClick={startNew}><Plus size={15} />新建实体</button>}
      </div>
      {error && !showImport ? <p className="project-error" role="alert">{error}</p> : null}
      {notice && !showImport ? <p className="project-notice" role="status">{notice === "已保存为新修订" && entityDirty
        ? "上一版已保存，当前仍有未保存修改。" : notice}</p> : null}
      {project.isError ? <p className="project-error" role="alert">{errorMessage(project.error)}
        <button type="button" className="secondary-action" disabled={project.isFetching} onClick={() => void project.refetch()}>重试</button></p> : null}

      <div className="library-layout">
        <aside className="library-list" aria-label="实体列表">
          <div className="section-heading"><h2>实体库</h2><span>{filtered.length} / {entities.data?.length ?? 0}</span></div>
          {entities.isPending ? <p className="plan-empty">正在加载实体…</p> : null}
          {entities.isError ? <p className="project-error" role="alert">无法加载实体：{errorMessage(entities.error)}
            <button type="button" className="secondary-action" disabled={entities.isFetching} onClick={() => void cards.refetch()}>重试加载</button></p> : null}
          {entities.isSuccess && filtered.length === 0 ? <div className="library-list-empty">
            <p className="plan-empty">{entities.data?.length ? "没有符合条件的实体。" : "暂无人物与世界设定"}</p>
            {search || typeFilter !== "ALL" || statusFilter !== "ACTIVE" ? <button type="button" className="secondary-action" onClick={() => {
              setSearch(""); setTypeFilter("ALL"); setStatusFilter("ACTIVE");
            }}>重置筛选</button> : null}
          </div> : null}
          {filtered.map((entity) => (
            <button type="button" key={entity.id} className="library-item" disabled={importBusy || busy !== null} data-selected={selectedId === entity.id} onClick={() => selectEntity(entity)}>
              <strong>{currentRevisionByEntity.get(entity.id)?.name ?? "未命名实体"}</strong><small>{typeLabels[entity.entityType]} · {entity.lifecycleStatus === "ARCHIVED" ? "已归档" : "活动"} · v{entity.version}</small>
            </button>
          ))}
        </aside>

        {!targetResolved || targetError ? <div className="library-detail">{!targetResolved ? <p role="status">正在定位实体…</p> : null}</div> : <div className="library-detail">
          {!selected && !editing ? <div className="library-empty"><p>{entities.isPending ? "正在加载设定…" : entities.isError ? "设定暂不可用"
            : !entities.data?.length ? "尚未添加人物与世界设定" : "选择一个人物或世界设定"}</p></div> : <>
          <div className="section-heading"><h2>{selected ? editing ? "编辑实体" : form.name : "新建实体"}</h2>{selected ? <span>版本 {selected.version}</span> : <span>尚未保存</span>}</div>
          {selected && !editing ? <><p className="library-meta">{typeLabels[selected.entityType]} · {selected.lifecycleStatus === "ARCHIVED" ? "已归档" : "活动"}</p>
            <ContentTypeLabel identity={entityIdentity(selected.entityType)} />
            <p className="library-content">{form.description || "暂无描述"}</p>
            {summaryText ? <p>别名：{summaryText}</p> : null}{scopeText ? <p>标签：{scopeText}</p> : null}
            <div className="library-actions">{aiWorkspace ? <>
              <button type="button" className="secondary-action" disabled={busy !== null} onClick={() => setEditing(true)}><Pencil size={15} />编辑实体</button>
              <button type="button" className="secondary-action" disabled={busy !== null} onClick={() => void toggleArchive()}>{selected.lifecycleStatus === "ACTIVE" ? <Archive size={15} /> : <RotateCcw size={15} />}{selected.lifecycleStatus === "ACTIVE" ? "归档实体" : "恢复实体"}</button>
            </> : <AiWorkspaceLink target={{ projectId: selected.projectId, workflow: "entity", targetId: selected.id }}>去构思处理{typeLabels[selected.entityType]}设定</AiWorkspaceLink>}</div>
            <details className="library-advanced"><summary>属性与来源</summary><pre>{form.fixedAttributesJson}</pre><p>来源版本 <code>{form.sourceVersion ?? "未指定"}</code></p></details>
          </> : null}
          {aiWorkspace && selected?.lifecycleStatus === "ACTIVE" ? <button type="button" className="secondary-action"
            onClick={() => void discussEntity()} disabled={entityDirty || busy !== null}><MessageSquareText size={14} />继续讨论这个实体</button> : null}
          {selected ? <EntityChapters key={selected.id} projectId={selected.projectId} entityId={selected.id} /> : null}
          {selected && (entityDirty || remoteChanged) ? <div className="entity-reference-actions">
            {remoteChanged ? <span role="status">实体已有新修订，本地修改仍保留。</span> : null}
            <button type="button" className="secondary-action" disabled={busy !== null} onClick={() => void reloadEntity()}><RotateCcw size={14} />读取最新实体</button>
          </div> : null}
          {editing ? <fieldset className="entity-import-lock" disabled={importBusy} onKeyDown={(event) => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.nativeEvent.isComposing) return;
            event.preventDefault(); event.stopPropagation(); void save();
          }}><div className="entity-form-grid">
            <label>类型<select value={form.entityType} disabled={Boolean(selected) || busy !== null} onChange={(event) => setForm((current) => ({ ...current, entityType: event.target.value as EntityType }))}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>名称<input autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：林澈" /></label>
            <label className="entity-form-wide">描述<textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} rows={5} placeholder="记录稳定设定和使用边界" /></label>
            <details className="entity-form-wide library-advanced"><summary>别名与标签{summaryText || scopeText ? " · 已设置" : ""}</summary>
              <label>别名<input value={summaryText} onChange={(event) => setSummaryText(event.target.value)} placeholder="多个别名用顿号分隔" /></label>
              <label>标签<input value={scopeText} onChange={(event) => setScopeText(event.target.value)} placeholder="多个标签用顿号分隔" /></label>
            </details>
            <details className="entity-form-wide library-advanced"><summary>高级信息</summary>
              <label>固定属性 JSON<textarea value={form.fixedAttributesJson} onChange={(event) => setForm((current) => ({ ...current, fixedAttributesJson: event.target.value }))} rows={4} spellCheck={false} /></label>
              <label>来源版本<input value={form.sourceVersion ?? ""} onChange={(event) => setForm((current) => ({ ...current, sourceVersion: event.target.value || undefined }))} placeholder="例如：manuscript:2" /></label>
            </details>
          </div>
          <div className="inspector-actions"><span className="library-meta" role="status">{busy === "save" ? "正在保存…" : entityDirty ? "有未保存修改" : "尚无新修改"}</span>
            <button type="button" className="primary-action" onClick={() => void save()} disabled={!form.name.trim() || busy !== null || !project.data || Boolean(form.id) && !entityDirty}><Save size={15} />{busy === "save" ? "保存中…" : selected ? "保存为新修订" : "创建实体"}</button>
            <button type="button" className="secondary-action" disabled={busy !== null} onClick={() => {
              if (entityDirty && !window.confirm("放弃尚未保存的实体修改吗？")) return;
              setEditing(false); setForm({ ...form, id: undefined }); setSavedSignature(entitySignature(form, summaryText, scopeText));
            }}>取消</button></div></fieldset> : null}
          {selected ? <details className="library-advanced"><summary>修订历史 · {revisions.data?.length ?? 0}</summary>{revisions.isError ? <p role="alert">{errorMessage(revisions.error)}<button type="button" onClick={() => void revisions.refetch()}>重试</button></p> : null}
            {revisions.data?.map((revision) => <div className="entity-revision-row" key={revision.id}><span>修订 {revision.revision}</span><span>{revision.name}</span><code>{revision.sourceVersion ?? "无来源版本"}</code>{revision.id === selected.currentRevisionId ? <span className="revision-current"><Check size={13} />当前</span> : null}</div>)}</details> : null}
          </>}
        </div>}
      </div>
      <WorkspacePanel open={showImport} title="从文件导入" onClose={() => {
        if (importInFlight.current || !discardImport()) return;
        setShowImport(false); setError(null);
      }}>
        <fieldset className="entity-import-lock library-form" disabled={importBusy}>
          <div className="entity-form-grid">
            <label>导入类型<select value={importType} onChange={(event) => { if (importItems.length) return; setImportType(event.target.value as EntityType); }} disabled={importItems.length > 0}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>提炼主题<input value={importTopic} onChange={(event) => setImportTopic(event.target.value)} /></label>
            <label>简要概述<input value={importSummary} onChange={(event) => setImportSummary(event.target.value)} /></label>
            <label>适用范围<input value={importScope} onChange={(event) => setImportScope(event.target.value)} /></label>
          </div>
          <div className="entity-import-panel">
            <div className="section-heading"><h2>文件与提炼</h2></div>
            <div className="story-bible-toolbar import-toolbar">
              <AiModelNote taskLabel="知识提炼" taskKey="knowledgeExtraction" profile={extractionProfile} preference={extractionPreference} />
              <label className="file-picker"><FileUp size={15} />{importFileName || "选择文件"}<input aria-label="导入资料文件" type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readImportFile(file); }} /></label>
              <button type="button" className="primary-action" onClick={() => void extractImportItems()} disabled={!importSourceText || !extractionProfile?.hasSecret || !importTopic.trim() || !importSummary.trim() || !importScope.trim() || importBusy}><FileUp size={15} />{importBusy ? importWriting ? "写入中…" : "读取或提炼中…" : extractionFailed ? "重试提炼" : "按主题提炼"}</button>
            </div>
            <label className="entity-import-guidance"><span>补充提炼意见（可选）</span><textarea rows={2} value={importGuidance} onChange={(event) => setImportGuidance(event.target.value)} placeholder="例如：优先提炼力量来源、使用代价和限制，忽略外貌与日常习惯" /></label>
          </div>
          {importItems.length ? <div className="import-review-panel" aria-label="导入候选审核">
            <div className="section-heading"><h2>候选审核</h2><span>{importItems.length} 条待确认</span></div>
            <div className="import-preview">{importItems.map((item, index) => <div className="import-candidate" key={index}><div className="import-candidate-index">{index + 1}</div><label>名称<input value={item.name} onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, name: event.target.value } : current))} /></label><label className="import-candidate-description">描述<textarea value={item.description} rows={3} onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, description: event.target.value } : current))} /></label></div>)}</div>
            <div className="inspector-actions"><button type="button" className="primary-action" onClick={() => void importEntities()} disabled={importBusy || busy !== null || !project.data}><Check size={15} />确认写入 {importItems.length} 条</button></div>
          </div> : null}
        </fieldset>
        {error && showImport ? <p className="project-error" role="alert">{error}</p> : null}
        {notice && showImport ? <p className="project-notice" role="status">{notice}</p> : null}
      </WorkspacePanel>
    </section>
  );
}
