import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, Plus, RotateCcw, Save, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  errorMessage,
  listEntities,
  listEntityRevisions,
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"ALL" | EntityType>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "ARCHIVED">("ACTIVE");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<EntityInput>(emptyForm);
  const [aliasesText, setAliasesText] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      const revision = revisions.data?.find((item) => item.id === entity.currentRevisionId);
      return revision?.name.toLocaleLowerCase().includes(query) ?? false;
    });
  }, [entities.data, revisions.data, search, statusFilter, typeFilter]);

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
    setAliasesText(revision.aliases.join("、"));
    setTagsText(revision.tags.join("、"));
  }, [revisions.data, selected]);

  function startNew() {
    setSelectedId(null);
    setForm(emptyForm);
    setAliasesText("");
    setTagsText("");
    setError(null);
  }

  function selectEntity(entity: Entity) {
    setSelectedId(entity.id);
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) return;
    setError(null);
    const input: EntityInput = {
      ...form,
      name: form.name.trim(),
      aliases: aliasesText.split(/[、,，]/).map((value) => value.trim()).filter(Boolean),
      tags: tagsText.split(/[、,，]/).map((value) => value.trim()).filter(Boolean),
    };
    try {
      const saved = await upsertEntity(input);
      setSelectedId(saved.id);
      await client.invalidateQueries({ queryKey: ["entities", true] });
      await client.invalidateQueries({ queryKey: ["entity-revisions", saved.id] });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function toggleArchive() {
    if (!selected) return;
    setError(null);
    try {
      await setEntityArchived({ id: selected.id, archived: selected.lifecycleStatus === "ACTIVE", expectedVersion: selected.version });
      await client.invalidateQueries({ queryKey: ["entities", true] });
    } catch (cause) {
      setError(errorMessage(cause));
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
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}

      <div className="story-bible-layout">
        <aside className="story-bible-list" aria-label="实体列表">
          <div className="section-heading"><h2>实体库</h2><span>{filtered.length} / {entities.data?.length ?? 0}</span></div>
          {entities.isPending ? <p className="plan-empty">正在加载实体…</p> : null}
          {entities.isError ? <p className="project-error" role="alert">无法加载实体：{errorMessage(entities.error)}</p> : null}
          {!entities.isPending && filtered.length === 0 ? <p className="plan-empty">没有符合条件的实体。</p> : null}
          {filtered.map((entity) => (
            <button type="button" key={entity.id} className="entity-row" data-selected={selectedId === entity.id || undefined} data-archived={entity.lifecycleStatus === "ARCHIVED" || undefined} onClick={() => selectEntity(entity)}>
              <span className="entity-type-badge">{typeLabels[entity.entityType]}</span><span className="entity-row-name">{revisions.data?.find((item) => item.id === entity.currentRevisionId)?.name ?? "未命名实体"}</span><span className="entity-version">v{entity.version}</span>
            </button>
          ))}
        </aside>

        <div className="story-bible-editor">
          <div className="section-heading"><h2>{selected ? "实体详情" : "新建实体"}</h2>{selected ? <span>版本 {selected.version}</span> : <span>尚未保存</span>}</div>
          <div className="entity-form-grid">
            <label>类型<select value={form.entityType} onChange={(event) => setForm((current) => ({ ...current, entityType: event.target.value as EntityType }))}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>名称<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：林澈" /></label>
            <label>别名<input value={aliasesText} onChange={(event) => setAliasesText(event.target.value)} placeholder="用顿号分隔" /></label>
            <label>标签<input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="用顿号分隔" /></label>
            <label className="entity-form-wide">描述<textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} rows={5} placeholder="记录稳定设定和使用边界" /></label>
            <label className="entity-form-wide">固定属性 JSON<textarea value={form.fixedAttributesJson} onChange={(event) => setForm((current) => ({ ...current, fixedAttributesJson: event.target.value }))} rows={4} spellCheck={false} /></label>
            <label className="entity-form-wide">来源版本<input value={form.sourceVersion ?? ""} onChange={(event) => setForm((current) => ({ ...current, sourceVersion: event.target.value || undefined }))} placeholder="例如：manuscript:2" /></label>
          </div>
          <div className="inspector-actions"><button type="button" className="primary-action" onClick={() => void save()} disabled={!form.name.trim()}><Save size={15} />{selected ? "保存为新修订" : "创建实体"}</button>{selected ? <button type="button" className="secondary-action" onClick={() => void toggleArchive()}>{selected.lifecycleStatus === "ACTIVE" ? <Archive size={15} /> : <RotateCcw size={15} />}{selected.lifecycleStatus === "ACTIVE" ? "归档实体" : "恢复实体"}</button> : null}</div>

          {selected ? <div className="entity-revisions"><div className="section-heading"><h2>修订历史</h2><span>{revisions.data?.length ?? 0} 条</span></div>{revisions.data?.map((revision) => <div className="entity-revision-row" key={revision.id}><span>修订 {revision.revision}</span><span>{revision.name}</span><code>{revision.sourceVersion ?? "无来源版本"}</code>{revision.id === selected.currentRevisionId ? <span className="revision-current"><Check size={13} />当前</span> : null}</div>)}</div> : <div className="entity-form-hint">保存后会生成第一个实体修订，后续编辑不会覆盖历史版本。</div>}
        </div>
      </div>
    </section>
  );
}
