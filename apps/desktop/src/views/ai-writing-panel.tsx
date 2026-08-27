import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/react";
import { Ban, Check, KeyRound, LoaderCircle, Play, PlugZap, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  cancelAiTask,
  decideAiProposal,
  deleteModelSecret,
  errorMessage,
  generateAiProposal,
  listAiProposals,
  listModelProfiles,
  saveModelSecret,
  testModelProfile,
  upsertModelProfile,
  type AiAction,
  type AiProposal,
  type ModelProfileInput,
} from "../lib/tauri-client";

const actionLabels: Record<AiAction, string> = {
  CONTINUE: "续写",
  REWRITE: "重写选区",
  POLISH: "润色选区",
  SUMMARIZE: "章节摘要",
};

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

function textContent(text: string) {
  return text.split(/\r?\n/).map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : undefined,
  }));
}

export function AiWritingPanel(props: { chapterId: string; chapterTitle: string; chapterPlan: string; draft: string; editor: Editor | null }) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const proposals = useQuery({ queryKey: ["ai-proposals", props.chapterId], queryFn: () => listAiProposals(props.chapterId) });
  const [editingProfileId, setEditingProfileId] = useState("");
  const [chatProfileId, setChatProfileId] = useState("");
  const [form, setForm] = useState<ModelProfileInput>(emptyProfile);
  const [secret, setSecret] = useState("");
  const [instruction, setInstruction] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [partialTexts, setPartialTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!editingProfileId && profiles.data?.[0]) setEditingProfileId(profiles.data[0].id);
    const firstChat = profiles.data?.find((item) => item.capability === "CHAT");
    if (!chatProfileId && firstChat) setChatProfileId(firstChat.id);
  }, [chatProfileId, editingProfileId, profiles.data]);

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
      privacyLevel: "ALLOW_CLOUD",
      timeoutSeconds: profile.timeoutSeconds,
      retryLimit: profile.retryLimit,
    });
  }, [editingProfileId, profiles.data]);

  useEffect(() => {
    let disposed = false;
    const subscriptions = Promise.all([
      listen<{ taskId: string }>("ai-task-started", ({ payload }) => {
        if (!disposed) { setActiveTaskId(payload.taskId); setPreview(""); }
      }),
      listen<{ taskId: string; chunk: string }>("ai-task-chunk", ({ payload }) => {
        if (!disposed) { setActiveTaskId(payload.taskId); setPreview((value) => value + payload.chunk); }
      }),
    ]);
    return () => { disposed = true; void subscriptions.then((items) => items.forEach((unlisten) => unlisten())); };
  }, []);

  async function saveProfile() {
    setError(null);
    try {
      const saved = await upsertModelProfile(form);
      if (secret.trim()) {
        await saveModelSecret(saved.id, secret.trim());
        setSecret("");
      }
      setEditingProfileId(saved.id);
      if (saved.capability === "CHAT") setChatProfileId(saved.id);
      await client.invalidateQueries({ queryKey: ["model-profiles"] });
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function removeSecret() {
    if (!editingProfileId) return;
    setError(null);
    try {
      await deleteModelSecret(editingProfileId);
      await client.invalidateQueries({ queryKey: ["model-profiles"] });
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function testConnection() {
    if (!editingProfileId) return;
    setError(null);
    setConnectionStatus("正在测试连接…");
    try {
      const result = await testModelProfile(editingProfileId);
      setConnectionStatus(result.detail);
    } catch (cause) {
      setConnectionStatus(null);
      setError(errorMessage(cause));
    }
  }

  async function runAction(action: AiAction) {
    if (!chatProfileId || !props.editor) return;
    const { from, to } = props.editor.state.selection;
    const selection = props.editor.state.doc.textBetween(from, to, "\n").trim();
    if ((action === "REWRITE" || action === "POLISH") && !selection) {
      setError("请先在正文编辑器中选择需要处理的文字。");
      return;
    }
    setBusy(true);
    setError(null);
    setPreview("");
    try {
      const proposal = await generateAiProposal({
        profileId: chatProfileId,
        chapterId: props.chapterId,
        action,
        chapterTitle: props.chapterTitle,
        chapterPlan: props.chapterPlan,
        documentJson: props.draft || JSON.stringify(props.editor.getJSON()),
        ...(selection ? { selection } : {}),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        stream: true,
      });
      setPartialTexts((value) => ({ ...value, [proposal.id]: proposal.outputText }));
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); setActiveTaskId(null); }
  }

  async function cancel() {
    if (!activeTaskId) return;
    try { await cancelAiTask(activeTaskId); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  function applyText(proposal: AiProposal, text: string) {
    if (!props.editor || proposal.action === "SUMMARIZE") return;
    if (proposal.action === "CONTINUE") {
      props.editor.commands.insertContentAt(props.editor.state.doc.content.size, textContent(text));
      return;
    }
    const { from, to } = props.editor.state.selection;
    if (from === to) throw new Error("应用重写或润色结果前，请在正文中重新选择要替换的范围。");
    props.editor.commands.insertContentAt({ from, to }, textContent(text));
  }

  async function decide(proposal: AiProposal, mode: "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED") {
    setError(null);
    try {
      const acceptedText = mode === "PARTIALLY_ACCEPTED" ? partialTexts[proposal.id] : undefined;
      const decided = await decideAiProposal({ id: proposal.id, status: mode, ...(acceptedText ? { acceptedText } : {}) });
      if (mode !== "REJECTED") applyText(proposal, decided.acceptedText ?? proposal.outputText);
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const selectedProfile = profiles.data?.find((item) => item.id === editingProfileId);
  const chatProfiles = profiles.data?.filter((item) => item.capability === "CHAT") ?? [];
  const selectedChatProfile = chatProfiles.find((item) => item.id === chatProfileId);
  const pending = proposals.data?.filter((item) => item.status === "PENDING") ?? [];

  return <section className="ai-panel" aria-label="AI 创作">
    <div className="section-heading"><h2><Sparkles size={15} />AI 创作</h2><span>云端 API · Proposal 审核</span></div>
    <details className="model-settings" open={!profiles.data?.length}>
      <summary>模型配置</summary>
      <div className="model-profile-switcher">
      {profiles.data?.length ? <select value={editingProfileId} onChange={(event) => { setEditingProfileId(event.target.value); setConnectionStatus(null); }} aria-label="模型配置">
        {profiles.data.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelId}</option>)}
      </select> : null}
      <button type="button" className="secondary-action icon-command" title="新建模型配置" aria-label="新建模型配置" onClick={() => { setEditingProfileId(""); setForm(emptyProfile); setSecret(""); setConnectionStatus(null); }}><Plus size={15} /></button>
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
      <div className="ai-actions"><button type="button" className="primary-action" onClick={() => void saveProfile()} disabled={!form.name.trim() || !form.modelId.trim()}><Save size={14} />保存配置</button>{selectedProfile?.hasSecret ? <><button type="button" className="secondary-action" onClick={() => void testConnection()}><PlugZap size={14} />测试连接</button><button type="button" className="secondary-action" onClick={() => void removeSecret()}><Trash2 size={14} />删除 Key</button></> : null}<span className="secret-state"><KeyRound size={13} />{selectedProfile?.hasSecret ? "Key 已就绪" : "尚未设置 Key"}</span></div>
      {connectionStatus ? <p className="connection-status" role="status">{connectionStatus}</p> : null}
    </details>

    <label className="ai-instruction">写作模型<select value={chatProfileId} onChange={(event) => setChatProfileId(event.target.value)}>{chatProfiles.length ? chatProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelId}</option>) : <option value="">请先配置 DeepSeek 或 OpenAI API</option>}</select></label>
    <label className="ai-instruction">自然语言创作要求<input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：让这一段更紧张，控制在 300 字内" /></label>
    <p className="ai-request-hint">系统会把这句话与任务合同、章节规划和正文上下文编译成模型消息，再发送给已选云端 API。</p>
    <div className="ai-action-grid">{(Object.keys(actionLabels) as AiAction[]).map((action) => <button type="button" className="secondary-action" key={action} onClick={() => void runAction(action)} disabled={busy || !chatProfileId || !selectedChatProfile?.hasSecret}><Play size={14} />{actionLabels[action]}</button>)}</div>
    {busy ? <div className="ai-running"><LoaderCircle size={15} className="spin" /><span>模型正在生成候选…</span><button type="button" className="secondary-action" onClick={() => void cancel()} disabled={!activeTaskId}><Ban size={14} />取消</button></div> : null}
    {preview ? <pre className="ai-preview">{preview}</pre> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}

    {pending.length ? <div className="proposal-list"><div className="section-heading"><h3>待审核候选</h3><span>{pending.length} 条</span></div>{pending.map((proposal) => <article className="proposal" key={proposal.id}>
      <div className="proposal-meta"><strong>{actionLabels[proposal.action]}</strong><code>{proposal.promptVersion}</code></div>
      <textarea value={partialTexts[proposal.id] ?? proposal.outputText} onChange={(event) => setPartialTexts((value) => ({ ...value, [proposal.id]: event.target.value }))} aria-label={`${actionLabels[proposal.action]}候选文本`} />
      <div className="ai-actions"><button type="button" className="primary-action" onClick={() => void decide(proposal, "ACCEPTED")}><Check size={14} />{proposal.action === "SUMMARIZE" ? "保留摘要" : "全部应用到草稿"}</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "PARTIALLY_ACCEPTED")}><Check size={14} />应用编辑后的文本</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")}><Trash2 size={14} />拒绝</button></div>
    </article>)}</div> : null}
  </section>;
}
