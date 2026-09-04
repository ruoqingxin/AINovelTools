import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, FileUp, Plus, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  errorMessage,
  extractEntitiesFromText,
  listEntities,
  listEntityRevisions,
  listModelProfiles,
  setEntityArchived,
  upsertEntity,
  type Entity,
  type EntityInput,
  type EntityType,
} from "../lib/tauri-client";

const typeLabels: Record<EntityType, string> = {
  CHARACTER: "人物",
  LOCATION: "地点",
  FACTION: "阵营",
  ITEM: "物品",
  CONCEPT: "概念",
};

const emptyForm: EntityInput = {
  entityType: "CHARACTER",
  name: "",
  aliases: [],
  description: "",
  fixedAttributesJson: "{}",
  tags: [],
};

export function StoryBibleView() {
  const client = useQueryClient();
  const entities = useQuery({ queryKey: ["entities", true], queryFn: () => listEntities(true) });
  const entityRevisionQueries = useQueries({
    queries: (entities.data ?? []).map((entity) => ({
      queryKey: ["entity-revisions", entity.id],
      queryFn: () => listEntityRevisions(entity.id),
    })),
  });
  const currentRevisionByEntity = useMemo(
    () =>
      new Map(
        (entities.data ?? []).map((entity, index) => [
          entity.id,
          entityRevisionQueries[index]?.data?.find((revision) => revision.id === entity.currentRevisionId) ??
            entityRevisionQueries[index]?.data?.[0],
        ]),
      ),
    [entities.data, entityRevisionQueries],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"ALL" | EntityType>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "ARCHIVED">("ACTIVE");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<EntityInput>(emptyForm);
  const [summaryText, setSummaryText] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "archive" | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importItems, setImportItems] = useState<Array<{ name: string; description: string; aliases: string[]; tags: string[] }>>([]);
  const [importSourceText, setImportSourceText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const modelProfiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const chatProfiles = (modelProfiles.data ?? []).filter((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const [importProfileId, setImportProfileId] = useState("");
  const selected = entities.data?.find((entity) => entity.id === selectedId) ?? null;
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
      return revision?.name.toLocaleLowerCase().includes(query) ?? false;
    });
  }, [currentRevisionByEntity, entities.data, search, statusFilter, typeFilter]);

  useEffect(() => {
    if (!selected) return;
    const revision = revisions.data?.find((item) => item.id === selected.currentRevisionId) ?? revisions.data?.[0];
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
  }, [revisions.data, selected]);

  function startNew() {
    setSelectedId(null);
    setForm(emptyForm);
    setSummaryText("");
    setScopeText("");
    setError(null);
    setNotice(null);
  }

  function selectEntity(entity: Entity) {
    setSelectedId(entity.id);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!form.name.trim()) return;
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
      setSelectedId(saved.id);
      await client.invalidateQueries({ queryKey: ["entities", true] });
      await client.invalidateQueries({ queryKey: ["entity-revisions", saved.id] });
      setNotice("已保存为新修订");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      setError(code === "VERSION_CONFLICT" ? "实体已被其他操作更新，请重新载入后再保存。" : errorMessage(cause));
    } finally {
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
      await client.invalidateQueries({ queryKey: ["entities", true] });
      setNotice(selected.lifecycleStatus === "ACTIVE" ? "实体已归档" : "实体已恢复");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      setError(code === "VERSION_CONFLICT" ? "实体版本已变化，请重新载入后再操作。" : errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function removeEntity() {
    if (!selected || busy) return;
    if (!window.confirm(`确定删除“${currentRevisionByEntity.get(selected.id)?.name ?? "此实体"}”吗？删除后可在“全部状态”中恢复。`)) return;
    setError(null); setNotice(null); setBusy("archive");
    try {
      await setEntityArchived({ id: selected.id, archived: true, expectedVersion: selected.version });
      await client.invalidateQueries({ queryKey: ["entities", true] });
      setSelectedId(null); setForm(emptyForm); setSummaryText(""); setScopeText("");
      setNotice("实体已删除（已移入归档，可恢复）");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function readImportFile(file: File) {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      setImportSourceText(text);
      setImportFileName(file.name);
      setImportItems([]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function extractImportItems() {
    if (!importSourceText || importBusy) return;
    if (!importProfileId) { setError("请先在设置中配置并选择一个聊天模型"); return; }
    setImportBusy(true); setError(null); setNotice(null);
    try {
      if (!form.name.trim() || !summaryText.trim() || !scopeText.trim()) { setError("AI 提炼前必须填写类型、名称、简要概述和适用范围"); return; }
      const items = await extractEntitiesFromText(importProfileId, form.entityType, form.name.trim(), summaryText.trim(), scopeText.trim(), importSourceText);
      setImportItems(items.slice(0, 200));
      if (!items.length) setError("AI 没有提炼出符合主题的信息，请换一个主题或重试。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setImportBusy(false); }
  }

  async function importEntities() {
    if (!importItems.length || importBusy) return;
    setImportBusy(true);
    setError(null);
    try {
      for (const item of importItems) {
        await upsertEntity({ ...emptyForm, entityType: form.entityType, name: item.name, aliases: item.aliases, tags: item.tags, description: item.description, sourceVersion: importFileName });
      }
      await client.invalidateQueries({ queryKey: ["entities", true] });
      setNotice(`已从“${importFileName}”导入 ${importItems.length} 条${typeLabels[form.entityType]}信息`);
      setImportItems([]);
      setImportSourceText("");
      setImportFileName("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <section className="story-bible-view">
      <div className="workspace-heading">
        <p className="eyebrow">知识工作区</p>
        <h1>Story Bible</h1>
        <p className="workspace-lede">管理人物、地点、阵营、物品和概念。每次保存都会留下可追溯的实体修订。</p>
      </div>

      <div className="story-bible-toolbar">
        <label className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索实体名称" aria-label="搜索实体" /></label>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "ALL" | EntityType)} aria-label="实体类型筛选">
          <option value="ALL">全部类型</option>
          {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "ACTIVE" | "ARCHIVED")} aria-label="实体状态筛选">
          <option value="ACTIVE">仅显示活动</option><option value="ALL">全部状态</option><option value="ARCHIVED">仅显示归档</option>
        </select>
        <button type="button" className="primary-action" onClick={startNew}><Plus size={15} />新建实体</button>
        <a href="/knowledge/records" className="secondary-action">知识记录</a>
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {notice ? <p className="project-notice" role="status">{notice}</p> : null}

      <div className="story-bible-layout">
        <aside className="story-bible-list" aria-label="实体列表">
          <div className="section-heading"><h2>实体库</h2><span>{filtered.length} / {entities.data?.length ?? 0}</span></div>
          {entities.isPending ? <p className="plan-empty">正在加载实体…</p> : null}
          {entities.isError ? <p className="project-error" role="alert">无法加载实体：{errorMessage(entities.error)}</p> : null}
          {!entities.isPending && filtered.length === 0 ? <p className="plan-empty">没有符合条件的实体。</p> : null}
          {filtered.map((entity) => (
            <button type="button" key={entity.id} className="entity-row" data-selected={selectedId === entity.id || undefined} data-archived={entity.lifecycleStatus === "ARCHIVED" || undefined} onClick={() => selectEntity(entity)}>
              <span className="entity-type-badge">{typeLabels[entity.entityType]}</span><span className="entity-row-name">{currentRevisionByEntity.get(entity.id)?.name ?? "未命名实体"}</span><span className="entity-version">v{entity.version}</span>
            </button>
          ))}
        </aside>

        <div className="story-bible-editor">
          <div className="section-heading"><h2>{selected ? "实体详情" : "新建实体"}</h2>{selected ? <span>版本 {selected.version}</span> : <span>尚未保存</span>}</div>
          {!selected ? <div className="knowledge-import-panel entity-import-panel">
            <div className="section-heading"><h2>从文件批量导入</h2><span>主题跟随“类型”</span></div>
            <div className="story-bible-toolbar import-toolbar">
              <label>AI 模型<select value={importProfileId} onChange={(event) => setImportProfileId(event.target.value)}><option value="">选择聊天模型</option>{chatProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelId}</option>)}</select></label>
              <label className="file-picker"><FileUp size={15} />{importFileName || "选择 TXT / Markdown 文件"}<input type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readImportFile(file); }} /></label>
              <button type="button" className="primary-action" onClick={() => void extractImportItems()} disabled={!importSourceText || !importProfileId || !form.name.trim() || !summaryText.trim() || !scopeText.trim() || importBusy}><FileUp size={15} />{importBusy ? "AI 提炼中…" : "按四项条件提炼"}</button>
              <button type="button" className="secondary-action" onClick={() => void importEntities()} disabled={!importItems.length || importBusy}>确认写入 {importItems.length || ""}</button>
            </div>
            {importItems.length ? <div className="import-preview" aria-label="导入预览"><p className="entity-form-hint">以下是 AI 候选内容，可直接修改；确认后才会进入正式知识库。</p>{importItems.map((item, index) => <div key={`${item.name}-${index}`}><input value={item.name} aria-label={`候选名称 ${index + 1}`} onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, name: event.target.value } : current))} /><textarea value={item.description} aria-label={`候选描述 ${index + 1}`} rows={2} onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, description: event.target.value } : current))} /></div>)}</div> : null}
          </div> : null}
          <div className="entity-form-grid">
            <label>类型<select value={form.entityType} onChange={(event) => setForm((current) => ({ ...current, entityType: event.target.value as EntityType }))}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>名称<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：林澈" /></label>
            <label>简要概述<input value={summaryText} onChange={(event) => setSummaryText(event.target.value)} placeholder="例如：本书人物的力量体系" /></label>
            <label>适用范围<input value={scopeText} onChange={(event) => setScopeText(event.target.value)} placeholder="例如：本书所有人物" /></label>
            <label className="entity-form-wide">描述<textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} rows={5} placeholder="记录稳定设定和使用边界" /></label>
            <label className="entity-form-wide">固定属性 JSON<textarea value={form.fixedAttributesJson} onChange={(event) => setForm((current) => ({ ...current, fixedAttributesJson: event.target.value }))} rows={4} spellCheck={false} /></label>
            <label className="entity-form-wide">来源版本<input value={form.sourceVersion ?? ""} onChange={(event) => setForm((current) => ({ ...current, sourceVersion: event.target.value || undefined }))} placeholder="例如：manuscript:2" /></label>
          </div>
          <div className="inspector-actions"><button type="button" className="primary-action" onClick={() => void save()} disabled={!form.name.trim() || busy !== null}><Save size={15} />{busy === "save" ? "保存中…" : selected ? "保存为新修订" : "创建实体"}</button>{selected ? <><button type="button" className="secondary-action" onClick={() => void toggleArchive()} disabled={busy !== null}>{selected.lifecycleStatus === "ACTIVE" ? <Archive size={15} /> : <RotateCcw size={15} />}{busy === "archive" ? "处理中…" : selected.lifecycleStatus === "ACTIVE" ? "归档实体" : "恢复实体"}</button>{selected.lifecycleStatus === "ACTIVE" ? <button type="button" className="danger-action" onClick={() => void removeEntity()} disabled={busy !== null}><Trash2 size={14} />删除实体</button> : null}</> : null}</div>

          {selected ? <div className="entity-revisions"><div className="section-heading"><h2>修订历史</h2><span>{revisions.isPending ? "加载中…" : `${revisions.data?.length ?? 0} 条`}</span></div>{revisions.data?.map((revision) => <div className="entity-revision-row" key={revision.id}><span>修订 {revision.revision}</span><span>{revision.name}</span><span className={revision.sourceVersion ? "revision-source" : "revision-source revision-source-missing"}>{revision.sourceVersion ? "已有来源" : "暂无来源"}</span><code>{revision.sourceVersion ?? "无来源版本"}</code>{revision.id === selected.currentRevisionId ? <span className="revision-current"><Check size={13} />当前</span> : null}</div>)}</div> : <div className="entity-form-hint">保存后会生成第一个实体修订，后续编辑不会覆盖历史版本。</div>}
        </div>
      </div>
    </section>
  );
}
