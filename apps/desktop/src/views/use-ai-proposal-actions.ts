import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { decideAiProposal, errorMessage, rateAiProposal, type AiProposal, type AiProposalReview } from "../lib/tauri-client";
import { actionLabels, textContent, type ProposalAnchor } from "./ai-writing-utils";
import { useCandidateEdits } from "./use-candidate-edits";

export function useAiProposalActions(props: {
  chapterId: string; editor: Editor | null; proposals: AiProposalReview[] | undefined;
  onError: (error: string | null) => void;
}) {
  const client = useQueryClient();
  const proposals = props.proposals;
  const setError = props.onError;
  const textEdits = useCandidateEdits();
  const partialTexts = Object.fromEntries(Object.entries(textEdits.entries).map(([id, entry]) => [id, entry.value]));
  const feedbackEdits = useCandidateEdits();
  const feedbackNotes = Object.fromEntries(Object.entries(feedbackEdits.entries).map(([id, entry]) => [id, entry.value]));
  const [decidingProposalId, setDecidingProposalId] = useState<string | null>(null);
  const [feedbackBusyId, setFeedbackBusyId] = useState<string | null>(null);
  const [unappliedCandidate, setUnappliedCandidate] = useState<{ proposal: AiProposal; text: string } | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [proposalAnchors, setProposalAnchors] = useState<Record<string, ProposalAnchor>>({});
  const [lastApplied, setLastApplied] = useState<{ documentJson: string; label: string } | null>(null);

  useEffect(() => {
    setCompareIds([]);
    setProposalAnchors({});
    setLastApplied(null);
    setUnappliedCandidate(null);
  }, [props.chapterId]);

  function resolveReplacementRange(proposal: AiProposal) {
    if (!props.editor || (proposal.action !== "REWRITE" && proposal.action !== "POLISH")) return null;
    const anchor = proposalAnchors[proposal.id];
    if (anchor) {
      const currentSelection = props.editor.state.doc.textBetween(anchor.from, anchor.to, "\n").trim();
      return currentSelection === anchor.selection
        ? { from: anchor.from, to: anchor.to, source: "stored" as const }
        : null;
    }
    const { from, to, empty } = props.editor.state.selection;
    if (empty) return null;
    return { from, to, source: "current" as const };
  }

  function applyText(proposal: AiProposal, text: string, range?: { from: number; to: number }) {
    if (!props.editor || proposal.action === "SUMMARIZE") return false;
    const previousDocument = JSON.stringify(props.editor.getJSON());
    if (proposal.action === "DRAFT") {
      props.editor.commands.setContent({ type: "doc", content: textContent(text) });
    } else if (proposal.action === "CONTINUE") {
      props.editor.commands.insertContentAt(props.editor.state.doc.content.size, textContent(text));
    } else if (range) {
      props.editor.commands.insertContentAt(range, textContent(text));
    } else {
      return false;
    }
    setLastApplied({ documentJson: previousDocument, label: actionLabels[proposal.action] });
    return true;
  }

  function undoLastApplied() {
    if (!props.editor || !lastApplied) return;
    try {
      props.editor.commands.setContent(JSON.parse(lastApplied.documentJson), { emitUpdate: true });
      setLastApplied(null);
      setError(null);
    } catch {
      setError("无法撤销上一次应用，请使用正文历史版本恢复。");
    }
  }

  async function decide(proposal: AiProposal, mode: "ACCEPTED" | "REJECTED") {
    if (feedbackBusyId !== null) return;
    if (mode === "ACCEPTED" && unappliedCandidate) {
      setError("请先处理暂未写入的候选，再采用其他候选。");
      return;
    }
    setError(null);
    const textChanged = textEdits.entries[proposal.id]?.value !== textEdits.entries[proposal.id]?.baseline;
    const feedbackChanged = feedbackEdits.entries[proposal.id]?.value !== feedbackEdits.entries[proposal.id]?.baseline;
    if (((mode === "REJECTED" && textChanged) || feedbackChanged)
      && !window.confirm("这条候选有未提交的文本或评价修改。继续处理将丢弃未提交部分，确定继续吗？")) return;
    const proposalValidation = proposals?.find((item) => item.proposal.id === proposal.id)?.validation;
    if (mode !== "REJECTED" && proposalValidation?.status === "NEEDS_INPUT") {
      setError("这次结果没有生成正文，需要先补齐模型列出的关键设定。");
      return;
    }
    if (mode !== "REJECTED" && proposal.action === "DRAFT" && props.editor?.getText().trim() && !window.confirm("应用整章创作候选会替换当前正文草稿。确定继续吗？")) return;
    const replacementRange = mode !== "REJECTED" ? resolveReplacementRange(proposal) : null;
    if (mode !== "REJECTED" && proposal.action !== "SUMMARIZE") {
      if (!props.editor) {
        setError("正文编辑器尚未准备好。");
        return;
      }
      if ((proposal.action === "REWRITE" || proposal.action === "POLISH") && !replacementRange) {
        setError("生成候选后原文已经变化，系统为避免替换错位置已停止应用。请撤销正文改动，或重新生成候选。");
        return;
      }
    }
    setDecidingProposalId(proposal.id);
    const originalDocument = props.editor ? JSON.stringify(props.editor.getJSON()) : null;
    try {
      const candidateText = partialTexts[proposal.id] ?? proposal.outputText;
      const candidateWasEdited = mode === "ACCEPTED" && candidateText !== proposal.outputText;
      const decided = await decideAiProposal({
        id: proposal.id,
        status: candidateWasEdited ? "PARTIALLY_ACCEPTED" : mode,
        ...(candidateWasEdited ? { acceptedText: candidateText } : {}),
      });
      if (mode !== "REJECTED" && proposal.action !== "SUMMARIZE") {
        const acceptedText = decided.acceptedText ?? candidateText;
        if (props.editor && JSON.stringify(props.editor.getJSON()) !== originalDocument) {
          setUnappliedCandidate({ proposal, text: acceptedText });
          setError("正文在确认期间发生变化，采用结果已记录，但尚未写入草稿。");
        } else {
          applyText(proposal, acceptedText, replacementRange ?? undefined);
        }
      }
      textEdits.discard(proposal.id);
      feedbackEdits.discard(proposal.id);
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setDecidingProposalId(null); }
  }

  async function submitFeedback(proposal: AiProposal, rating: "HELPFUL" | "NOT_HELPFUL") {
    setError(null);
    setFeedbackBusyId(proposal.id);
    const submitted = feedbackNotes[proposal.id] ?? proposals?.find((item) => item.proposal.id === proposal.id)?.feedback?.note ?? "";
    try {
      await rateAiProposal(proposal.id, rating, submitted.trim() || undefined);
      feedbackEdits.acknowledge(proposal.id, submitted, submitted.trim());
      await client.invalidateQueries({ queryKey: ["ai-proposals", props.chapterId] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setFeedbackBusyId(null);
    }
  }

  function toggleCompare(proposalId: string) {
    setCompareIds((current) => current.includes(proposalId)
      ? current.filter((id) => id !== proposalId)
      : current.length >= 2 ? [current[1]!, proposalId] : [...current, proposalId]);
  }

  return {
    textEdits, partialTexts, feedbackEdits, feedbackNotes, decidingProposalId, feedbackBusyId,
    unappliedCandidate, setUnappliedCandidate, compareIds, proposalAnchors, setProposalAnchors, lastApplied,
    resolveReplacementRange, applyText, undoLastApplied, decide, submitFeedback, toggleCompare,
  };
}
