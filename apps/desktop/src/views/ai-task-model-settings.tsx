import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, Save, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AI_TASK_DEFINITIONS,
  emptyAiTaskPreferences,
  providerLabel,
  recommendedTaskPreference,
  useAiTaskPreferences,
  type AiTaskKey,
} from "../lib/ai-task-preferences";
import {
  errorMessage,
  listModelProfiles,
  saveAiTaskPreferences,
  type AiTaskPreference,
  type AiTaskPreferences,
  type ModelProfile,
} from "../lib/tauri-client";

function samePreference(left: AiTaskPreference, right: AiTaskPreference) {
  return left.profileId === right.profileId
    && left.temperature === right.temperature
    && left.maxOutputTokens === right.maxOutputTokens;
}

function samePreferences(left: AiTaskPreferences, right: AiTaskPreferences) {
  return AI_TASK_DEFINITIONS.every(({ key }) => samePreference(left[key], right[key]));
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

function hasCustomTuning(preference: AiTaskPreference, task: AiTaskKey, maxOutputLimit = 131_072) {
  const defaults = recommendedTaskPreference(task);
  return preference.temperature !== defaults.temperature
    || preference.maxOutputTokens !== Math.min(defaults.maxOutputTokens ?? maxOutputLimit, maxOutputLimit);
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
      const temperature = preference.temperature !== null
        && Number.isFinite(preference.temperature)
        && preference.temperature >= 0
        && preference.temperature <= 2
        ? preference.temperature
        : defaults.temperature;
      const maxOutputTokens = preference.maxOutputTokens && preference.maxOutputTokens > 0
        ? preference.maxOutputTokens
        : defaults.maxOutputTokens ?? 131_072;
      return [
        key,
        {
          profileId,
          temperature,
          maxOutputTokens: Math.min(maxOutputTokens, effectiveProfile?.maxOutputTokens ?? maxOutputTokens),
        },
      ];
    }),
  ) as AiTaskPreferences;
}

