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
import { resolveTaskChatProfile, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { AiModelNote } from "./ai-model-note";

const actionLabels: Record<AiAction, string> = {
  DRAFT: "AI 创作整章",
  CONTINUE: "续写",
  REWRITE: "重写选区",
  POLISH: "润色选区",
  SUMMARIZE: "章节摘要",
};
const editingActions: AiAction[] = ["CONTINUE", "REWRITE", "POLISH", "SUMMARIZE"];

function textContent(text: string) {
  return text.split(/\r?\n/).map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : undefined,
  }));
}

export function AiWritingPanel(props: { chapterId: string; chapterTitle: string; chapterPlan: string; draft: string; editor: Editor | null }) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const aiPreferences = useAiTaskPreferences();
  const proposals = useQuery({ queryKey: ["ai-proposals", props.chapterId], queryFn: () => listAiProposals(props.chapterId) });
  const [instruction, setInstruction] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [partialTexts, setPartialTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [decidingProposalId, setDecidingProposalId] = useState<string | null>(null);

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
    const chatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "writing");
    if (!chatProfile || !props.editor) return;
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
        profileId: chatProfile.id,
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
    if (proposal.action === "DRAFT") {
      props.editor.commands.setContent({ type: "doc", content: textContent(text) });
      return;
    }
    if (proposal.action === "CONTINUE") {
      props.editor.commands.insertContentAt(props.editor.state.doc.content.size, textContent(text));
      return;
    }
    const { from, to } = props.editor.state.selection;
    props.editor.commands.insertContentAt({ from, to }, textContent(text));
  }

  async function decide(proposal: AiProposal, mode: "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED") {
    setError(null);
    if (mode !== "REJECTED" && proposal.action === "DRAFT" && props.editor?.getText().trim() && !window.confirm("应用整章创作候选会替换当前正文草稿。确定继续吗？")) return;
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

  const selectedChatProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "writing");
  const pending = proposals.data?.filter((item) => item.status === "PENDING") ?? [];

  return <section className="ai-panel" aria-label="AI 创作">
    <div className="section-heading"><h2><Sparkles size={15} />AI 创作</h2><span>云端 API · Proposal 审核</span></div>
    <AiModelNote taskLabel="正文书写" profile={selectedChatProfile} />
    <label className="ai-instruction">本章补充意见<textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：让冲突逐步升级，保留主角的克制感；控制在 3000 字左右，结尾留下身份线索" /></label>
    <p className="ai-request-hint">系统会把这段意见与章节执行卡、写作规则和正文上下文一起编译成模型消息。</p>
    <div className="ai-draft-action"><div><strong>按章节执行卡创作整章</strong><span>AI 会参考章节目标、关键冲突、结尾钩子和项目上下文生成完整初稿，确认后替换到正文。</span></div><button type="button" className="primary-action" onClick={() => void runAction("DRAFT")} disabled={busy || !selectedChatProfile?.hasSecret}><Sparkles size={14} />生成整章初稿</button></div>
    <div className="ai-action-grid">{editingActions.map((action) => <button type="button" className="secondary-action" key={action} onClick={() => void runAction(action)} disabled={busy || !selectedChatProfile?.hasSecret}><Play size={14} />{actionLabels[action]}</button>)}</div>
    {busy ? <div className="ai-running"><LoaderCircle size={15} className="spin" /><span>模型正在生成候选…</span><button type="button" className="secondary-action" onClick={() => void cancel()} disabled={!activeTaskId}><Ban size={14} />取消</button></div> : null}
    {preview ? <pre className="ai-preview">{preview}</pre> : null}
    {error ? <p className="project-error" role="alert">{error}</p> : null}

    {pending.length ? <div className="proposal-list"><div className="section-heading"><h3>待审核候选</h3><span>{pending.length} 条</span></div>{pending.map((proposal) => <article className="proposal" key={proposal.id}>
      <div className="proposal-meta"><strong>{actionLabels[proposal.action]}</strong><code>{proposal.promptVersion}</code></div>
      <textarea value={partialTexts[proposal.id] ?? proposal.outputText} onChange={(event) => setPartialTexts((value) => ({ ...value, [proposal.id]: event.target.value }))} aria-label={`${actionLabels[proposal.action]}候选文本`} />
      <div className="ai-actions"><button type="button" className="primary-action" onClick={() => void decide(proposal, "ACCEPTED")} disabled={decidingProposalId !== null}><Check size={14} />{decidingProposalId === proposal.id ? "处理中…" : proposal.action === "SUMMARIZE" ? "保留摘要" : proposal.action === "DRAFT" ? "应用到正文（整章替换）" : "全部应用到草稿"}</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "PARTIALLY_ACCEPTED")} disabled={decidingProposalId !== null}><Check size={14} />应用编辑后的文本</button><button type="button" className="secondary-action" onClick={() => void decide(proposal, "REJECTED")} disabled={decidingProposalId !== null}><Trash2 size={14} />拒绝</button></div>
    </article>)}</div> : null}
  </section>;
}
