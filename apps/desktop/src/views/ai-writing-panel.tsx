import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/react";
import { Ban, Check, LoaderCircle, Play, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  cancelAiTask,
  decideAiProposal,
  errorMessage,
  generateAiProposal,
  listAiProposals,
  listModelProfiles,
  type AiAction,
  type AiProposal,
} from "../lib/tauri-client";

const actionLabels: Record<AiAction, string> = {
  CONTINUE: "续写",
  REWRITE: "重写选区",
  POLISH: "润色选区",
  SUMMARIZE: "章节摘要",
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
  const [chatProfileId, setChatProfileId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [partialTexts, setPartialTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [decidingProposalId, setDecidingProposalId] = useState<string | null>(null);

  useEffect(() => {
    const firstChat = profiles.data?.find((item) => item.capability === "CHAT");
    if (!chatProfileId && firstChat) setChatProfileId(firstChat.id);
  }, [chatProfileId, profiles.data]);

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
    props.editor.commands.insertContentAt({ from, to }, textContent(text));
  }

  async function decide(proposal: AiProposal, mode: "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED") {
    setError(null);
    if (mode !== "REJECTED" && proposal.action !== "SUMMARIZE") {
      if (!props.editor) {
        setError("正文编辑器尚未准备好。");
        return;
      }
      if ((proposal.action === "REWRITE" || proposal.action === "POLISH") && props.editor.state.selection.empty) {
        setError("应用重写或润色结果前，请先在正文中重新选择要替换的范围。");
        return;
      }
    }
    setDecidingProposalId(proposal.id);
    try {
      const acceptedText = mode === "PARTIALLY_ACCEPTED" ? partialTexts[proposal.id] : undefined;
      const decided = await decideAiProposal({ id: proposal.id, status: mode, ...(acceptedText ? { acceptedText } : {}) });
      if (mode !== "REJECTED") applyText(proposal, decided.acceptedText ?? proposal.outputText);
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setDecidingProposalId(null); }
  }

  const chatProfiles = profiles.data?.filter((item) => item.capability === "CHAT") ?? [];
  const selectedChatProfile = chatProfiles.find((item) => item.id === chatProfileId);
  const pending = proposals.data?.filter((item) => item.status === "PENDING") ?? [];

  return <section className="ai-panel" aria-label="AI 创作">
    <div className="section-heading"><h2><Sparkles size={15} />AI 创作</h2><span>云端 API · Proposal 审核</span></div>
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
      <div className="ai-actions"><button type="button" className="primary-action" onClick={() => void decide(proposal, "ACCEPTED")} disabled={decidingProposalId !== null}><Check size={14} />{decidingProposalId === proposal.id ? "处理中…" : proposal.action === "SUMMARIZE" ? "保留摘要" : "全部应用到草稿"}</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "PARTIALLY_ACCEPTED")} disabled={decidingProposalId !== null}><Check size={14} />应用编辑后的文本</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />拒绝</button></div>
    </article>)}</div> : null}
  </section>;
}