export function AiTaskModelSettings() {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const preferences = useAiTaskPreferences();
  const [draft, setDraft] = useState<AiTaskPreferences>(emptyAiTaskPreferences);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const chatProfiles = profiles.data?.filter((profile) => profile.capability === "CHAT") ?? [];
  const preferredProfile = chatProfiles.find((profile) => profile.hasSecret) ?? chatProfiles[0];
  const normalizedPreferences = preferences.data && profiles.data
    ? normalizeAiTaskPreferences(preferences.data, profiles.data)
    : null;
  const comparisonPreferences = preferences.data && profiles.data
    ? normalizeAiTaskPreferences(preferences.data, profiles.data, true)
    : null;
  const assignedCount = AI_TASK_DEFINITIONS.filter(({ key }) => Boolean(draft[key].profileId)).length;
  const tunedCount = AI_TASK_DEFINITIONS.filter(({ key }) => hasCustomTuning(draft[key], key, maxOutputLimitForTask(key))).length;
  const changed = comparisonPreferences ? !samePreferences(draft, comparisonPreferences) : assignedCount > 0;

  function maxOutputLimitForTask(task: AiTaskKey) {
    const selected = draft[task].profileId
      ? chatProfiles.find((profile) => profile.id === draft[task].profileId)
      : undefined;
    return (selected ?? preferredProfile)?.maxOutputTokens ?? 131_072;
  }

  useEffect(() => {
    if (initialized || !preferences.data || !profiles.data) return;
    setDraft(normalizeAiTaskPreferences(preferences.data, profiles.data));
    setInitialized(true);
  }, [initialized, preferences.data, profiles.data]);

  function updateTask(task: AiTaskKey, patch: Partial<AiTaskPreference>) {
    setDraft((current) => ({
      ...current,
      [task]: { ...current[task], ...patch },
    }));
    setNotice(null);
  }

  function clearTaskTuning(task: AiTaskKey, maxOutputLimit: number) {
    const defaults = recommendedTaskPreference(task);
    updateTask(task, {
      temperature: defaults.temperature,
      maxOutputTokens: Math.min(defaults.maxOutputTokens ?? maxOutputLimit, maxOutputLimit),
    });
  }

  function selectTaskProfile(task: AiTaskKey, profileId: string) {
    const nextProfile = chatProfiles.find((profile) => profile.id === profileId);
    const current = draft[task];
    const defaults = recommendedTaskPreference(task);
    const nextProfileLimit = (nextProfile ?? preferredProfile)?.maxOutputTokens ?? 131_072;
    updateTask(task, {
      profileId: profileId || null,
      maxOutputTokens: Math.min(current.maxOutputTokens ?? defaults.maxOutputTokens ?? nextProfileLimit, nextProfileLimit),
    });
  }

  function applyToAll() {
    if (!preferredProfile) return;
    setDraft((current) => Object.fromEntries(
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
    ) as AiTaskPreferences);
    setNotice(`已将“${preferredProfile.name}”应用到全部 AI 任务`);
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

  return <div className="settings-content">
    <div className="settings-content-heading">
      <div>
        <h2>AI 任务模型</h2>
        <p>为不同创作阶段分配聊天模型。六类任务已配置推荐生成参数，你可以按需要单独覆盖。</p>
      </div>
      {chatProfiles.length ? <button type="button" className="secondary-action" onClick={applyToAll} disabled={!preferredProfile || saving}><Sparkles size={14} />全部使用首选模型</button> : null}
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
      <div className="ai-task-routing-list">
        {AI_TASK_DEFINITIONS.map(({ key, label, description }) => {
          const preference = draft[key];
          const defaults = recommendedTaskPreference(key);
          const selectedId = preference.profileId ?? "";
          const selectedProfile = chatProfiles.find((profile) => profile.id === selectedId);
          const selectionMissing = Boolean(selectedId && !selectedProfile);
          const maxOutputLimit = maxOutputLimitForTask(key);
          return <div className="ai-task-routing-row" key={key}>
            <span className="ai-task-routing-copy"><strong>{label}</strong><small>{description}</small></span>
            <label className="ai-task-model-field"><span>任务模型</span><select value={selectedId} onChange={(event) => selectTaskProfile(key, event.target.value)} aria-label={`${label}模型`} data-missing={selectionMissing || undefined}>
              <option value="">自动选择可用模型</option>
              {chatProfiles.map((profile) => <option key={profile.id} value={profile.id}>
                {profile.name} · {providerLabel(profile.provider)} · {profile.modelId}{profile.hasSecret ? "" : "（未设置 Key）"}
              </option>)}
            </select></label>
            <div className="ai-task-tuning-fields">
              <label><span>温度</span><input type="number" min="0" max="2" step="0.1" inputMode="decimal" value={preference.temperature ?? ""} onChange={(event) => updateTask(key, { temperature: parseTemperature(event.target.value) })} placeholder="默认" aria-label={`${label}温度`} /></label>
              <label><span>最大输出</span><input type="number" min="1" max={maxOutputLimit} step="1" inputMode="numeric" value={preference.maxOutputTokens ?? ""} onChange={(event) => updateTask(key, { maxOutputTokens: parseMaxOutputTokens(event.target.value, maxOutputLimit) })} placeholder={selectedProfile ? `最大 ${maxOutputLimit}` : "模型默认"} aria-label={`${label}最大输出`} /></label>
            </div>
            <div className="ai-task-routing-meta">
              <span className="ai-task-routing-state" data-ready={selectedProfile?.hasSecret || (!selectedId && preferredProfile?.hasSecret) || undefined}>
                {selectionMissing ? "配置已删除" : selectedProfile ? selectedProfile.hasSecret ? "可用" : "缺少 Key" : preferredProfile ? `自动：${preferredProfile.name}` : "未配置"}
              </span>
              {hasCustomTuning(preference, key, maxOutputLimit) ? <button type="button" onClick={() => clearTaskTuning(key, maxOutputLimit)} title={`恢复 ${label} 的推荐值：温度 ${defaults.temperature}，最大输出 ${Math.min(defaults.maxOutputTokens ?? maxOutputLimit, maxOutputLimit)}`}><RotateCcw size={12} />恢复推荐值</button> : null}
            </div>
          </div>;
        })}
      </div>
      <div className="ai-task-routing-actions">
        <button type="button" className="primary-action" onClick={() => void save()} disabled={!changed || saving}><Save size={14} />{saving ? "保存中…" : "保存任务配置"}</button>
        {normalizedPreferences && changed ? <button type="button" className="secondary-action" onClick={() => { setDraft(normalizedPreferences); setNotice("已撤销未保存的修改"); }} disabled={saving}>撤销修改</button> : null}
        {!changed && notice?.includes("已保存") ? <span className="ai-task-saved"><Check size={13} />已应用</span> : null}
      </div>
    </div> : null}
  </div>;
}
