import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, RotateCcw, Save, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AI_TASK_DEFINITIONS,
  emptyAiTaskPreferences,
  providerLabel,
  recommendedTaskPreference,
  resolveTaskPreference,
  useAiTaskPreferences,
  type AiTaskKey,
} from "../lib/ai-task-preferences";
import { AI_TASK_PRESETS, applyAiTaskPreset } from "../lib/ai-task-presets";
import { estimateNextRunCost, nextRunCostLabel } from "../lib/ai-cost-estimate";
import {
  errorMessage,
  getAiUsageSummary,
  getProjectAiTaskOverrides,
  listModelProfiles,
  removeProjectAiTaskOverride,
  saveAiTaskPreferences,
  saveProjectAiTaskOverride,
  saveProjectAiTaskOverrides,
  type AiTaskContextPreference,
  type AiTaskPreference,
  type AiTaskPreferences,
  type AiTaskPromptPreference,
  type ModelProfile,
  type ProjectAiTaskOverrides,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

const CONTEXT_OPTIONS: Array<{
  key: keyof Omit<AiTaskContextPreference, "inputTokenBudget">;
  label: string;
  description: string;
}> = [
  { key: "includeProjectContext", label: "正式设定", description: "检索已批准的作品设定、人物和世界事实" },
  { key: "includeReferenceContent", label: "参考文件", description: "加入当前任务选中的参考文件内容" },
  { key: "includeProjectKnowledge", label: "项目知识检索", description: "使用向量与关键词补充相关历史内容" },
  { key: "includeCurrentDraft", label: "当前草稿", description: "正文任务中加入当前章节已有内容" },
  { key: "includeChapterPlan", label: "章节规划", description: "正文任务中加入章节目标和情节要求" },
];

const TASK_MODEL_HINTS: Record<AiTaskKey, string[]> = {
  workDesign: ["pro", "terra", "sol", "flash"],
  outline: ["pro", "terra", "sol", "flash"],
  volumePlanning: ["pro", "terra", "sol", "flash"],
  chapterSplit: ["sol", "pro", "terra", "flash"],
  writing: ["pro", "sol", "terra", "flash"],
  knowledgeExtraction: ["flash", "luna", "terra", "pro"],
};

function recommendedProfileId(task: AiTaskKey, profiles: ModelProfile[]) {
  const available = profiles.filter((profile) => profile.capability === "CHAT" && profile.hasSecret);
  for (const hint of TASK_MODEL_HINTS[task]) {
    const match = available.find((profile) => profile.modelId.toLowerCase().includes(hint));
    if (match) return match.id;
  }
  return available[0]?.id ?? profiles.find((profile) => profile.capability === "CHAT")?.id ?? null;
}

function samePreference(left: AiTaskPreference, right: AiTaskPreference) {
  return left.profileId === right.profileId
    && left.fallbackProfileId === right.fallbackProfileId
    && left.temperature === right.temperature
    && left.maxOutputTokens === right.maxOutputTokens
    && left.prompt.systemPrompt === right.prompt.systemPrompt
    && left.prompt.instructionTemplate === right.prompt.instructionTemplate
    && left.prompt.context.includeProjectContext === right.prompt.context.includeProjectContext
    && left.prompt.context.includeReferenceContent === right.prompt.context.includeReferenceContent
    && left.prompt.context.includeProjectKnowledge === right.prompt.context.includeProjectKnowledge
    && left.prompt.context.includeCurrentDraft === right.prompt.context.includeCurrentDraft
    && left.prompt.context.includeChapterPlan === right.prompt.context.includeChapterPlan
    && left.prompt.context.inputTokenBudget === right.prompt.context.inputTokenBudget;
}

function samePreferences(left: AiTaskPreferences, right: AiTaskPreferences) {
  return AI_TASK_DEFINITIONS.every(({ key }) => samePreference(left[key], right[key]));
}

function mergeProjectPreferences(
  globalPreferences: AiTaskPreferences,
  overrides: ProjectAiTaskOverrides | undefined,
) {
  if (!overrides?.available) return globalPreferences;
  return Object.fromEntries(
    AI_TASK_DEFINITIONS.map(({ key }) => [key, overrides[key] ?? globalPreferences[key]]),
  ) as AiTaskPreferences;
}

function parseTemperature(value: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.min(2, Math.max(0, number)) * 10) / 10;
}

