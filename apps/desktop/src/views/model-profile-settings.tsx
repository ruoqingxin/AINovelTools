import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BadgeDollarSign, Clock3, Eye, EyeOff, KeyRound, PlugZap, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
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
import { deepSeekFlashPricing, isDeepSeekFlash } from "../lib/deepseek-pricing";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

type ModelPreset = {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  retryLimit: number;
  inputPriceMicrosPerMillion?: number;
  outputPriceMicrosPerMillion?: number;
  priceCurrency?: string;
};

const modelPresets: Record<ModelProfileInput["provider"], ModelPreset[]> = {
  DEEP_SEEK: [
    { id: "deepseek-flash", label: "DeepSeek Flash（写作推荐）", contextWindow: 1_000_000, maxOutputTokens: 384_000, timeoutSeconds: 120, retryLimit: 1 },
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
    inputPriceMicrosPerMillion: preset.inputPriceMicrosPerMillion ?? 0,
    outputPriceMicrosPerMillion: preset.outputPriceMicrosPerMillion ?? 0,
    priceCurrency: preset.priceCurrency ?? "USD",
  };
}

function displayPrice(micros: number) {
  return micros > 0 ? (micros / 1_000_000).toString() : "";
}

function parsePrice(value: string) {
  if (!value.trim()) return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number * 1_000_000));
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

function modelProfileSignature(profile: ModelProfileInput) {
  return JSON.stringify({
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
    inputPriceMicrosPerMillion: profile.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: profile.outputPriceMicrosPerMillion,
    priceCurrency: profile.priceCurrency,
  });
}

