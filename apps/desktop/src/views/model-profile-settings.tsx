import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, PlugZap, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  deleteModelSecret,
  errorMessage,
  listModelProfiles,
  saveModelSecret,
  testModelProfile,
  upsertModelProfile,
  type ModelProfileInput,
} from "../lib/tauri-client";

type ModelPreset = {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  retryLimit: number;
};

const modelPresets: Record<ModelProfileInput["provider"], ModelPreset[]> = {
  DEEP_SEEK: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash（写作推荐）", contextWindow: 128_000, maxOutputTokens: 8_192, timeoutSeconds: 120, retryLimit: 1 },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（高质量）", contextWindow: 128_000, maxOutputTokens: 8_192, timeoutSeconds: 180, retryLimit: 1 },
  ],
  OPEN_AI: [
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra（均衡）", contextWindow: 128_000, maxOutputTokens: 8_192, timeoutSeconds: 120, retryLimit: 1 },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna（经济）", contextWindow: 128_000, maxOutputTokens: 8_192, timeoutSeconds: 120, retryLimit: 1 },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol（高质量）", contextWindow: 128_000, maxOutputTokens: 16_384, timeoutSeconds: 180, retryLimit: 1 },
  ],
  OPEN_AI_COMPATIBLE: [],
  SILICON_FLOW: [
    { id: "BAAI/bge-m3", label: "BAAI/bge-m3（通用中文向量化）", contextWindow: 8_192, maxOutputTokens: 1, timeoutSeconds: 60, retryLimit: 2 },
    { id: "Qwen/Qwen3-Embedding-8B", label: "Qwen3 Embedding 8B（长文本向量化）", contextWindow: 32_768, maxOutputTokens: 1, timeoutSeconds: 90, retryLimit: 2 },
  ],
};

const providerBaseUrls: Record<ModelProfileInput["provider"], string> = {
  SILICON_FLOW: "https://api.siliconflow.cn/v1",
  DEEP_SEEK: "https://api.deepseek.com",
  OPEN_AI: "https://api.openai.com/v1",
  OPEN_AI_COMPATIBLE: "",
};

function presetValues(preset: ModelPreset) {
  return {
    modelId: preset.id,
    contextWindow: preset.contextWindow,
    maxOutputTokens: preset.maxOutputTokens,
    timeoutSeconds: preset.timeoutSeconds,
    retryLimit: preset.retryLimit,
  };
}

function providerLabel(provider: ModelProfileInput["provider"]) {
  const labels: Record<ModelProfileInput["provider"], string> = {
    DEEP_SEEK: "DeepSeek",
    OPEN_AI: "OpenAI",
    OPEN_AI_COMPATIBLE: "兼容接口",
    SILICON_FLOW: "硅基流动",
  };
  return labels[provider];
}

const emptyProfile: ModelProfileInput = {
  name: "云端写作模型",
  provider: "DEEP_SEEK",
  capability: "CHAT",
  baseUrl: "https://api.deepseek.com",
  ...presetValues(modelPresets.DEEP_SEEK[0]),
  privacyLevel: "ALLOW_CLOUD",
};