function parseMaxOutputTokens(value: string, limit: number) {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(limit, Math.max(1, Math.floor(number)));
}

function hasCustomGeneration(
  preference: AiTaskPreference,
  task: AiTaskKey,
  maxOutputLimit = 131_072,
) {
  const defaults = recommendedTaskPreference(task);
  return preference.temperature !== defaults.temperature
    || preference.maxOutputTokens !== Math.min(defaults.maxOutputTokens ?? maxOutputLimit, maxOutputLimit);
}

function hasCustomPrompt(preference: AiTaskPreference, task: AiTaskKey) {
  const defaults = resolveTaskPreference(emptyAiTaskPreferences, task);
  return Boolean(preference.prompt.systemPrompt?.trim())
    || Boolean(preference.prompt.instructionTemplate?.trim())
    || preference.prompt.context.includeProjectContext !== defaults.prompt.context.includeProjectContext
    || preference.prompt.context.includeReferenceContent !== defaults.prompt.context.includeReferenceContent
    || preference.prompt.context.includeProjectKnowledge !== defaults.prompt.context.includeProjectKnowledge
    || preference.prompt.context.includeCurrentDraft !== defaults.prompt.context.includeCurrentDraft
    || preference.prompt.context.includeChapterPlan !== defaults.prompt.context.includeChapterPlan
    || preference.prompt.context.inputTokenBudget !== defaults.prompt.context.inputTokenBudget;
}

function optionalText(value: string | null | undefined) {
  return value?.trim() ? value : null;
}

function normalizeAiTaskPreferences(
  preferences: AiTaskPreferences,
  profiles: ModelProfile[],
  preserveMissingProfileIds = false,
): AiTaskPreferences {
  const chatProfiles = profiles.filter((profile) => profile.capability === "CHAT");
  const preferredProfile = chatProfiles.find((profile) => profile.hasSecret) ?? chatProfiles[0];
  return Object.fromEntries(
    AI_TASK_DEFINITIONS.map(({ key }) => {
      const preference = preferences[key];
      const defaults = recommendedTaskPreference(key);
      const selectedProfile = preference.profileId
        ? chatProfiles.find((profile) => profile.id === preference.profileId)
        : undefined;
      const effectiveProfile = selectedProfile ?? preferredProfile;
      const profileId = preference.profileId
        ? selectedProfile || preserveMissingProfileIds
          ? preference.profileId
          : null
        : null;
      const fallbackProfileId = preference.fallbackProfileId
        && preference.fallbackProfileId !== profileId
        && chatProfiles.some((profile) => profile.id === preference.fallbackProfileId)
        ? preference.fallbackProfileId
        : null;
      const temperature = preference.temperature !== null
        && Number.isFinite(preference.temperature)
        && preference.temperature >= 0
        && preference.temperature <= 2
        ? preference.temperature
        : defaults.temperature;
      const maxOutputTokens = preference.maxOutputTokens && preference.maxOutputTokens > 0
        ? preference.maxOutputTokens
        : defaults.maxOutputTokens ?? 131_072;
      const effectiveMaxOutputTokens = Math.min(
        maxOutputTokens,
        effectiveProfile?.maxOutputTokens ?? maxOutputTokens,
      );
      const prompt = resolveTaskPreference(preferences, key);
      const context = prompt.prompt.context;
      const inputTokenBudget = context.inputTokenBudget && context.inputTokenBudget >= 256
        ? context.inputTokenBudget
        : defaults.prompt.context.inputTokenBudget ?? 32_768;
      const maximumInputBudget = Math.max(
        256,
        (effectiveProfile?.contextWindow ?? 131_072) - effectiveMaxOutputTokens,
      );
      return [
        key,
        {
          profileId,
          fallbackProfileId,
          temperature,
          maxOutputTokens: effectiveMaxOutputTokens,
          prompt: {
            systemPrompt: optionalText(preference.prompt?.systemPrompt),
            instructionTemplate: optionalText(preference.prompt?.instructionTemplate),
            context: {
              includeProjectContext: context.includeProjectContext,
              includeReferenceContent: context.includeReferenceContent,
              includeProjectKnowledge: context.includeProjectKnowledge,
              includeCurrentDraft: context.includeCurrentDraft,
              includeChapterPlan: context.includeChapterPlan,
              inputTokenBudget: Math.min(inputTokenBudget, maximumInputBudget),
            },
          },
        },
      ];
    }),
  ) as AiTaskPreferences;
}

