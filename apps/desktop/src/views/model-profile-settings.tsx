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

const emptyProfile: ModelProfileInput = {
  name: "云端写作模型",
  provider: "DEEPSEEK",
  capability: "CHAT",
  baseUrl: "https://api.deepseek.com",
  modelId: "",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  privacyLevel: "ALLOW_CLOUD",
  timeoutSeconds: 120,
  retryLimit: 1,
};

export function ModelProfileSettings() {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const [editingProfileId, setEditingProfileId] = useState("");
  const [form, setForm] = useState<ModelProfileInput>(emptyProfile);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProfile = profiles.data?.find((item) => item.id === editingProfileId);

  useEffect(() => {
    if (!editingProfileId && profiles.data?.[0]) setEditingProfileId(profiles.data[0].id);
  }, [editingProfileId, profiles.data]);

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
    setEditingProfileId("");
    setForm(emptyProfile);
    setSecret("");
    setError(null);
    setNotice(null);
  }

  async function saveProfile() {
    setBusy("save");
    setError(null);
    try {
      const saved = await upsertModelProfile(form);
      if (secret.trim()) {
        await saveModelSecret(saved.id, secret.trim());
        setSecret("");
      }
      setEditingProfileId(saved.id);
      setNotice("模型配置已保存");
      await client.invalidateQueries({ queryKey: ["model-profiles"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    if (!editingProfileId) return;
    setBusy("test");
    setError(null);
    try {
      const result = await testModelProfile(editingProfileId);
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
      <button type="button" className="secondary-action icon-command" title="新建模型配置" aria-label="新建模型配置" onClick={startNew} disabled={busy !== null}><Plus size={15} /></button>
    </div>
    {profiles.isPending ? <p className="plan-empty">正在加载模型配置…</p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    <div className="model-profile-switcher">
      {profiles.data?.length ? <select value={editingProfileId} onChange={(event) => { setEditingProfileId(event.target.value); setError(null); setNotice(null); }} aria-label="模型配置" disabled={busy !== null}>
        {profiles.data.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelId}</option>)}
      </select> : <span className="settings-empty-label">尚未创建模型配置</span>}
    </div>
    <div className="model-grid">
      <label>配置名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>模型用途<select value={form.capability} onChange={(event) => { const capability = event.target.value as ModelProfileInput["capability"]; setForm({ ...form, capability, ...(capability === "EMBEDDING" ? { provider: "SILICON_FLOW", baseUrl: "https://api.siliconflow.cn/v1", name: "硅基流动 Embedding" } : { provider: "DEEPSEEK", baseUrl: "https://api.deepseek.com", name: "云端写作模型" }) }); }}><option value="CHAT">写作与分析</option><option value="EMBEDDING">文本向量化</option></select></label>
      <label>云端服务<select value={form.provider} onChange={(event) => { const provider = event.target.value as ModelProfileInput["provider"]; const baseUrls = { SILICON_FLOW: "https://api.siliconflow.cn/v1", DEEPSEEK: "https://api.deepseek.com", OPEN_AI: "https://api.openai.com/v1", OPEN_AI_COMPATIBLE: form.baseUrl }; setForm({ ...form, provider, baseUrl: baseUrls[provider] }); }}>
        {form.capability === "EMBEDDING" ? <option value="SILICON_FLOW">硅基流动</option> : <><option value="DEEPSEEK">DeepSeek</option><option value="OPEN_AI">OpenAI API</option><option value="OPEN_AI_COMPATIBLE">通用 OpenAI-compatible</option></>}
      </select></label>
      <label>模型 ID<input value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} placeholder="例如：gpt-5" /></label>
      <label className="model-wide">API Base URL<input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
      <label>上下文上限<input type="number" min={256} value={form.contextWindow} onChange={(event) => setForm({ ...form, contextWindow: Number(event.target.value) })} /></label>
      <label>最大输出<input type="number" min={1} value={form.maxOutputTokens} onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) })} /></label>
      <label>超时秒数<input type="number" min={1} max={600} value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} /></label>
      <label>重试次数<input type="number" min={0} max={3} value={form.retryLimit} onChange={(event) => setForm({ ...form, retryLimit: Number(event.target.value) })} /></label>
      <label className="model-wide">API Key<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={selectedProfile?.hasSecret ? "已保存在系统凭据库，留空则不修改" : "仅写入系统凭据库"} autoComplete="off" /></label>
    </div>
    <div className="ai-actions"><button type="button" className="primary-action" onClick={() => void saveProfile()} disabled={busy !== null || !form.name.trim() || !form.modelId.trim()}><Save size={14} />{busy === "save" ? "保存中…" : "保存配置"}</button>{selectedProfile?.hasSecret ? <><button type="button" className="secondary-action" onClick={() => void testConnection()} disabled={busy !== null}><PlugZap size={14} />{busy === "test" ? "测试中…" : "测试连接"}</button><button type="button" className="secondary-action" onClick={() => void removeSecret()} disabled={busy !== null}><Trash2 size={14} />删除 Key</button></> : null}<span className="secret-state"><KeyRound size={13} />{selectedProfile?.hasSecret ? "Key 已就绪" : "尚未设置 Key"}</span></div>
  </div>;
}