export function ModelProfileSettings() {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [form, setForm] = useState<ModelProfileInput>(emptyProfile);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProfile = profiles.data?.find((item) => item.id === editingProfileId);
  const availablePresets = modelPresets[form.provider];
  const selectedPreset = availablePresets.find((preset) => preset.id === form.modelId);

  useEffect(() => {
    if (hasInitialized || !profiles.data) return;
    if (profiles.data[0]) setEditingProfileId(profiles.data[0].id);
    setHasInitialized(true);
  }, [hasInitialized, profiles.data]);

  useEffect(() => {
    const profile = profiles.data?.find((item) => item.id === editingProfileId);
    if (!profile) return;
    setForm({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      capability: profile.capability,
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
      privacyLevel: profile.privacyLevel,
      timeoutSeconds: profile.timeoutSeconds,
      retryLimit: profile.retryLimit,
    });
  }, [editingProfileId, profiles.data]);

  function startNew() {
    setEditingProfileId(null);
    setForm({ ...emptyProfile, name: "新模型配置" });
    setSecret("");
    setError(null);
    setNotice("已创建新的配置草稿，填写后保存即可。");
  }

  function selectProvider(provider: ModelProfileInput["provider"]) {
    const preset = modelPresets[provider][0];
    setForm({
      ...form,
      provider,
      baseUrl: providerBaseUrls[provider] || form.baseUrl,
      ...(preset ? presetValues(preset) : { modelId: "" }),
    });
  }

  function selectCapability(capability: ModelProfileInput["capability"]) {
    const provider = capability === "EMBEDDING" ? "SILICON_FLOW" : "DEEP_SEEK";
    const preset = modelPresets[provider][0];
    setForm({
      ...form,
      capability,
      provider,
      baseUrl: providerBaseUrls[provider],
      name: capability === "EMBEDDING" ? "硅基流动 Embedding" : "云端写作模型",
      ...presetValues(preset),
    });
  }

  function selectModel(modelId: string) {
    if (modelId === "__CUSTOM__") {
      setForm({ ...form, modelId: "" });
      return;
    }
    const preset = availablePresets.find((item) => item.id === modelId);
    if (preset) setForm({ ...form, ...presetValues(preset) });
  }

  async function persistProfile() {
    const saved = await upsertModelProfile(form);
    if (secret.trim()) {
      await saveModelSecret(saved.id, secret.trim());
      setSecret("");
    }
    setEditingProfileId(saved.id);
    setForm((current) => ({ ...current, id: saved.id }));
    await client.invalidateQueries({ queryKey: ["model-profiles"] });
    return saved;
  }

  async function saveProfile() {
    setBusy("save");
    setError(null);
    try {
      await persistProfile();
      setNotice("模型配置已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setError(null);
    try {
      const saved = await persistProfile();
      const result = await testModelProfile(saved.id);
      setNotice(result.detail);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function removeSecret() {
    if (!editingProfileId) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteModelSecret(editingProfileId);
      setNotice("API Key 已从系统凭据库删除");
      await client.invalidateQueries({ queryKey: ["model-profiles"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return <div className="settings-content">
    <div className="settings-content-heading">
      <div><h2>模型 API</h2><p>配置写作与 Embedding 服务。API Key 仅保存在本机系统凭据库。</p></div>
    </div>
    {profiles.isPending ? <p className="plan-empty">正在加载模型配置…</p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    <div className="model-profile-workbench">
      <aside className="model-profile-list" aria-label="模型配置列表">
        <div className="model-profile-list-heading">
          <h3>模型配置</h3>
          <button type="button" className="secondary-action icon-command" title="新建模型配置" aria-label="新建模型配置" onClick={startNew} disabled={busy !== null}><Plus size={15} /></button>
        </div>
        <div className="model-profile-list-items">
          {profiles.data?.map((profile) => <button key={profile.id} type="button" className="model-profile-item" data-active={profile.id === editingProfileId || undefined} onClick={() => { setEditingProfileId(profile.id); setSecret(""); setError(null); setNotice(null); }} disabled={busy !== null} aria-label={`编辑 ${profile.name} ${profile.modelId}`}>
            <span className="model-profile-item-name">{profile.name}</span>
            <span className="model-profile-item-meta">{providerLabel(profile.provider)} · {profile.modelId}</span>
            <span className="model-profile-item-state"><span>{profile.capability === "CHAT" ? "写作" : "向量化"}</span><span>{profile.hasSecret ? "Key 已设" : "未设 Key"}</span></span>
          </button>)}
          {editingProfileId === null ? <button type="button" className="model-profile-item" data-active aria-label="编辑新模型配置" disabled={busy !== null}>
            <span className="model-profile-item-name">新模型配置</span>
            <span className="model-profile-item-meta">尚未保存</span>
          </button> : null}
          {!profiles.data?.length && editingProfileId !== null ? <span className="settings-empty-label">尚未创建模型配置</span> : null}
        </div>
      </aside>
      <div className="model-profile-editor">
        <div className="model-grid">
          <label>配置名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label>模型用途<select value={form.capability} onChange={(event) => selectCapability(event.target.value as ModelProfileInput["capability"])}><option value="CHAT">写作与分析</option><option value="EMBEDDING">文本向量化</option></select></label>
          <label>云端服务<select value={form.provider} onChange={(event) => selectProvider(event.target.value as ModelProfileInput["provider"])}>
            {form.capability === "EMBEDDING" ? <option value="SILICON_FLOW">硅基流动</option> : <><option value="DEEP_SEEK">DeepSeek</option><option value="OPEN_AI">OpenAI API</option><option value="OPEN_AI_COMPATIBLE">通用 OpenAI-compatible</option></>}
          </select></label>
          <label>模型 ID<select value={selectedPreset?.id ?? "__CUSTOM__"} onChange={(event) => selectModel(event.target.value)}><option value="__CUSTOM__">自定义模型 ID</option>{availablePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
          {!selectedPreset ? <label>自定义模型 ID<input value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} placeholder="输入服务商提供的模型 ID" /></label> : null}
          <label className="model-wide">API Base URL<input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
          <label>上下文上限<input type="number" min={256} value={form.contextWindow} onChange={(event) => setForm({ ...form, contextWindow: Number(event.target.value) })} /></label>
          <label>最大输出<input type="number" min={1} value={form.maxOutputTokens} onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) })} /></label>
          <label>超时秒数<input type="number" min={1} max={600} value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} /></label>
          <label>重试次数<input type="number" min={0} max={3} value={form.retryLimit} onChange={(event) => setForm({ ...form, retryLimit: Number(event.target.value) })} /></label>
          <label className="model-wide">API Key<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={selectedProfile?.hasSecret ? "已保存在系统凭据库，留空则不修改" : "仅写入系统凭据库"} autoComplete="off" /></label>
        </div>
        <div className="ai-actions"><button type="button" className="primary-action" onClick={() => void saveProfile()} disabled={busy !== null || !form.name.trim() || !form.modelId.trim()}><Save size={14} />{busy === "save" ? "保存中…" : "保存配置"}</button><button type="button" className="secondary-action" onClick={() => void testConnection()} disabled={busy !== null || !form.name.trim() || !form.modelId.trim() || (!selectedProfile?.hasSecret && !secret.trim())} title={!selectedProfile?.hasSecret && !secret.trim() ? "请先输入 API Key" : undefined}><PlugZap size={14} />{busy === "test" ? "测试中…" : "测试连接"}</button>{selectedProfile?.hasSecret ? <button type="button" className="secondary-action" onClick={() => void removeSecret()} disabled={busy !== null}><Trash2 size={14} />删除 Key</button> : null}<span className="secret-state"><KeyRound size={13} />{secret.trim() ? "将保存新的 Key" : selectedProfile?.hasSecret ? "Key 已就绪" : "尚未设置 Key"}</span></div>
      </div>
    </div>
  </div>;
}