export function AiTaskModelSettings(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const usage = useQuery({ queryKey: ["ai-usage-summary", 30], queryFn: () => getAiUsageSummary(30) });
  const preferences = useAiTaskPreferences();
  const projectOverrides = useQuery({
    queryKey: ["project-ai-task-overrides"],
    queryFn: getProjectAiTaskOverrides,
  });
  const [draft, setDraft] = useState<AiTaskPreferences>(emptyAiTaskPreferences);
  const [projectDraft, setProjectDraft] = useState<AiTaskPreferences>(emptyAiTaskPreferences);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<AiTaskKey>("workDesign");
  const [scope, setScope] = useState<"GLOBAL" | "PROJECT">("GLOBAL");
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const chatProfiles = profiles.data?.filter((profile) => profile.capability === "CHAT") ?? [];
  const preferredProfile = chatProfiles.find((profile) => profile.hasSecret) ?? chatProfiles[0];
  const recommendedIds = Object.fromEntries(
    AI_TASK_DEFINITIONS.map(({ key }) => [key, recommendedProfileId(key, chatProfiles)]),
  ) as Record<AiTaskKey, string | null>;
  const normalizedPreferences = preferences.data && profiles.data
    ? normalizeAiTaskPreferences(preferences.data, profiles.data)
    : null;
  const comparisonPreferences = preferences.data && profiles.data
    ? normalizeAiTaskPreferences(preferences.data, profiles.data, true)
    : null;
  const projectBaseline = mergeProjectPreferences(draft, projectOverrides.data);
  const activeDraft = scope === "PROJECT" ? projectDraft : draft;
  const activeBaseline = scope === "PROJECT" ? projectBaseline : comparisonPreferences;
  const assignedCount = AI_TASK_DEFINITIONS.filter(({ key }) => Boolean(activeDraft[key].profileId)).length;
  const tunedCount = AI_TASK_DEFINITIONS.filter(({ key }) => (
    hasCustomGeneration(activeDraft[key], key, maxOutputLimitForTask(key))
    || hasCustomPrompt(activeDraft[key], key)
  )).length;
  const changed = activeBaseline ? !samePreferences(activeDraft, activeBaseline) : assignedCount > 0;
  const selectedDefinition = AI_TASK_DEFINITIONS.find(({ key }) => key === selectedTask)
    ?? AI_TASK_DEFINITIONS[0];
  const selectedPreference = activeDraft[selectedTask];
  const hasProjectOverride = Boolean(projectOverrides.data?.[selectedTask]);
  const globalDirty = comparisonPreferences ? !samePreferences(draft, comparisonPreferences) : false;
  const projectDirty = projectOverrides.data?.available ? !samePreferences(projectDraft, projectBaseline) : false;
  const settingsDirty = globalDirty || projectDirty;
  useUnsavedChangesGuard(settingsDirty, "当前 AI 任务配置有未保存修改。");

  useEffect(() => {
    props.onDirtyChange?.(settingsDirty);
    return () => props.onDirtyChange?.(false);
  }, [props.onDirtyChange, settingsDirty]);

  function maxOutputLimitForTask(task: AiTaskKey) {
    const selected = activeDraft[task].profileId
      ? chatProfiles.find((profile) => profile.id === activeDraft[task].profileId)
      : undefined;
    return (selected ?? preferredProfile)?.maxOutputTokens ?? 131_072;
  }

  function maxInputBudgetForTask(task: AiTaskKey) {
    const selected = activeDraft[task].profileId
      ? chatProfiles.find((profile) => profile.id === activeDraft[task].profileId)
      : undefined;
    const effectiveProfile = selected ?? preferredProfile;
    return Math.max(
      256,
      (effectiveProfile?.contextWindow ?? 131_072) - (activeDraft[task].maxOutputTokens ?? 8_192),
    );
  }

  useEffect(() => {
    if (initialized || !preferences.data || !profiles.data) return;
    const normalized = normalizeAiTaskPreferences(preferences.data, profiles.data);
    setDraft(normalized);
    setProjectDraft(mergeProjectPreferences(normalized, projectOverrides.data));
    setInitialized(true);
  }, [initialized, preferences.data, profiles.data, projectOverrides.data]);

  function updateTask(task: AiTaskKey, patch: Partial<AiTaskPreference>) {
    const update = scope === "PROJECT" ? setProjectDraft : setDraft;
    update((current) => ({
      ...current,
      [task]: { ...current[task], ...patch },
    }));
    setActivePresetId(null);
    setNotice(null);
  }

  function updateTaskPrompt(task: AiTaskKey, patch: Partial<AiTaskPromptPreference>) {
    const update = scope === "PROJECT" ? setProjectDraft : setDraft;
    update((current) => ({
      ...current,
      [task]: {
        ...current[task],
        prompt: {
          ...current[task].prompt,
          ...patch,
        },
      },
    }));
    setActivePresetId(null);
    setNotice(null);
  }

  function updateTaskContext(task: AiTaskKey, patch: Partial<AiTaskContextPreference>) {
    const update = scope === "PROJECT" ? setProjectDraft : setDraft;
    update((current) => ({
      ...current,
      [task]: {
        ...current[task],
        prompt: {
          ...current[task].prompt,
          context: {
            ...current[task].prompt.context,
            ...patch,
          },
        },
      },
    }));
    setActivePresetId(null);
    setNotice(null);
  }

  function clearTaskTuning(task: AiTaskKey, maxOutputLimit: number) {
    const defaults = recommendedTaskPreference(task);
    updateTask(task, {
      temperature: defaults.temperature,
      maxOutputTokens: Math.min(defaults.maxOutputTokens ?? maxOutputLimit, maxOutputLimit),
    });
  }

  function resetTaskPrompt(task: AiTaskKey) {
    const defaults = recommendedTaskPreference(task);
    updateTask(task, {
      prompt: {
        systemPrompt: defaults.prompt.systemPrompt,
        instructionTemplate: defaults.prompt.instructionTemplate,
        context: { ...defaults.prompt.context },
      },
    });
    setActivePresetId(null);
  }

  function insertPromptVariable(variable: string) {
    const current = selectedPreference.prompt.instructionTemplate ?? "";
    const textarea = instructionRef.current;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? start;
    const token = `{{${variable}}}`;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    updateTaskPrompt(selectedTask, { instructionTemplate: next });
    requestAnimationFrame(() => {
      const caret = start + token.length;
      instructionRef.current?.focus();
      instructionRef.current?.setSelectionRange(caret, caret);
    });
  }

  function selectTaskProfile(task: AiTaskKey, profileId: string) {
    const nextProfile = chatProfiles.find((profile) => profile.id === profileId);
    const current = activeDraft[task];
    const defaults = recommendedTaskPreference(task);
    const nextProfileLimit = (nextProfile ?? preferredProfile)?.maxOutputTokens ?? 131_072;
    const nextContextWindow = (nextProfile ?? preferredProfile)?.contextWindow ?? 131_072;
    const nextMaxOutputTokens = Math.min(
      current.maxOutputTokens ?? defaults.maxOutputTokens ?? nextProfileLimit,
      nextProfileLimit,
    );
    updateTask(task, {
      profileId: profileId || null,
      fallbackProfileId: current.fallbackProfileId === profileId ? null : current.fallbackProfileId,
      maxOutputTokens: nextMaxOutputTokens,
      prompt: {
        ...current.prompt,
        context: {
          ...current.prompt.context,
          inputTokenBudget: Math.min(
            current.prompt.context.inputTokenBudget ?? defaults.prompt.context.inputTokenBudget ?? 32_768,
            Math.max(256, nextContextWindow - nextMaxOutputTokens),
          ),
        },
      },
    });
  }

  function applyPreset(presetId: string) {
    const preset = AI_TASK_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const next = applyAiTaskPreset(activeDraft, preset);
    const normalized = normalizeAiTaskPreferences(next, profiles.data ?? [], true);
    if (scope === "PROJECT") setProjectDraft(normalized);
    else setDraft(normalized);
    setActivePresetId(preset.id);
    setNotice(`已应用“${preset.label}”预设到当前编辑范围；模型、备用模型和自定义提示词保持不变，保存后生效。`);
  }

  async function applyToAll() {
    if (!preferredProfile) return;
    const current = activeDraft;
    const next = Object.fromEntries(
      AI_TASK_DEFINITIONS.map(({ key }) => {
        const defaults = recommendedTaskPreference(key);
        return [
          key,
          {
            ...current[key],
            profileId: preferredProfile.id,
            maxOutputTokens: Math.min(current[key].maxOutputTokens ?? defaults.maxOutputTokens ?? preferredProfile.maxOutputTokens, preferredProfile.maxOutputTokens),
          },
        ];
      }),
    ) as AiTaskPreferences;
    if (scope === "GLOBAL") {
      setDraft(next);
      setActivePresetId(null);
      setNotice(`已将“${preferredProfile.name}”应用到全部 AI 任务，保存后生效`);
      return;
    }

    setProjectSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveProjectAiTaskOverrides(next);
      setProjectDraft(mergeProjectPreferences(draft, saved));
      setActivePresetId(null);
      client.setQueryData(["project-ai-task-overrides"], saved);
      await client.invalidateQueries({ queryKey: ["ai-task-preferences"] });
      setNotice(`已将“${preferredProfile.name}”应用并保存到全部项目任务`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setProjectSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveAiTaskPreferences(draft);
      setDraft(profiles.data ? normalizeAiTaskPreferences(saved, profiles.data) : saved);
      await client.invalidateQueries({ queryKey: ["ai-task-preferences"] });
      setNotice("任务模型与生成参数已保存，后续生成会立即使用新配置");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function saveProjectOverride() {
    setProjectSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveProjectAiTaskOverride(selectedTask, activeDraft[selectedTask]);
      setProjectDraft(mergeProjectPreferences(draft, saved));
      setScope("PROJECT");
      setNotice(`已保存“${selectedDefinition.label}”的项目级覆盖`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setProjectSaving(false);
    }
  }

  async function removeProjectOverride() {
    setProjectSaving(true);
    setError(null);
    setNotice(null);
    try {
      await removeProjectAiTaskOverride(selectedTask);
      const remaining = await projectOverrides.refetch();
      setProjectDraft(draft);
      if (remaining.data) setProjectDraft(mergeProjectPreferences(draft, remaining.data));
      setNotice(`已移除“${selectedDefinition.label}”的项目级覆盖`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setProjectSaving(false);
    }
  }

  function switchScope(nextScope: "GLOBAL" | "PROJECT") {
    if (nextScope === "PROJECT") {
      if (!projectOverrides.data?.available) return;
      setProjectDraft(mergeProjectPreferences(draft, projectOverrides.data));
      setNotice(`正在编辑“${selectedDefinition.label}”的项目覆盖；未覆盖的任务沿用当前全局配置。`);
    } else {
      if (projectDirty && !window.confirm("当前项目级任务配置有未保存修改，确定切换吗？")) return;
      setNotice("正在编辑全局 AI 任务配置。");
    }
    setActivePresetId(null);
    setScope(nextScope);
  }

  return <div className="settings-content">
    <div className="settings-content-heading">
      <div>
        <h2>AI 任务模型</h2>
        <p>为六类创作任务分别设置模型、生成参数、提示词和上下文来源。留空提示词时使用内置模板。</p>
      </div>
      {chatProfiles.length ? <button type="button" className="secondary-action" onClick={() => void applyToAll()} disabled={!preferredProfile || saving || projectSaving}><Sparkles size={14} />全部使用首选模型</button> : null}
    </div>
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    {profiles.isPending || preferences.isPending ? <p className="plan-empty">正在加载模型与任务配置…</p> : null}
    {!profiles.isPending && !chatProfiles.length ? <div className="ai-task-empty">
      <strong>还没有可分配的聊天模型</strong>
      <span>请先在“模型 API”中创建并保存至少一个聊天模型配置。</span>
      <a href="/settings" className="secondary-action">前往模型 API</a>
    </div> : null}
    {!profiles.isPending && chatProfiles.length ? <div className="ai-task-routing">
      <div className="ai-task-routing-heading">
        <div><strong>任务路由与生成参数</strong><span>模型决定使用哪项服务，温度控制发散程度，最大输出控制单次生成长度。</span></div>
        <small>{assignedCount} / {AI_TASK_DEFINITIONS.length} 已指定 · {tunedCount} 项已调参</small>
      </div>
      <section className="ai-task-presets">
        <div className="ai-task-presets-heading">
          <div><strong>题材与创作场景预设</strong><span>一次调整六类任务的生成参数和上下文预算；不会替换模型、备用模型或自定义提示词。</span></div>
          <small>应用后仍可逐项编辑</small>
        </div>
        <div className="ai-task-preset-list">
          {AI_TASK_PRESETS.map((preset) => <button
            type="button"
            key={preset.id}
            aria-label={preset.label}
            data-active={activePresetId === preset.id || undefined}
            onClick={() => applyPreset(preset.id)}
          >
            <strong>{preset.label}</strong>
            <small>{preset.description}</small>
          </button>)}
        </div>
      </section>
      <div className="ai-task-routing-list">
        {AI_TASK_DEFINITIONS.map(({ key, label, description }) => {
          const preference = activeDraft[key];
          const defaults = recommendedTaskPreference(key);
          const selectedId = preference.profileId ?? "";
          const selectedProfile = chatProfiles.find((profile) => profile.id === selectedId);
          const effectiveProfile = selectedProfile ?? preferredProfile;
          const selectionMissing = Boolean(selectedId && !selectedProfile);
          const maxOutputLimit = maxOutputLimitForTask(key);
          return <div className="ai-task-routing-row" key={key}>
            <span className="ai-task-routing-copy"><strong>{label}</strong><small>{description}</small></span>
            <div className="ai-task-model-stack">
              <label className="ai-task-model-field"><span>任务模型</span><select value={selectedId} onChange={(event) => selectTaskProfile(key, event.target.value)} aria-label={`${label}模型`} data-missing={selectionMissing || undefined}>
                <option value="">自动选择可用模型</option>
                {chatProfiles.map((profile) => <option key={profile.id} value={profile.id}>
                  {profile.name} · {providerLabel(profile.provider)} · {profile.modelId}{recommendedIds[key] === profile.id ? " · 推荐" : ""}{profile.hasSecret ? "" : "（未设置 Key）"}
                </option>)}
              </select></label>
              <label className="ai-task-model-field"><span>故障备用模型</span><select value={preference.fallbackProfileId ?? ""} onChange={(event) => updateTask(key, { fallbackProfileId: event.target.value || null })} aria-label={`${label}备用模型`}>
                <option value="">不使用备用模型</option>
                {chatProfiles.filter((profile) => profile.id !== selectedId).map((profile) => <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.modelId}{profile.hasSecret ? "" : "（未设置 Key）"}
                </option>)}
              </select></label>
            </div>
            <div className="ai-task-tuning-fields">
              <label><span>温度</span><input type="number" min="0" max="2" step="0.1" inputMode="decimal" value={preference.temperature ?? ""} onChange={(event) => updateTask(key, { temperature: parseTemperature(event.target.value) })} placeholder="默认" aria-label={`${label}温度`} /></label>
              <label><span>最大输出</span><input type="number" min="1" max={maxOutputLimit} step="1" inputMode="numeric" value={preference.maxOutputTokens ?? ""} onChange={(event) => updateTask(key, { maxOutputTokens: parseMaxOutputTokens(event.target.value, maxOutputLimit) })} placeholder={selectedProfile ? `最大 ${maxOutputLimit}` : "模型默认"} aria-label={`${label}最大输出`} /></label>
            </div>
            <div className="ai-task-routing-meta">
              <span className="ai-task-routing-state" data-ready={selectedProfile?.hasSecret || (!selectedId && preferredProfile?.hasSecret) || undefined}>
                {selectionMissing ? "配置已删除" : selectedProfile ? selectedProfile.hasSecret ? "可用" : "缺少 Key" : preferredProfile ? `自动：${preferredProfile.name}` : "未配置"}
              </span>
              <span className="ai-task-cost-estimate">{nextRunCostLabel(estimateNextRunCost(usage.data?.byTask, key, effectiveProfile), usage.data?.days)}</span>
              {hasCustomGeneration(preference, key, maxOutputLimit) ? <button type="button" onClick={() => clearTaskTuning(key, maxOutputLimit)} title={`恢复 ${label} 的推荐值：温度 ${defaults.temperature}，最大输出 ${Math.min(defaults.maxOutputTokens ?? maxOutputLimit, maxOutputLimit)}`}><RotateCcw size={12} />恢复生成参数</button> : null}
              <button type="button" onClick={() => setSelectedTask(key)} data-active={selectedTask === key || undefined}><ChevronDown size={12} />{hasCustomPrompt(preference, key) ? "已自定义" : "高级配置"}</button>
            </div>
          </div>;
        })}
      </div>
      <section className="ai-task-advanced">
        <div className="ai-task-advanced-heading">
          <div>
            <strong>提示词与上下文 · {selectedDefinition.label}</strong>
            <span>系统提示词负责角色边界，任务模板追加作者要求和可变上下文；不会修改内置模板。</span>
          </div>
          <div className="ai-task-advanced-tabs" role="tablist" aria-label="选择要编辑的 AI 任务">
            {AI_TASK_DEFINITIONS.map(({ key, label }) => <button type="button" role="tab" aria-selected={selectedTask === key} data-active={selectedTask === key || undefined} key={key} onClick={() => setSelectedTask(key)}>
              {label}{hasCustomPrompt(activeDraft[key], key) ? <span aria-label="已自定义">·</span> : null}
            </button>)}
          </div>
        </div>
        <div className="ai-task-prompt-grid">
          <label>
            <span>系统提示词覆盖</span>
            <textarea value={selectedPreference.prompt.systemPrompt ?? ""} onChange={(event) => updateTaskPrompt(selectedTask, { systemPrompt: optionalText(event.target.value) })} placeholder="留空使用内置系统提示词" rows={5} maxLength={20_000} />
            <small>仅在需要改变模型角色、边界或全局写作原则时填写。</small>
          </label>
          <label>
            <span>自定义任务模板</span>
            <textarea ref={instructionRef} value={selectedPreference.prompt.instructionTemplate ?? ""} onChange={(event) => updateTaskPrompt(selectedTask, { instructionTemplate: optionalText(event.target.value) })} placeholder="留空使用内置任务提示词" rows={7} maxLength={20_000} />
            <small>模板会追加到内置任务提示词之后，变量在发送前替换为实际内容。</small>
          </label>
        </div>
        <div className="ai-task-variable-row" aria-label="可用模板变量">
          <span>插入变量</span>
          {selectedDefinition.promptVariables.map((variable) => <button type="button" key={variable} onClick={() => insertPromptVariable(variable)}>{`{{${variable}}}`}</button>)}
        </div>
        <div className="ai-task-context-panel">
          <div className="ai-task-context-heading">
            <div><strong>上下文来源与输入预算</strong><span>关闭某个来源后，该内容不会进入当前任务请求。</span></div>
            <button type="button" className="secondary-action" onClick={() => resetTaskPrompt(selectedTask)} disabled={!hasCustomPrompt(selectedPreference, selectedTask)}><RotateCcw size={12} />恢复推荐提示词与上下文</button>
          </div>
          <div className="ai-task-context-options">
            {CONTEXT_OPTIONS.map(({ key, label, description }) => <label key={key}>
              <input type="checkbox" checked={selectedPreference.prompt.context[key] ?? false} onChange={(event) => updateTaskContext(selectedTask, { [key]: event.target.checked })} />
              <span><strong>{label}</strong><small>{description}</small></span>
            </label>)}
            <label className="ai-task-budget-field">
              <span><strong>输入 Token 预算</strong><small>至少 256，并自动受当前模型上下文窗口限制。</small></span>
              <input type="number" min="256" max={maxInputBudgetForTask(selectedTask)} step="256" inputMode="numeric" value={selectedPreference.prompt.context.inputTokenBudget ?? ""} onChange={(event) => updateTaskContext(selectedTask, { inputTokenBudget: Math.min(maxInputBudgetForTask(selectedTask), Math.max(256, Number(event.target.value) || 256)) })} />
            </label>
          </div>
          <div className="ai-task-project-override">
            <div>
              <strong>项目级覆盖</strong>
              <small>{!projectOverrides.data?.available
                ? "打开一个项目后，才能创建项目级覆盖。"
                : scope === "PROJECT"
                  ? hasProjectOverride
                    ? "正在编辑项目覆盖；生成时会优先使用这里的设置。"
                    : "正在编辑本项目专用设置；保存后才会覆盖全局配置。"
                  : "当前编辑全局配置；项目覆盖不会影响这里的保存结果。"}</small>
            </div>
            {projectOverrides.data?.available ? <div>
              <div className="ai-task-scope-switch" role="tablist" aria-label="AI 配置编辑范围">
                <button type="button" role="tab" aria-selected={scope === "GLOBAL"} data-active={scope === "GLOBAL" || undefined} onClick={() => switchScope("GLOBAL")}>全局配置</button>
                <button type="button" role="tab" aria-selected={scope === "PROJECT"} data-active={scope === "PROJECT" || undefined} onClick={() => switchScope("PROJECT")}>项目覆盖</button>
              </div>
              <button type="button" className="secondary-action" onClick={() => void saveProjectOverride()} disabled={projectSaving}><Save size={12} />{hasProjectOverride ? "更新项目覆盖" : "保存为项目覆盖"}</button>
              {hasProjectOverride ? <button type="button" className="secondary-action" onClick={() => void removeProjectOverride()} disabled={projectSaving}><RotateCcw size={12} />移除覆盖</button> : null}
            </div> : null}
          </div>
          <p className="ai-task-request-note">保存后，任务中心会在实际请求发出时记录最终提示词、上下文和请求体；API Key 不会写入记录。</p>
        </div>
      </section>
      <div className="ai-task-routing-actions">
        <button type="button" className="primary-action" onClick={() => scope === "PROJECT" ? void saveProjectOverride() : void save()} disabled={!changed || (scope === "PROJECT" ? projectSaving : saving)}><Save size={14} />{scope === "PROJECT" ? projectSaving ? "保存中…" : hasProjectOverride ? "保存项目覆盖" : "保存为项目覆盖" : saving ? "保存中…" : "保存任务配置"}</button>
        {changed ? <button type="button" className="secondary-action" onClick={() => { if (scope === "PROJECT") setProjectDraft(projectBaseline); else if (normalizedPreferences) setDraft(normalizedPreferences); setNotice("已撤销未保存的修改"); }} disabled={scope === "PROJECT" ? projectSaving : saving}>撤销修改</button> : null}
        {!changed && notice?.includes("已保存") ? <span className="ai-task-saved"><Check size={13} />已应用</span> : null}
      </div>
    </div> : null}
  </div>;
}