export function ModelProfileSettings(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [form, setForm] = useState<ModelProfileInput>(emptyProfile);
  const [savedSignature, setSavedSignature] = useState(() => modelProfileSignature(emptyProfile));
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProfile = profiles.data?.find((item) => item.id === editingProfileId);
  const availablePresets = modelPresets[form.provider];
  const selectedPreset = availablePresets.find((preset) => preset.id === form.modelId);
  const officialFlashPricing = isDeepSeekFlash(form) ? deepSeekFlashPricing() : null;
  const profileDirty = modelProfileSignature(form) !== savedSignature || Boolean(secret.trim());
  const validationError = !form.name.trim() ? "请填写配置名称"
    : !form.modelId.trim() ? "请填写服务商提供的模型 ID"
    : !/^https?:\/\/[^/\s]+(?:\/[^\s]*)?$/i.test(form.baseUrl.trim()) ? "API 地址须为有效的 http:// 或 https:// 地址"
    : !Number.isInteger(form.contextWindow) || form.contextWindow < 256 ? "上下文上限须为至少 256 的整数"
    : !Number.isInteger(form.maxOutputTokens) || form.maxOutputTokens < 1 || form.maxOutputTokens > form.contextWindow ? "最大输出须为正整数，且不能超过上下文上限"
    : !Number.isInteger(form.timeoutSeconds) || form.timeoutSeconds < 1 || form.timeoutSeconds > 600 ? "超时秒数须为 1 至 600 的整数"
    : !Number.isInteger(form.retryLimit) || form.retryLimit < 0 || form.retryLimit > 3 ? "重试次数须为 0 至 3 的整数"
    : null;
  useUnsavedChangesGuard(profileDirty, "当前模型 API 配置有未保存修改。");

  useEffect(() => {
    props.onDirtyChange?.(profileDirty);
    return () => props.onDirtyChange?.(false);
  }, [profileDirty, props.onDirtyChange]);

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
      inputPriceMicrosPerMillion: profile.inputPriceMicrosPerMillion,
      outputPriceMicrosPerMillion: profile.outputPriceMicrosPerMillion,
      priceCurrency: profile.priceCurrency,
    });
    setSavedSignature(modelProfileSignature({
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
      inputPriceMicrosPerMillion: profile.inputPriceMicrosPerMillion,
      outputPriceMicrosPerMillion: profile.outputPriceMicrosPerMillion,
      priceCurrency: profile.priceCurrency,
    }));
  }, [editingProfileId, profiles.data]);

  function startNew() {
    if (profileDirty && !window.confirm("当前模型配置有未保存修改，确定新建配置吗？")) return;
    const next = { ...emptyProfile, name: "新模型配置" };
    setEditingProfileId(null);
    setForm(next);
    setSavedSignature(modelProfileSignature(next));
    setSecret("");
    setShowSecret(false);
    setError(null);
    setNotice("已创建新的配置草稿，填写后保存即可。");
  }

  function selectProfile(profile: NonNullable<typeof selectedProfile>) {
    if (profile.id === editingProfileId) return;
    if (profile.id !== editingProfileId && profileDirty && !window.confirm("当前模型配置有未保存修改，确定切换吗？")) return;
    setEditingProfileId(profile.id);
    setSecret("");
    setShowSecret(false);
    setError(null);
    setNotice(null);
  }

  function selectProvider(provider: ModelProfileInput["provider"]) {
    const preset = modelPresets[provider][0];
    setForm({
      ...form,
      provider,
      baseUrl: providerBaseUrls[provider],
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
    if (validationError) throw new Error(validationError);
    const profileToSave = officialFlashPricing
      ? { ...form, inputPriceMicrosPerMillion: officialFlashPricing.inputCacheMissMicrosPerMillion, outputPriceMicrosPerMillion: officialFlashPricing.outputMicrosPerMillion, priceCurrency: officialFlashPricing.currency }
      : form;
    const saved = await upsertModelProfile(profileToSave);
    if (secret.trim()) {
      await saveModelSecret(saved.id, secret.trim());
      setSecret("");
    }
    setEditingProfileId(saved.id);
    const nextForm = { ...profileToSave, id: saved.id };
    setForm(nextForm);
    setSavedSignature(modelProfileSignature(nextForm));
    await client.invalidateQueries({ queryKey: ["model-profiles"] });
    return saved;
  }

  async function saveProfile() {
    setBusy("save");
    setError(null);
    setNotice(null);
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
    setNotice(null);
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
    if (!window.confirm("删除此模型的 API Key 后，使用该模型的 AI 任务将无法运行。确定删除吗？")) return;
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
      <div><span className="settings-scope-label">本机配置 · 所有作品共用</span><h2>模型 API</h2><p>写作与分析使用聊天模型，知识检索使用向量模型。</p></div>
      <a href="#ai-task-models" className="settings-text-link">任务模型<ArrowRight size={14} /></a>
    </div>
    {profiles.isPending ? <p className="plan-empty">正在加载模型配置…</p> : null}
    {profiles.isError ? <p className="project-error" role="alert">读取模型配置失败：{errorMessage(profiles.error)} <button className="settings-text-link" onClick={() => void profiles.refetch()}><RotateCcw size={14} />重试</button></p> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}
    <div className="model-profile-workbench">
      <aside className="model-profile-list" aria-label="模型配置列表">
        <div className="model-profile-list-heading">
          <h3>模型配置</h3>
          <button type="button" className="secondary-action icon-command" title="新建模型配置" aria-label="新建模型配置" onClick={startNew} disabled={busy !== null}><Plus size={15} /></button>
        </div>
        <div className="model-profile-list-items">
          {profiles.data?.map((profile) => <button key={profile.id} type="button" className="model-profile-item" data-active={profile.id === editingProfileId || undefined} onClick={() => selectProfile(profile)} disabled={busy !== null} aria-label={`编辑 ${profile.name} ${profile.modelId}`}>
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
        <div className="settings-section-heading"><h3>连接信息</h3><span className="settings-status" data-dirty={profileDirty || undefined}>{profileDirty ? "未保存修改" : editingProfileId ? "已保存" : "新配置"}</span></div>
        <fieldset className="settings-fields" disabled={busy !== null || profiles.isPending || profiles.isError}>
        <div className="model-grid">
          <label>配置名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label>模型用途<select value={form.capability} onChange={(event) => selectCapability(event.target.value as ModelProfileInput["capability"])}><option value="CHAT">写作与分析</option><option value="EMBEDDING">文本向量化</option></select></label>
          <label>云端服务<select value={form.provider} onChange={(event) => selectProvider(event.target.value as ModelProfileInput["provider"])}>
            {form.capability === "EMBEDDING" ? <option value="SILICON_FLOW">硅基流动</option> : <><option value="DEEP_SEEK">DeepSeek</option><option value="OPEN_AI">OpenAI API</option><option value="OPEN_AI_COMPATIBLE">通用 OpenAI-compatible</option></>}
          </select></label>
          <label>模型 ID<select value={selectedPreset?.id ?? "__CUSTOM__"} onChange={(event) => selectModel(event.target.value)}><option value="__CUSTOM__">自定义模型 ID</option>{availablePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
          {!selectedPreset ? <label>自定义模型 ID<input value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} placeholder="输入服务商提供的模型 ID" /></label> : null}
          <label className="model-wide">API Base URL<input aria-label="API Base URL" type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /><small>服务商的接口根地址，不包含 /chat/completions。</small></label>
          <label className="model-wide">API Key<span className="settings-secret-input"><input aria-label="API Key" type={showSecret ? "text" : "password"} value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={selectedProfile?.hasSecret ? "已保存，留空保持原 Key" : "输入服务商的 API Key"} autoComplete="off" /><button type="button" className="icon-command" aria-label={showSecret ? "隐藏 API Key" : "显示 API Key"} title={showSecret ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowSecret(!showSecret)}>{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>仅保存在本机系统凭据库，不写入作品或运行记录。</small></label>
        </div>
        <details className="settings-disclosure">
          <summary>模型限制与计费</summary>
          <div className="model-grid">
          <label>上下文上限<input type="number" min={256} value={form.contextWindow} onChange={(event) => setForm({ ...form, contextWindow: Number(event.target.value) })} /></label>
          <label>最大输出<input type="number" min={1} value={form.maxOutputTokens} onChange={(event) => setForm({ ...form, maxOutputTokens: Number(event.target.value) })} /></label>
          <label>超时秒数<input type="number" min={1} max={600} value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} /></label>
          <label>重试次数<input type="number" min={0} max={3} value={form.retryLimit} onChange={(event) => setForm({ ...form, retryLimit: Number(event.target.value) })} /></label>
          {officialFlashPricing ? <div className="model-wide model-pricing-rule" data-period={officialFlashPricing.period}>
            <div className="model-pricing-heading">
              <BadgeDollarSign size={15} />
              <div><strong>官方计费规则</strong><small>DeepSeek Flash</small></div>
              <span className="model-pricing-period"><i />{officialFlashPricing.period === "peak" ? "高峰时段" : "空闲时段"}</span>
            </div>
            <div className="model-pricing-grid">
              <div><span>缓存命中</span><strong>{displayPrice(officialFlashPricing.inputCacheHitMicrosPerMillion)}</strong><small>CNY / 百万 tokens</small></div>
              <div><span>缓存未命中</span><strong>{displayPrice(officialFlashPricing.inputCacheMissMicrosPerMillion)}</strong><small>CNY / 百万 tokens</small></div>
              <div><span>输出</span><strong>{displayPrice(officialFlashPricing.outputMicrosPerMillion)}</strong><small>CNY / 百万 tokens</small></div>
            </div>
            <p><Clock3 size={12} /><span>工作日 09:00-12:00、14:00-18:00 为高峰；未返回缓存用量时按未命中估算。</span></p>
          </div> : <><label>输入单价<span className="model-price-input"><input type="number" min={0} step="0.01" inputMode="decimal" value={displayPrice(form.inputPriceMicrosPerMillion)} onChange={(event) => setForm({ ...form, inputPriceMicrosPerMillion: parsePrice(event.target.value) })} placeholder="例如 2.50" /><select value={form.priceCurrency} onChange={(event) => setForm({ ...form, priceCurrency: event.target.value })}><option value="USD">USD</option><option value="CNY">CNY</option></select></span><small>每 100 万输入 tokens；留空表示不计算费用。</small></label><label>输出单价<span className="model-price-input"><input type="number" min={0} step="0.01" inputMode="decimal" value={displayPrice(form.outputPriceMicrosPerMillion)} onChange={(event) => setForm({ ...form, outputPriceMicrosPerMillion: parsePrice(event.target.value) })} placeholder="例如 10.00" /><select value={form.priceCurrency} onChange={(event) => setForm({ ...form, priceCurrency: event.target.value })}><option value="USD">USD</option><option value="CNY">CNY</option></select></span><small>每 100 万输出 tokens；与输入单价使用同一币种。</small></label></>}
          </div>
        </details>
        </fieldset>
        {validationError ? <p className="settings-field-warning">{validationError}</p> : null}
        <div className="ai-actions settings-save-row"><button type="button" className="primary-action" onClick={() => void saveProfile()} disabled={busy !== null || profiles.isPending || profiles.isError || Boolean(validationError)}><Save size={14} />{busy === "save" ? "保存中…" : "保存配置"}</button><button type="button" className="secondary-action" onClick={() => void testConnection()} disabled={busy !== null || profiles.isPending || profiles.isError || Boolean(validationError) || (!selectedProfile?.hasSecret && !secret.trim())} title={!selectedProfile?.hasSecret && !secret.trim() ? "请先输入 API Key" : "保存当前配置并测试连接"}><PlugZap size={14} />{busy === "test" ? "测试中…" : "测试连接"}</button>{selectedProfile?.hasSecret ? <button type="button" className="secondary-action" onClick={() => void removeSecret()} disabled={busy !== null}><Trash2 size={14} />删除 Key</button> : null}<span className="secret-state"><KeyRound size={13} />{secret.trim() ? "待保存新 Key" : selectedProfile?.hasSecret ? "Key 已就绪" : "缺少 API Key"}</span></div>
      </div>
    </div>
  </div>;
}
