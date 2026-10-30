import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileUp, FolderInput, GitMerge, ListChecks, LoaderCircle, MessageSquareText, Pencil, Plus, Power, RotateCcw, Save, SearchX, Trash2, Undo2, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { classifyAiFailure } from "../lib/ai-failure";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  errorMessage,
  createDiscussionSession,
  deleteEntities,
  extractEntitiesFromText,
  getCurrentProject,
  importEntities as importEntityBatch,
  previewEntityImport,
  applyEntityImport,
  listEntityCards,
  listEntityRevisions,
  listModelProfiles,
  moveEntities,
  previewEntityDeletion,
  setEntityArchived,
  upsertEntity,
  type Entity,
  type EntityInput,
  type EntityType,
  type EntityImportPreview,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";
import { KnowledgeSectionNav } from "./knowledge-section-nav";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { sourceReturnTo } from "../lib/manuscript-source";
import { EntityChapters } from "./entity-chapters";
import { EntityImportDestination } from "./entity-import-destination";
import { useWideWorkspace, WorkspacePanel } from "./workspace-panel";
import "./library-workspace.css";
import { SearchField } from "./search-field";
import { entityIdentity, entityTypeLabels } from "../lib/content-taxonomy";
import { AiWorkspaceLink, ContentTypeLabel, useInAiWorkspace } from "./content-identity";
import { WorkspaceLink } from "./workspace-link";
import { WorkspaceEmptyState } from "./workspace-empty-state";
import { findImportDuplicates, mergeImportCandidates, type ImportCandidate } from "../lib/entity-import-review";
import { parseAttributes } from "../lib/entity-attributes";
import { EntityAttributesDisplay, EntityAttributesEditor } from "./entity-attributes-editor";

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
  const confirmAction = useConfirmAction();
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
  const [sourceFilter, setSourceFilter] = useState("*");
  const [tagFilter, setTagFilter] = useState("");
  const [groupBy, setGroupBy] = useState<"TYPE" | "SOURCE" | "NONE">("TYPE");
  const [sortBy, setSortBy] = useState<"UPDATED" | "NAME">("UPDATED");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(aiWorkspace && params.get("action") === "new");
  const wide = useWideWorkspace(851);
  const [detailOpen, setDetailOpen] = useState(requestedEntity !== null || editing);
  const list = useRef<HTMLElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const listPosition = useRef({ list: 0, workspace: 0 });
  const [showImport, setShowImport] = useState(aiWorkspace && params.get("action") === "import");
  const [importType, setImportType] = useState<EntityType>("CHARACTER");
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelection, setBatchSelection] = useState<Record<string, number>>({});
  const [moveTargetType, setMoveTargetType] = useState<EntityType>("CHARACTER");
  const [form, setForm] = useState<EntityInput>(emptyForm);
  const [summaryText, setSummaryText] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [savedSignature, setSavedSignature] = useState(() => entitySignature(emptyForm, "", ""));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "archive" | "reload" | "delete" | "move" | null>(null);
  const deletionInFlight = useRef(false);
  const movementInFlight = useRef(false);
  const saveInFlight = useRef(false);
  const [importFileName, setImportFileName] = useState("");
  const [importItems, setImportItems] = useState<ImportCandidate[]>([]);
  const [mergePrimary, setMergePrimary] = useState(0);
  const [mergeUndo, setMergeUndo] = useState<ImportCandidate[] | null>(null);
  const [importSourceText, setImportSourceText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importWriting, setImportWriting] = useState(false);
  const [importProgress, setImportProgress] = useState("正在核对，尚未写入");
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<EntityImportPreview[] | null>(null);
  const importPreviewDecision = useRef<((confirmed: boolean) => void) | null>(null);
  const importInFlight = useRef(false);
  const [extractionFailed, setExtractionFailed] = useState(false);
  const modelProfiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const extractionProfile = resolveTaskChatProfile(modelProfiles.data, aiPreferences.data, "knowledgeExtraction");
  const extractionPreference = resolveTaskPreference(aiPreferences.data, "knowledgeExtraction");
  const [importGuidance, setImportGuidance] = useState("");
  const selectedImportItems = importItems.filter((item) => item.selected);
  const canImport = cards.isSuccess && selectedImportItems.length > 0 && selectedImportItems.length <= 200 && selectedImportItems.every((item) => item.name.trim());
  const importDuplicates = useMemo(() => findImportDuplicates(importItems, cards.data ?? []), [importItems, cards.data]);
  const primaryIndex = importItems[mergePrimary]?.selected ? mergePrimary : importItems.findIndex((item) => item.selected);
  const canMerge = selectedImportItems.length >= 2 && selectedImportItems.every((item) => item.name.trim()
    && item.entityType === selectedImportItems[0].entityType
    && JSON.stringify(item.mergeTarget) === JSON.stringify(selectedImportItems[0].mergeTarget));
  const selected = entities.data?.find((entity) => entity.id === selectedId) ?? null;
  const entityDirty = entitySignature(form, summaryText, scopeText) !== savedSignature;
  const remoteChanged = selected && form.id === selected.id && form.expectedVersion !== selected.version;
  const revisions = useQuery({
    queryKey: ["entity-revisions", selectedId],
    queryFn: () => listEntityRevisions(selectedId!),
    enabled: Boolean(selectedId),
  });
  useEffect(() => () => { importPreviewDecision.current?.(false); }, []);

  function decideImportPreview(confirmed: boolean) {
    setImportPreview(null);
    importPreviewDecision.current?.(confirmed);
    importPreviewDecision.current = null;
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (entities.data ?? []).filter((entity) => {
      if (typeFilter !== "ALL" && entity.entityType !== typeFilter) return false;
      if (statusFilter !== "ALL" && entity.lifecycleStatus !== statusFilter) return false;
      const revision = currentRevisionByEntity.get(entity.id);
      if (sourceFilter !== "*" && (revision?.sourceVersion?.trim() || "") !== sourceFilter.slice(1)) return false;
      if (tagFilter && !revision?.tags.includes(tagFilter)) return false;
      if (!query) return true;
      return revision ? [revision.name, ...revision.aliases, ...revision.tags, revision.description]
        .some((value) => value.toLocaleLowerCase().includes(query)) : false;
    }).sort((a, b) => sortBy === "NAME"
      ? (currentRevisionByEntity.get(a.id)?.name ?? "").localeCompare(currentRevisionByEntity.get(b.id)?.name ?? "", "zh-CN")
      : b.updatedAt.localeCompare(a.updatedAt));
  }, [currentRevisionByEntity, entities.data, search, statusFilter, typeFilter, sourceFilter, tagFilter, sortBy]);

  const facets = useMemo(() => {
    const sources = new Map<string, number>();
    const tags = new Map<string, number>();
    for (const card of cards.data ?? []) {
      const source = card.revision.sourceVersion?.trim() || "";
      sources.set(source, (sources.get(source) ?? 0) + 1);
      for (const tag of new Set(card.revision.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    return {
      sources: [...sources].sort(([a], [b]) => a.localeCompare(b, "zh-CN")),
      tags: [...tags].sort(([a], [b]) => a.localeCompare(b, "zh-CN")),
    };
  }, [cards.data]);
  const groups = useMemo(() => {
    const result = new Map<string, { label: string; entities: Entity[] }>();
    for (const entity of filtered) {
      const source = currentRevisionByEntity.get(entity.id)?.sourceVersion?.trim() || "";
      const key = groupBy === "TYPE" ? entity.entityType : groupBy === "SOURCE" ? source : "*";
      const group = result.get(key) ?? { label: groupBy === "TYPE" ? typeLabels[entity.entityType] : source || "未标注来源", entities: [] };
      group.entities.push(entity);
      result.set(key, group);
    }
    return [...result].map(([key, group]) => ({ key, ...group }));
  }, [filtered, groupBy, currentRevisionByEntity]);
  const allCollapsed = groups.length > 0 && groups.every((group) => collapsedGroups.has(group.key));
  const visibleEntities = groups.filter((group) => groupBy === "NONE" || !collapsedGroups.has(group.key)).flatMap((group) => group.entities);

  const batchCount = Object.keys(batchSelection).length;
  useEffect(() => {
    setBatchSelection({});
    setCollapsedGroups(new Set());
  }, [search, typeFilter, statusFilter, sourceFilter, tagFilter, groupBy]);

  function toggleGroup(key: string, ids: string[]) {
    const collapsing = !collapsedGroups.has(key);
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (collapsing) next.add(key); else next.delete(key);
      return next;
    });
    if (collapsing) setBatchSelection((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
  }

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

  useEffect(() => {
    if (!wide && detailOpen) {
      detail.current?.scrollIntoView?.({ block: "start" });
      if (!editing) detail.current?.focus({ preventScroll: true });
    }
  }, [wide, detailOpen, editing]);

  function openDetail() {
    if (!detailOpen) {
      listPosition.current = { list: list.current?.scrollTop ?? 0, workspace: document.querySelector(".workspace")?.scrollTop ?? 0 };
    }
    setDetailOpen(true);
  }

  function resetEditor() {
    setEditing(false);
    setForm({ ...form, id: undefined });
    setSavedSignature(entitySignature(form, summaryText, scopeText));
  }

  function restoreList() {
    setDetailOpen(false);
    window.requestAnimationFrame(() => {
      if (list.current) list.current.scrollTop = listPosition.current.list;
      const workspace = document.querySelector(".workspace");
      if (workspace) workspace.scrollTop = listPosition.current.workspace;
      const selectedButton = list.current?.querySelector<HTMLButtonElement>('[data-selected="true"]');
      (selectedButton ?? document.querySelector<HTMLInputElement>('input[aria-label="搜索实体"]'))?.focus({ preventScroll: true });
    });
  }

  function returnToList() {
    if (busy || importWriting || editing && entityDirty && !window.confirm("放弃尚未保存的实体修改并返回列表吗？")) return;
    setShowImport(false);
    resetEditor();
    setTargetResolved(true);
    setTargetError(null);
    setError(null);
    setNotice(null);
    restoreList();
  }

  function cancelEditing() {
    if (busy || importWriting || entityDirty && !window.confirm("放弃尚未保存的实体修改吗？")) return;
    resetEditor();
    if (!selectedId) restoreList();
  }

  async function refreshEntities(id?: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["entity-cards"] }),
      client.invalidateQueries({ queryKey: ["entities"] }),
      client.invalidateQueries({ queryKey: ["chapter-entity-references"] }),
      client.invalidateQueries({ queryKey: ["entity-chapters"] }),
      client.invalidateQueries({ queryKey: ["project-search"] }),
      client.invalidateQueries({ queryKey: ["ai-proposals"] }),
      ...(id ? [client.invalidateQueries({ queryKey: ["entity-revisions", id] })] : []),
    ]);
  }

  async function reloadEntity() {
    if (!selected || busy || importWriting || entityDirty && !window.confirm("放弃本地实体修改并读取最新修订吗？")) return;
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
    if (!selected || entityDirty || importWriting) return;
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
    if (busy || importWriting || entityDirty && !window.confirm("当前实体有未保存修改，确定新建并放弃这些修改吗？")) return;
    setShowImport(false);
    openDetail();
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
    if (busy || importWriting) return;
    if (entity.id === selectedId) { setShowImport(false); openDetail(); return; }
    if (entity.id !== selectedId && entityDirty && !window.confirm("当前实体有未保存修改，确定切换吗？")) return;
    setShowImport(false);
    openDetail();
    setTargetError(null);
    setSelectedId(entity.id);
    setEditing(false);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!project.data || !form.name.trim() || busy || saveInFlight.current || importWriting || form.id && !entityDirty) return;
    try { parseAttributes(form.fixedAttributesJson); }
    catch (cause) { setError((cause as Error).message); return; }
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
    if (!selected || busy || importWriting) return;
    setError(null);
    setNotice(null);
    setBusy("archive");
    try {
      const stopping = selected.lifecycleStatus === "ACTIVE";
      if (!await confirmAction({
        title: stopping ? "停用实体" : "重新启用实体",
        message: stopping
          ? `停用「${form.name}」后，不再进入默认 AI 设定上下文，也不再出现在使用中列表。内容、修订历史和已有章节关联均保留，之后可以重新启用。这不是删除或备份。`
          : `重新启用「${form.name}」后，它将回到使用中列表，并可再次进入默认 AI 设定上下文。`,
        confirmLabel: stopping ? "确认停用" : "确认启用",
      })) return;
      if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== selected.projectId) {
        setError("当前项目已切换，未更改实体状态。");
        return;
      }
      await setEntityArchived({ id: selected.id, archived: selected.lifecycleStatus === "ACTIVE", expectedVersion: selected.version });
      await refreshEntities(selected.id);
      setNotice(stopping ? "实体已停用，内容与关联仍保留" : "实体已重新启用");
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      setError(code === "VERSION_CONFLICT" ? "实体版本已变化，请重新载入后再操作。" : errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function removeEntities(targets: Array<{ id: string; expectedVersion: number }>) {
    if (!project.data || !targets.length || busy || importWriting || editing || deletionInFlight.current) return;
    deletionInFlight.current = true;
    setBusy("delete");
    setError(null);
    setNotice(null);
    const input = { expectedProjectId: project.data.projectId, entities: targets };
    try {
      const preview = await previewEntityDeletion(input);
      const blocked = preview.filter((item) => item.blockers.length);
      if (blocked.length) {
        setError(`以下实体仍被引用，未删除任何条目：${blocked.map((item) => `${item.name}（${item.blockers.join("、")}）`).join("；")}。请解除关联或改用停用。`);
        return;
      }
      if (!await confirmAction({
        title: targets.length === 1 ? "删除实体" : "批量删除实体",
        message: `将永久删除以下 ${preview.length} 个实体及其全部修订历史，此操作不可撤销。\n${preview.map((item) => `「${item.name}」`).join("、")}\n不会删除正文或其他资料。`,
        confirmLabel: `永久删除 ${preview.length} 个实体`,
      })) return;
      if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== input.expectedProjectId) {
        setError("当前项目已切换，未删除任何实体。");
        return;
      }
      await deleteEntities(input);
      const removed = new Set(targets.map((item) => item.id));
      client.setQueryData<typeof cards.data>(["entity-cards", true], (current) => current?.filter((item) => !removed.has(item.entity.id)));
      for (const id of removed) client.removeQueries({ queryKey: ["entity-revisions", id] });
      if (selectedId && removed.has(selectedId)) {
        setSelectedId(null);
        setForm(emptyForm); setSummaryText(""); setScopeText("");
        setSavedSignature(entitySignature(emptyForm, "", ""));
        setDetailOpen(false);
      }
      setBatchSelection({});
      setBatchMode(false);
      await refreshEntities();
      setNotice(`已删除 ${targets.length} 个实体`);
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      if (code === "VERSION_CONFLICT") {
        await refreshEntities();
        setBatchSelection({});
      }
      setError(code === "VERSION_CONFLICT" ? "实体已更新，未删除任何条目。列表已刷新，请重新选择。"
        : errorMessage(cause));
    } finally {
      deletionInFlight.current = false;
      setBusy(null);
    }
  }

  async function moveSelectedEntities(targets: Array<{ id: string; expectedVersion: number }>) {
    if (!project.data || !targets.length || busy || importWriting || editing || movementInFlight.current) return;
    const moving = targets.filter((target) => entities.data?.find((entity) => entity.id === target.id)?.entityType !== moveTargetType);
    if (!moving.length) return;
    const input = { expectedProjectId: project.data.projectId, entityType: moveTargetType, entities: moving };
    movementInFlight.current = true;
    setBusy("move");
    setError(null);
    setNotice(null);
    try {
      if (!await confirmAction({
        title: moving.length === 1 ? "移动实体类型" : "批量移动实体类型",
        message: `将以下 ${moving.length} 个实体移动到「${typeLabels[input.entityType]}」：\n${moving.map((target) => `「${currentRevisionByEntity.get(target.id)?.name ?? target.id}」`).join("、")}\n仅更正分类，保留原实体、全部内容、修订历史和章节关联，不复制或合并实体。`,
        confirmLabel: `移动到${typeLabels[input.entityType]}`,
      })) return;
      if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== input.expectedProjectId) {
        setError("当前项目已切换，未移动任何实体。");
        return;
      }
      const moved = await moveEntities(input);
      const byId = new Map(moved.map((entity) => [entity.id, entity]));
      client.setQueryData<typeof cards.data>(["entity-cards", true], (current) => current?.map((card) => ({
        ...card, entity: byId.get(card.entity.id) ?? card.entity,
      })));
      setBatchSelection({});
      setBatchMode(false);
      await refreshEntities(selectedId ?? undefined);
      setNotice(`已将 ${moved.length} 个实体移动到「${typeLabels[input.entityType]}」`);
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      if (code === "VERSION_CONFLICT") {
        await refreshEntities();
        setBatchSelection({});
      }
      setError(code === "VERSION_CONFLICT" ? "实体已更新，未移动任何条目。列表已刷新，请重新选择。"
        : errorMessage(cause));
    } finally {
      movementInFlight.current = false;
      setBusy(null);
    }
  }

  async function readImportFile(file: File) {
    if (busy || importInFlight.current) return;
    if ((importItems.length || importSourceText) && !window.confirm("替换文件会放弃当前导入候选，确定继续吗？")) return;
    importInFlight.current = true;
    setImportBusy(true);
    setImportError(null);
    setImportNotice(null);
    try {
      const text = await file.text();
      setImportSourceText(text);
      setImportFileName(file.name);
      setImportItems([]);
      setMergeUndo(null);
      setExtractionFailed(false);
    } catch (cause) {
      setImportError(errorMessage(cause));
    } finally {
      importInFlight.current = false;
      setImportBusy(false);
    }
  }

  async function extractImportItems() {
    if (!importSourceText || busy || importInFlight.current) return;
    if (!extractionProfile) { setImportError("请先在设置中配置一个可用的聊天模型"); return; }
    if (importItems.length && !window.confirm("重新提炼会替换当前导入候选，确定继续吗？")) return;
    importInFlight.current = true;
    setImportBusy(true); setImportError(null); setImportNotice(null); setExtractionFailed(false);
    try {
      const items = await extractEntitiesFromText({ profileId: extractionProfile.id, entityType: importType,
        sourceText: importSourceText, userGuidance: importGuidance.trim(),
        temperature: extractionPreference.temperature ?? undefined, maxOutputTokens: extractionPreference.maxOutputTokens ?? undefined });
      const matching = items.filter((item) => item.entityType === importType);
      setImportItems(matching.map((item, index) => ({ ...item, selected: index < 200 })));
      setMergeUndo(null);
      if (matching.length > 200) setImportNotice("单次最多写入 200 条，超出的候选已保留，可整理后分批写入。");
      else if (matching.length < items.length) setImportNotice(`已排除 ${items.length - matching.length} 条类型不符或未标明类型的候选。`);
      if (!matching.length) {
        setExtractionFailed(true);
        setImportError("AI 没有识别出符合所选类型的实体，其他类型不会强行归入本类。请检查文件或调整导入类型后重试。");
      }
    } catch (cause) {
      const detail = errorMessage(cause);
      const failure = classifyAiFailure(detail);
      setExtractionFailed(true);
      setImportError(`知识提炼失败（${failure.label}）：${detail}。${failure.hint}`);
    }
    finally { importInFlight.current = false; setImportBusy(false); }
  }

  async function importEntities() {
    if (!canImport || busy || importInFlight.current || !project.data) return;
    importInFlight.current = true;
    setImportBusy(true);
    setImportWriting(true);
    setImportProgress("正在核对，尚未写入");
    setImportError(null);
    setImportNotice(null);
    const fileName = importFileName;
    const importedType = selectedImportItems[0].entityType;
    const importedLabel = selectedImportItems.every((item) => item.entityType === importedType) ? typeLabels[importedType] : "实体";
    const expectedProjectId = project.data.projectId;
    const items = selectedImportItems.map(({ selected: _selected, mergeTarget: _target, ...item }) => ({
      ...emptyForm, ...item, name: item.name.trim(), sourceVersion: fileName,
    }));
    try {
      const duplicates = importItems.flatMap((item, index) => {
        const match = importDuplicates[index];
        return item.selected && !item.mergeTarget && (match.existing.length || match.candidates.some((other) => importItems[other].selected)) ? [item.name] : [];
      });
      if (duplicates.length) setImportProgress("等待确认，尚未写入");
      if (duplicates.length && !await confirmAction({
        title: "确认创建重名实体",
        message: `以下候选的名称或别名与同类型实体重复：\n${duplicates.map((name) => `「${name}」`).join("、")}\n继续会创建新实体，不会合并或覆盖已有资料。`,
        confirmLabel: "仍然创建新实体",
      })) return;
      if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== expectedProjectId) {
        setImportError("当前项目已切换，未写入任何实体。");
        return;
      }
      if (selectedImportItems.some((item) => item.mergeTarget)) {
        const input = { expectedProjectId, sourceName: fileName, items: selectedImportItems.map((item) => ({
          entityType: item.entityType, name: item.name.trim(), description: item.description,
          aliases: item.aliases, tags: item.tags, target: item.mergeTarget ?? null,
        })) };
        const preview = await previewEntityImport(input);
        const confirmed = await new Promise<boolean>((resolve) => {
          importPreviewDecision.current = resolve;
          setImportProgress("等待确认，尚未写入");
          setImportPreview(preview);
        });
        if (!confirmed) return;
        if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== expectedProjectId) {
          setImportError("当前项目已切换，未写入任何实体。");
          return;
        }
        setImportProgress("正在写入…");
        const receipt = await applyEntityImport(input);
        setImportNotice(`已新建 ${receipt.created.length} 个实体，合并补充 ${receipt.merged.length} 个已有实体`);
        await Promise.all(receipt.merged.map((entity) => client.invalidateQueries({ queryKey: ["entity-revisions", entity.id] })));
      } else {
        setImportProgress("正在写入…");
        const saved = await importEntityBatch({ expectedProjectId, items });
        setImportNotice(`已从“${fileName}”导入 ${saved.length} 条${importedLabel}信息`);
      }
      setImportItems((current) => current.filter((item) => !item.selected));
      setMergeUndo(null);
      if (selectedImportItems.length === importItems.length) {
        setImportSourceText("");
        setImportFileName("");
      }
      await refreshEntities();
    } catch (cause) {
      setImportError(errorMessage(cause));
    } finally {
      importInFlight.current = false;
      setImportBusy(false);
      setImportWriting(false);
    }
  }

  async function mergeCandidates() {
    if (importInFlight.current || busy || !canMerge) return;
    importInFlight.current = true;
    setImportBusy(true);
    try {
      if (!await confirmAction({
        title: "合并导入候选",
        message: `将 ${selectedImportItems.length} 条候选合并为「${importItems[primaryIndex].name}」。\n${selectedImportItems.map((item) => `「${item.name}」`).join("、")}\n原描述会按原名称分段保留，别名和标签汇总；尚未写入实体库。`,
        confirmLabel: `合并为 1 条候选`,
      })) return;
      setMergeUndo(importItems);
      setImportItems(mergeImportCandidates(importItems, primaryIndex));
      setMergePrimary(0);
    } finally {
      importInFlight.current = false;
      setImportBusy(false);
    }
  }

  async function undoMerge() {
    if (!mergeUndo || importInFlight.current || busy) return;
    importInFlight.current = true;
    setImportBusy(true);
    try {
      if (!await confirmAction({
        title: "撤销候选合并",
        message: "将恢复最近一次合并前的全部候选和勾选状态。合并后的候选修改将被放弃。",
        confirmLabel: "恢复合并前候选",
      })) return;
      setImportItems(mergeUndo);
      setMergeUndo(null);
    } finally {
      importInFlight.current = false;
      setImportBusy(false);
    }
  }

  function discardImport() {
    if (importInFlight.current) return false;
    if ((importItems.length || importSourceText) && !window.confirm("当前文件和导入候选尚未写入，确定放弃本次导入吗？")) return false;
    setImportItems([]);
    setMergeUndo(null);
    setImportSourceText("");
    setImportFileName("");
    setImportError(null);
    setImportNotice(null);
    setExtractionFailed(false);
    return true;
  }

  const emptyCollection = wide && entities.isSuccess && !filtered.length && !selectedId && !editing && targetResolved && !targetError;
  const filteredEmpty = emptyCollection && Boolean(entities.data?.length || search.trim() || typeFilter !== "ALL" || statusFilter === "ARCHIVED" || sourceFilter !== "*" || tagFilter);
  function resetFilters() { setSearch(""); setTypeFilter("ALL"); setStatusFilter("ALL"); setSourceFilter("*"); setTagFilter(""); }

  return (
    <section className="story-bible-view library-workspace" data-mobile-detail={!wide && detailOpen}>
      {!aiWorkspace && <div className="workspace-heading">
        <h1>资料</h1>
      </div>}
      <KnowledgeSectionNav />
      {!aiWorkspace && returnTo ? <WorkspaceLink className="secondary-action" href={returnTo}>返回来源</WorkspaceLink> : null}
      {targetError ? <p className="project-error" role="alert">{targetError}</p> : null}

      <div className="library-toolbar" hidden={!wide && detailOpen}>
        <SearchField label="搜索实体" value={search} onChange={setSearch} placeholder="搜索名称、别名或描述" />
        <select value={typeFilter} disabled={busy === "delete"} onChange={(event) => setTypeFilter(event.target.value as "ALL" | EntityType)} aria-label="实体类型筛选">
          <option value="ALL">全部类型</option>
          {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={statusFilter} disabled={busy === "delete"} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "ACTIVE" | "ARCHIVED")} aria-label="实体状态筛选">
          <option value="ACTIVE">仅显示使用中</option><option value="ALL">全部状态</option><option value="ARCHIVED">仅显示已停用</option>
        </select>
        {!aiWorkspace && project.data ? <>
          <AiWorkspaceLink icon={FileUp} title="在共创中从文件提取设定" target={{ projectId: project.data.projectId, workflow: "entity", action: "import" }}>提取设定</AiWorkspaceLink>
          <AiWorkspaceLink icon={Plus} title="在共创中新建设定" target={{ projectId: project.data.projectId, workflow: "entity", action: "new" }}>新建设定</AiWorkspaceLink>
        </> : null}
        {aiWorkspace && <button type="button" className="secondary-action" disabled={batchMode || importWriting || busy !== null} onClick={() => {
          if (editing && entityDirty && !window.confirm("放弃当前实体修改并打开文件导入吗？")) return;
          setEditing(false); setForm(emptyForm); setSummaryText(""); setScopeText(""); setSavedSignature(entitySignature(emptyForm, "", ""));
          setShowImport(true);
        }}>{importBusy ? <LoaderCircle size={15} className="spin" /> : <FileUp size={15} />}{importBusy ? "查看导入进度" : importItems.length ? `审核导入候选（${importItems.length}）` : extractionFailed ? "查看提炼失败" : "从文件导入"}</button>}
        {aiWorkspace && <button type="button" className="primary-action" disabled={batchMode || importWriting || busy !== null || !project.data} onClick={startNew}><Plus size={15} />新建实体</button>}
      </div>
      {error && !showImport ? <p className="project-error" role="alert">{error}</p> : null}
      {notice && !showImport ? <p className="project-notice" role="status">{notice === "已保存为新修订" && entityDirty
        ? "上一版已保存，当前仍有未保存修改。" : notice}</p> : null}
      {project.isError ? <p className="project-error" role="alert">{errorMessage(project.error)}
        <button type="button" className="secondary-action" disabled={project.isFetching} onClick={() => void project.refetch()}>重试</button></p> : null}

      <div className="entity-library-filters" hidden={!wide && detailOpen}>
        <label>来源<select aria-label="实体来源筛选" value={sourceFilter} disabled={busy === "delete"} onChange={(event) => setSourceFilter(event.target.value)}>
          <option value="*">全部来源</option>
          {facets.sources.map(([source, count]) => <option value={`:${source}`} key={source}>{source || "未标注来源"}（{count}）</option>)}
        </select></label>
        <label>标签<select aria-label="实体标签筛选" value={tagFilter} disabled={busy === "delete"} onChange={(event) => setTagFilter(event.target.value)}>
          <option value="">全部标签</option>
          {facets.tags.map(([tag, count]) => <option value={tag} key={tag}>{tag}（{count}）</option>)}
        </select></label>
        <label>分组<select aria-label="实体分组" value={groupBy} disabled={busy === "delete"} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}>
          <option value="TYPE">按类型</option><option value="SOURCE">按来源</option><option value="NONE">不分组</option>
        </select></label>
        <label>排序<select aria-label="实体排序" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
          <option value="UPDATED">最近更新</option><option value="NAME">名称</option>
        </select></label>
        {search || typeFilter !== "ALL" || statusFilter !== "ACTIVE" || sourceFilter !== "*" || tagFilter ? <button type="button" className="secondary-action"
          title="清除筛选条件" aria-label="清除筛选条件" disabled={busy === "delete"} onClick={resetFilters}><RotateCcw size={14} /></button> : null}
      </div>
      <div className="library-layout" data-empty={emptyCollection}>
        <aside ref={list} hidden={emptyCollection || !wide && detailOpen} className="library-list" aria-label="实体列表">
          <div className="section-heading"><h2>实体库</h2><span>{filtered.length} / {entities.data?.length ?? 0}</span>
            {groupBy !== "NONE" && groups.length ? <button type="button" className="icon-command" title={allCollapsed ? "展开全部分组" : "折叠全部分组"}
              aria-label={allCollapsed ? "展开全部分组" : "折叠全部分组"} disabled={busy === "delete"} onClick={() => {
                setCollapsedGroups(allCollapsed ? new Set() : new Set(groups.map((group) => group.key)));
                setBatchSelection({});
              }}>{allCollapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}</button> : null}
            {aiWorkspace && Boolean(entities.data?.length) ? <button type="button" className="icon-command"
              aria-label={batchMode ? "退出批量管理" : "批量管理实体"} title={batchMode ? "退出批量管理" : "批量管理实体"}
              disabled={busy !== null || importWriting || editing} aria-pressed={batchMode}
              onClick={() => { setBatchMode(!batchMode); setBatchSelection({}); }}>{batchMode ? <X size={16} /> : <ListChecks size={16} />}</button> : null}
          </div>
          {batchMode ? <div className="entity-batch-actions">
            <label><input type="checkbox" aria-label="全选当前实体" title={visibleEntities.length > 200 ? "单次最多选择 200 个实体，请先筛选或逐项选择" : "全选当前展开分组的实体"} disabled={!visibleEntities.length || visibleEntities.length > 200 || busy !== null || importWriting}
              checked={visibleEntities.length > 0 && visibleEntities.every((entity) => entity.id in batchSelection)}
              ref={(element) => { if (element) element.indeterminate = batchCount > 0 && batchCount < visibleEntities.length; }}
              onChange={(event) => setBatchSelection(event.target.checked ? Object.fromEntries(visibleEntities.map((entity) => [entity.id, entity.version])) : {})} />
              已选 {batchCount} / {visibleEntities.length}</label>
            <button type="button" className="secondary-action entity-delete-action" disabled={!batchCount || busy !== null || importWriting}
              onClick={() => void removeEntities(Object.entries(batchSelection).map(([id, expectedVersion]) => ({ id, expectedVersion })))}>
              <Trash2 size={14} />删除所选</button>
            <div className="entity-move-actions">
              <label>移动到类型<select aria-label="批量移动目标类型" value={moveTargetType} disabled={busy !== null || importWriting}
                onChange={(event) => setMoveTargetType(event.target.value as EntityType)}>
                {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              <button type="button" className="secondary-action" disabled={busy !== null || importWriting || !Object.keys(batchSelection).some((id) => entities.data?.find((entity) => entity.id === id)?.entityType !== moveTargetType)}
                onClick={() => void moveSelectedEntities(Object.entries(batchSelection).map(([id, expectedVersion]) => ({ id, expectedVersion })))}>
                <FolderInput size={14} />移动所选</button>
            </div>
          </div> : null}
          {entities.isPending ? <p className="plan-empty">正在加载实体…</p> : null}
          {entities.isError ? <p className="project-error" role="alert">无法加载实体：{errorMessage(entities.error)}
            <button type="button" className="secondary-action" disabled={entities.isFetching} onClick={() => void cards.refetch()}>重试加载</button></p> : null}
          {entities.isSuccess && filtered.length === 0 ? <div className="library-list-empty">
            <p className="plan-empty">{entities.data?.length ? "没有符合条件的实体。" : "暂无人物与世界设定"}</p>
            {search || typeFilter !== "ALL" || statusFilter !== "ACTIVE" || entities.data?.length ? <button type="button" className="secondary-action" onClick={resetFilters}>重置筛选</button> : null}
          </div> : null}
          {groups.map((group) => <div className="entity-list-group" key={group.key}>
            {groupBy !== "NONE" ? <button type="button" className="entity-group-heading" aria-expanded={!collapsedGroups.has(group.key)}
              disabled={busy === "delete"} onClick={() => toggleGroup(group.key, group.entities.map((entity) => entity.id))}>
              {collapsedGroups.has(group.key) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <strong>{group.label}</strong><span>{group.entities.length}</span>
            </button> : null}
          {groupBy === "NONE" || !collapsedGroups.has(group.key) ? group.entities.map((entity) => <div className="entity-list-row" key={entity.id}>
            {batchMode ? <input type="checkbox" aria-label={`选择实体：${currentRevisionByEntity.get(entity.id)?.name ?? "未命名实体"}`}
              checked={entity.id in batchSelection} disabled={busy !== null || importWriting || batchCount >= 200 && !(entity.id in batchSelection)}
              onChange={(event) => setBatchSelection((current) => {
                const next = { ...current };
                if (event.target.checked) next[entity.id] = entity.version;
                else delete next[entity.id];
                return next;
              })} /> : null}
            <button type="button" key={entity.id} className="library-item" disabled={importWriting || busy !== null} data-selected={selectedId === entity.id}
              title={`来源：${currentRevisionByEntity.get(entity.id)?.sourceVersion || "未标注来源"}`} onClick={() => selectEntity(entity)}>
              <strong>{currentRevisionByEntity.get(entity.id)?.name ?? "未命名实体"}</strong>
              <small>{groupBy !== "TYPE" ? `${typeLabels[entity.entityType]} · ` : ""}{entity.lifecycleStatus === "ARCHIVED" ? "已停用" : "使用中"} · v{entity.version}
                {currentRevisionByEntity.get(entity.id)?.tags.length ? <span className="entity-list-tags"> · {currentRevisionByEntity.get(entity.id)?.tags.join(" · ")}</span> : null}</small>
            </button>
          </div>) : null}</div>)}
        </aside>

        <div ref={detail} hidden={!wide && !detailOpen} className="library-detail" tabIndex={-1} role="region" aria-label="设定详情">
          {!wide ? <button type="button" className="secondary-action library-back" disabled={busy !== null || importWriting}
            onClick={returnToList}><ArrowLeft size={15} />返回设定列表</button> : null}
          {!targetResolved ? <p role="status">正在定位实体…</p> : targetError ? null : <>
          {!selected && !editing ? entities.isSuccess ? <WorkspaceEmptyState icon={filteredEmpty ? SearchX : UsersRound}
            title={filteredEmpty ? "没有符合条件的实体。" : !entities.data?.length ? "尚未添加人物与世界设定" : "选择一个人物或世界设定"}>
            {filteredEmpty ? <button type="button" className="secondary-action" onClick={resetFilters}>重置筛选</button>
              : !entities.data?.length ? aiWorkspace ? <button type="button" className="primary-action" disabled={importWriting || busy !== null || !project.data} onClick={startNew}><Plus size={15} />添加第一个设定</button>
                : project.data && <AiWorkspaceLink icon={Plus} title="在共创中新建设定" target={{ projectId: project.data.projectId, workflow: "entity", action: "new" }}>添加第一个设定</AiWorkspaceLink> : null}
          </WorkspaceEmptyState> : <div className="library-empty"><p>{entities.isPending ? "正在加载设定…" : "设定暂不可用"}</p></div> : <>
          <div className="section-heading"><h2>{selected ? editing ? "编辑实体" : form.name : "新建实体"}</h2>{selected ? <span>版本 {selected.version}</span> : <span>尚未保存</span>}</div>
          {selected && !editing ? <><p className="library-meta">{typeLabels[selected.entityType]} · {selected.lifecycleStatus === "ARCHIVED" ? "已停用" : "使用中"}
            {form.sourceVersion ? <span className="entity-detail-source">来源：{form.sourceVersion}</span> : null}</p>
            <ContentTypeLabel identity={entityIdentity(selected.entityType)} />
            <p className="library-content">{form.description || "暂无描述"}</p>
            <EntityAttributesDisplay value={form.fixedAttributesJson} />
            {summaryText ? <p>别名：{summaryText}</p> : null}{scopeText ? <p>标签：{scopeText}</p> : null}
            <div className="library-actions">{aiWorkspace ? <>
              <button type="button" className="secondary-action" disabled={batchMode || busy !== null || importWriting} onClick={() => setEditing(true)}><Pencil size={15} />编辑实体</button>
              <button type="button" className="secondary-action" disabled={busy !== null || importWriting} onClick={() => void toggleArchive()}><Power size={15} />{selected.lifecycleStatus === "ACTIVE" ? "停用实体" : "重新启用"}</button>
              <button type="button" className="secondary-action entity-delete-action" disabled={busy !== null || importWriting}
                onClick={() => void removeEntities([{ id: selected.id, expectedVersion: selected.version }])}><Trash2 size={15} />删除实体</button>
              <div className="entity-move-actions">
                <label>移动到类型<select aria-label="实体移动目标类型" value={moveTargetType} disabled={batchMode || busy !== null || importWriting}
                  onChange={(event) => setMoveTargetType(event.target.value as EntityType)}>
                  {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></label>
                <button type="button" className="secondary-action" disabled={batchMode || busy !== null || importWriting || selected.entityType === moveTargetType}
                  onClick={() => void moveSelectedEntities([{ id: selected.id, expectedVersion: selected.version }])}><FolderInput size={15} />移动实体</button>
              </div>
            </> : <AiWorkspaceLink icon={Pencil} title="在共创中编辑当前设定" target={{ projectId: selected.projectId, workflow: "entity", targetId: selected.id }}>编辑设定</AiWorkspaceLink>}</div>
            <details className="library-advanced"><summary>属性与来源</summary><pre>{form.fixedAttributesJson}</pre><p>来源版本 <code>{form.sourceVersion ?? "未指定"}</code></p></details>
          </> : null}
          {aiWorkspace && selected?.lifecycleStatus === "ACTIVE" ? <button type="button" className="secondary-action"
            onClick={() => void discussEntity()} disabled={entityDirty || busy !== null || importWriting}><MessageSquareText size={14} />继续讨论这个实体</button> : null}
          {selected ? <EntityChapters key={selected.id} projectId={selected.projectId} entityId={selected.id} /> : null}
          {selected && (entityDirty || remoteChanged) ? <div className="entity-reference-actions">
            {remoteChanged ? <span role="status">实体已有新修订，本地修改仍保留。</span> : null}
            <button type="button" className="secondary-action" disabled={busy !== null || importWriting} onClick={() => void reloadEntity()}><RotateCcw size={14} />读取最新实体</button>
          </div> : null}
          {editing ? <fieldset className="entity-import-lock" disabled={importWriting} onKeyDown={(event) => {
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
            <EntityAttributesEditor key={`${form.id ?? "new"}:${form.entityType}`} entityType={form.entityType}
              value={form.fixedAttributesJson} onChange={(value) => setForm((current) => ({ ...current, fixedAttributesJson: value }))} />
            <details className="entity-form-wide library-advanced"><summary>高级信息</summary>
              <label>来源版本<input value={form.sourceVersion ?? ""} onChange={(event) => setForm((current) => ({ ...current, sourceVersion: event.target.value || undefined }))} placeholder="例如：manuscript:2" /></label>
            </details>
          </div>
          <div className="inspector-actions"><span className="library-meta" role="status">{busy === "save" ? "正在保存…" : entityDirty ? "有未保存修改" : "尚无新修改"}</span>
            <button type="button" className="primary-action" onClick={() => void save()} disabled={!form.name.trim() || busy !== null || !project.data || Boolean(form.id) && !entityDirty}><Save size={15} />{busy === "save" ? "保存中…" : selected ? "保存为新修订" : "创建实体"}</button>
            <button type="button" className="secondary-action" disabled={busy !== null} onClick={cancelEditing}>取消</button></div></fieldset> : null}
          {selected ? <details className="library-advanced"><summary>修订历史 · {revisions.data?.length ?? 0}</summary>{revisions.isError ? <p role="alert">{errorMessage(revisions.error)}<button type="button" onClick={() => void revisions.refetch()}>重试</button></p> : null}
            {revisions.data?.map((revision) => <div className="entity-revision-row" key={revision.id}><span>修订 {revision.revision}</span><span>{revision.name}</span><code>{revision.sourceVersion ?? "无来源版本"}</code>{revision.id === selected.currentRevisionId ? <span className="revision-current"><Check size={13} />当前</span> : null}</div>)}</details> : null}
          </>}
          </>}
        </div>
      </div>
      <WorkspacePanel open={showImport} title="从文件导入" modal={!wide} resizable={wide}
        className="entity-import-workspace" closeLabel="收起文件导入" onClose={() => setShowImport(false)}>
        <fieldset className="entity-import-lock library-form" disabled={importBusy}>
          <div className="entity-form-grid">
            <label>导入类型<select value={importType} onChange={(event) => { if (importItems.length) return; setImportType(event.target.value as EntityType); }} disabled={importItems.length > 0}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <div className="entity-import-panel">
            <div className="section-heading"><h2>文件与提炼</h2></div>
            <div className="story-bible-toolbar import-toolbar">
              <AiModelNote taskLabel="知识提炼" taskKey="knowledgeExtraction" profile={extractionProfile} preference={extractionPreference} />
              <label className="file-picker"><FileUp size={15} />{importFileName || "选择文件"}<input aria-label="导入资料文件" type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readImportFile(file); }} /></label>
              <button type="button" className="primary-action" onClick={() => void extractImportItems()} disabled={!importSourceText.trim() || !extractionProfile?.hasSecret || importBusy || busy !== null}><FileUp size={15} />{importBusy ? importWriting ? importProgress : "读取或提炼中…" : extractionFailed ? "重试提炼" : "提取实体"}</button>
            </div>
            <label className="entity-import-guidance"><span>提炼要求（可选）</span><textarea rows={2} value={importGuidance} onChange={(event) => setImportGuidance(event.target.value)} placeholder="例如：只整理上古纪元的世界规则，忽略当代人物与重复条目" /></label>
          </div>
          {importItems.length ? <div className="import-review-panel" aria-label="导入候选审核">
            <div className="section-heading"><h2>候选审核</h2><span>已选 {selectedImportItems.length} / {importItems.length} 条</span></div>
            <label className="import-select-all"><input type="checkbox" checked={selectedImportItems.length === importItems.length}
              ref={(element) => { if (element) element.indeterminate = selectedImportItems.length > 0 && selectedImportItems.length < importItems.length; }}
              onChange={(event) => setImportItems((items) => items.map((item) => ({ ...item, selected: event.target.checked })))} />全选候选</label>
            <div className="import-merge-actions">
              <label>合并后名称<select aria-label="合并后保留名称" value={primaryIndex} disabled={selectedImportItems.length < 2} onChange={(event) => setMergePrimary(Number(event.target.value))}>
                {!selectedImportItems.length ? <option value={-1}>未选择候选</option> : null}
                {importItems.map((item, index) => item.selected ? <option key={index} value={index}>第 {index + 1} 条 · {item.name || "未命名"}</option> : null)}
              </select></label>
              <button type="button" className="secondary-action" disabled={busy !== null || !canMerge}
                title={selectedImportItems.length >= 2 && !canMerge ? "仅能合并名称非空、类型及写入目标相同的候选" : "合并所选同类型候选"}
                onClick={() => void mergeCandidates()}><GitMerge size={14} />合并所选（{selectedImportItems.length}）</button>
              {mergeUndo ? <button type="button" className="secondary-action" disabled={busy !== null} onClick={() => void undoMerge()}><Undo2 size={14} />撤销合并</button> : null}
            </div>
            <div className="import-preview">{importItems.map((item, index) => <div className="import-candidate" data-selected={item.selected} key={index}>
              <label className="import-candidate-select"><input type="checkbox" checked={item.selected}
                aria-label={`选择第 ${index + 1} 条候选：${item.name || "未命名"}`}
                onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, selected: event.target.checked } : current))} />
                <span className="import-candidate-index">{index + 1}</span></label>
              <div className="import-candidate-identity">
                <label>类型<select aria-label={`第 ${index + 1} 条候选类型`} value={item.entityType}
                  onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, entityType: event.target.value as EntityType, mergeTarget: undefined } : current))}>
                  {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></label>
                <label>名称<input value={item.name} onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, name: event.target.value } : current))} /></label>
              </div>
              <label className="import-candidate-description">描述<textarea value={item.description} rows={5} onChange={(event) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, description: event.target.value } : current))} /></label>
              <EntityImportDestination key={`${item.entityType}:${item.name}`} index={index} item={item} matches={importDuplicates[index].matches} cards={cards.data ?? []}
                onChange={(value) => setImportItems((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, ...value } : current))} />
              {importDuplicates[index].candidates.length ? <div className="import-duplicate-warning" role="note">
                <span>与第 {importDuplicates[index].candidates.map((other) => other + 1).join("、")} 条候选重名或同别名</span>
              </div> : null}
            </div>)}</div>
          </div> : null}
        </fieldset>
        {importError && showImport ? <p className="project-error" role="alert">{importError}</p> : null}
        {importNotice && showImport ? <p className="project-notice" role="status">{importNotice}</p> : null}
        <div className="import-review-actions">
          {importBusy ? <span className="library-meta" role="status">{importPreview ? null : <LoaderCircle size={14} className="spin" />}{importWriting ? importProgress : "正在读取或提炼…"}</span> : null}
          {importItems.length ? <button type="button" className="primary-action" onClick={() => void importEntities()}
            disabled={importBusy || busy !== null || !project.data || !canImport}><Check size={15} />{selectedImportItems.some((item) => item.mergeTarget) ? "预览写入" : "确认写入"} {selectedImportItems.length} 条</button> : null}
          <button type="button" className="secondary-action" onClick={() => setShowImport(false)}>收起</button>
          <button type="button" className="secondary-action" disabled={importBusy} onClick={() => {
            if (discardImport()) setShowImport(false);
          }}>放弃本次导入</button>
        </div>
      </WorkspacePanel>
      <WorkspacePanel open={importPreview !== null} title="合并写入预览" className="entity-import-preview-workspace"
        onClose={() => decideImportPreview(false)}>
        <div className="entity-import-preview-summary">
          <span>新建 {importPreview?.filter((entry) => !entry.before).length ?? 0} 个</span>
          <span>补充已有实体 {importPreview?.filter((entry) => entry.before).length ?? 0} 个</span>
        </div>
        {importPreview?.map((entry, index) => <section className="entity-import-preview-entry" key={entry.after.id ?? index}>
          <h3>{entry.before ? "合并到" : "新建"}「{entry.after.name}」 <small>{entry.incomingCount} 条候选</small></h3>
          <div className="entity-import-comparison">
            {entry.before ? <div><h4>合并前 · 修订 {entry.before.revision.revision}</h4>
              <p>{entry.before.revision.description || "暂无描述"}</p>
              <p>别名：{entry.before.revision.aliases.join("、") || "无"}</p>
              <p>标签：{entry.before.revision.tags.join("、") || "无"}</p></div> : null}
            <div><h4>{entry.before ? "合并后 · 新修订" : "写入内容"}</h4>
              <p>{entry.after.description || "暂无描述"}</p>
              <p>别名：{entry.after.aliases.join("、") || "无"}</p>
              <p>标签：{entry.after.tags.join("、") || "无"}</p></div>
          </div>
        </section>)}
        <div className="import-review-actions">
          <button type="button" className="secondary-action" onClick={() => decideImportPreview(false)}>返回调整</button>
          <button type="button" className="primary-action" onClick={() => decideImportPreview(true)}><Check size={15} />确认合并并写入</button>
        </div>
      </WorkspacePanel>
    </section>
  );
}
