import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Save, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AI_TASK_DEFINITIONS,
  emptyAiTaskPreferences,
  providerLabel,
  useAiTaskPreferences,
  type AiTaskKey,
} from "../lib/ai-task-preferences";
import {
  errorMessage,
  listModelProfiles,
  saveAiTaskPreferences,
  type AiTaskPreferences,
} from "../lib/tauri-client";

function samePreferences(left: AiTaskPreferences, right: AiTaskPreferences) {
  return AI_TASK_DEFINITIONS.every(({ key }) => left[key] === right[key]);
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
  const assignedCount = AI_TASK_DEFINITIONS.filter(({ key }) => Boolean(draft[key])).length;
  const changed = preferences.data ? !samePreferences(draft, preferences.data) : assignedCount > 0;

  useEffect(() => {
    if (initialized || !preferences.data || !profiles.data) return;
    const availableProfileIds = new Set(
      profiles.data
        .filter((profile) => profile.capability === "CHAT")
        .map((profile) => profile.id),
    );
    setDraft(
      Object.fromEntries(
        AI_TASK_DEFINITIONS.map(({ key }) => {
          const profileId = preferences.data[key];
          return [key, profileId && availableProfileIds.has(profileId) ? profileId : null];
        }),
      ) as AiTaskPreferences,
    );
    setInitialized(true);
  }, [initialized, preferences.data, profiles.data]);

  function updateTask(task: AiTaskKey, profileId: string) {
    setDraft((current) => ({ ...current, [task]: profileId || null }));
    setNotice(null);
  }

  function applyToAll() {
    if (!preferredProfile) return;
    setDraft(
      Object.fromEntries(
        AI_TASK_DEFINITIONS.map(({ key }) => [key, preferredProfile.id]),
      ) as AiTaskPreferences,
    );
    setNotice(`已将“${preferredProfile.name}”应用到全部 AI 任务`);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveAiTaskPreferences(draft);
      setDraft(saved);
      await client.invalidateQueries({ queryKey: ["ai-task-preferences"] });
      setNotice("AI 任务模型已保存，后续生成会立即使用新配置");
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
        <p>为不同创作阶段分配已配置的聊天模型。未指定时自动使用第一个带 Key 的可用模型。</p>
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
        <div><strong>任务路由</strong><span>每个任务独立选择，避免规划和正文互相覆盖</span></div>
        <small>{assignedCount} / {AI_TASK_DEFINITIONS.length} 已指定</small>
      </div>
      <div className="ai-task-routing-list">
        {AI_TASK_DEFINITIONS.map(({ key, label, description }) => {
          const selectedId = draft[key] ?? "";
          const selectedProfile = chatProfiles.find((profile) => profile.id === selectedId);
          const selectionMissing = Boolean(selectedId && !selectedProfile);
          return <label className="ai-task-routing-row" key={key}>
            <span className="ai-task-routing-copy"><strong>{label}</strong><small>{description}</small></span>
            <select value={selectedId} onChange={(event) => updateTask(key, event.target.value)} aria-label={`${label}模型`} data-missing={selectionMissing || undefined}>
              <option value="">自动选择可用模型</option>
              {chatProfiles.map((profile) => <option key={profile.id} value={profile.id}>
                {profile.name} · {providerLabel(profile.provider)} · {profile.modelId}{profile.hasSecret ? "" : "（未设置 Key）"}
              </option>)}
            </select>
            <span className="ai-task-routing-state" data-ready={selectedProfile?.hasSecret || (!selectedId && preferredProfile?.hasSecret) || undefined}>
              {selectionMissing ? "配置已删除" : selectedProfile ? selectedProfile.hasSecret ? "可用" : "缺少 Key" : preferredProfile ? `自动：${preferredProfile.name}` : "未配置"}
            </span>
          </label>;
        })}
      </div>
      <div className="ai-task-routing-actions">
        <button type="button" className="primary-action" onClick={() => void save()} disabled={!changed || saving}><Save size={14} />{saving ? "保存中…" : "保存任务模型"}</button>
        {preferences.data && changed ? <button type="button" className="secondary-action" onClick={() => { setDraft(preferences.data ?? emptyAiTaskPreferences); setNotice("已撤销未保存的修改"); }} disabled={saving}>撤销修改</button> : null}
        {!changed && notice?.includes("已保存") ? <span className="ai-task-saved"><Check size={13} />已应用</span> : null}
      </div>
    </div> : null}
  </div>;
}
