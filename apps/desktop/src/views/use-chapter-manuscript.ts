import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useState } from "react";
import {
  clearRecoveryLogs, currentManuscript, enqueueChapterSummaryRefresh, errorMessage,
  listManuscriptRevisions, listRecoveryLogs, mergeManuscript, saveManuscriptChecked,
  saveRecoveryLog, type ManuscriptRevision, type MergeResult,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import type { ManuscriptWorkspaceTab } from "./manuscript-workspace-tabs";
import { candidateReviewTransferKey, documentToJson, writingCandidateTransferKey } from "./project-workspace-utils";

type DraftSnapshot = {
  chapterId: string;
  documentJson: string;
  baseDocumentJson: string;
  baseRevisionId: string | undefined;
};

export function useChapterManuscript({
  chapterId,
  projectId,
  mode,
  onError,
}: {
  chapterId: string | undefined;
  projectId: string | undefined;
  mode: "planning" | "chapters" | "writing";
  onError: (message: string | null) => void;
}) {
  const client = useQueryClient();
  const enabled = Boolean(chapterId && mode !== "planning");
  const [manuscriptTab, setManuscriptTab] = useState<ManuscriptWorkspaceTab>("manuscript");
  const manuscript = useQuery({
    queryKey: ["manuscript", chapterId],
    queryFn: () => currentManuscript(chapterId!),
    enabled,
  });
  const history = useQuery({
    queryKey: ["manuscript-history", chapterId],
    queryFn: () => listManuscriptRevisions(chapterId!),
    enabled: enabled && manuscriptTab === "versions",
  });
  const recovery = useQuery({
    queryKey: ["recovery-logs", chapterId],
    queryFn: () => listRecoveryLogs(chapterId!),
    enabled,
  });
  const [snapshot, setSnapshot] = useState<DraftSnapshot>({
    chapterId: "", documentJson: "", baseDocumentJson: "", baseRevisionId: undefined,
  });
  const draft = snapshot.chapterId === chapterId ? snapshot.documentJson : "";
  const chapterDirty = enabled && snapshot.chapterId === chapterId && draft !== snapshot.baseDocumentJson;
  const [savingDraft, setSavingDraft] = useState(false);
  const [clearingRecovery, setClearingRecovery] = useState(false);
  const [transferringCandidate, setTransferringCandidate] = useState(false);
  const [manuscriptMemoryNeedsRefresh, setManuscriptMemoryNeedsRefresh] = useState(false);
  const [refreshingChapterMemory, setRefreshingChapterMemory] = useState(false);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);

  const setDraft = useCallback((documentJson: string) => {
    setSnapshot((current) => current.chapterId === chapterId ? { ...current, documentJson } : current);
  }, [chapterId]);

  const editor = useEditor({
    extensions: [StarterKit],
    content: documentToJson(""),
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: "tiptap-editor" } },
    onUpdate: ({ editor: currentEditor }) => setDraft(JSON.stringify(currentEditor.getJSON())),
  });

  useUnsavedChangesGuard(chapterDirty && !transferringCandidate, "当前章节正文有未保存修改。");

  useEffect(() => {
    setSnapshot({ chapterId: "", documentJson: "", baseDocumentJson: "", baseRevisionId: undefined });
    setManuscriptTab("manuscript");
    setMergeResult(null);
    setCompareLeftId(null);
    setCompareRightId(null);
    setManuscriptMemoryNeedsRefresh(false);
    setTransferringCandidate(false);
  }, [chapterId]);

  useEffect(() => {
    if (!enabled || !chapterId || !manuscript.isSuccess || !editor) return;
    const sameChapter = snapshot.chapterId === chapterId;
    // A refetch must not replace a local candidate or advance its conflict-check baseline.
    if (sameChapter && (chapterDirty || snapshot.baseRevisionId === manuscript.data?.id)) return;
    const next = manuscript.data?.documentJson ?? "";
    setSnapshot({ chapterId, documentJson: next, baseDocumentJson: next, baseRevisionId: manuscript.data?.id });
    editor.commands.setContent(documentToJson(next), { emitUpdate: false });
  }, [chapterDirty, chapterId, editor, enabled, manuscript.data, manuscript.isSuccess, snapshot.baseRevisionId, snapshot.chapterId]);

  useEffect(() => {
    if (mode !== "writing" || !chapterId || !projectId || !manuscript.isSuccess || !editor || snapshot.chapterId !== chapterId) return;
    try {
      const stored = window.sessionStorage.getItem(writingCandidateTransferKey);
      if (!stored) return;
      const transfer = JSON.parse(stored) as { projectId?: string; chapterId?: string; documentJson?: string };
      if (transfer.projectId !== projectId || transfer.chapterId !== chapterId || !transfer.documentJson?.trim()) return;
      setDraft(transfer.documentJson);
      editor.commands.setContent(documentToJson(transfer.documentJson), { emitUpdate: false });
      setManuscriptTab("candidate");
      window.sessionStorage.removeItem(writingCandidateTransferKey);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }, [chapterId, editor, manuscript.isSuccess, mode, onError, projectId, setDraft, snapshot.chapterId]);

  useEffect(() => {
    if (history.data && history.data.length >= 2 && (!compareLeftId || !compareRightId)) {
      setCompareLeftId(history.data[1].id);
      setCompareRightId(history.data[0].id);
    }
  }, [history.data, compareLeftId, compareRightId]);

  useEffect(() => {
    if (!chapterId || !chapterDirty || !draft.trim() || savingDraft) return;
    const timer = window.setTimeout(() => {
      void saveRecoveryLog({ chapterId, documentJson: draft }).catch((cause) => onError(errorMessage(cause)));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [chapterDirty, chapterId, draft, onError, savingDraft]);

  async function invalidateManuscript(chapter: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["manuscript", chapter] }),
      client.invalidateQueries({ queryKey: ["manuscript-history", chapter] }),
      client.invalidateQueries({ queryKey: ["recovery-logs", chapter] }),
      client.invalidateQueries({ queryKey: ["recovery-all"] }),
    ]);
  }

  async function saveDraft(showManuscriptAfterSave = false) {
    if (!chapterId || !chapterDirty || !draft.trim() || savingDraft) return;
    setSavingDraft(true);
    onError(null);
    try {
      const saved = await saveManuscriptChecked({
        chapterId, baseRevisionId: snapshot.baseRevisionId, documentJson: draft, creationReason: "MANUAL_SAVE",
      });
      if (editor && JSON.stringify(editor.getJSON()) === draft) {
        editor.commands.setContent(documentToJson(saved.documentJson), { emitUpdate: false });
      }
      setSnapshot((current) => current.chapterId !== chapterId ? current : {
        ...current,
        documentJson: current.documentJson === draft ? saved.documentJson : current.documentJson,
        baseDocumentJson: saved.documentJson,
        baseRevisionId: saved.id,
      });
      client.setQueryData(["manuscript", chapterId], saved);
      await clearRecoveryLogs(chapterId);
      await invalidateManuscript(chapterId);
      setManuscriptMemoryNeedsRefresh(true);
      if (showManuscriptAfterSave && mode === "writing") setManuscriptTab("manuscript");
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setSavingDraft(false);
    }
  }

  async function refreshChapterMemory() {
    if (!chapterId) return;
    setRefreshingChapterMemory(true);
    onError(null);
    try {
      await enqueueChapterSummaryRefresh(chapterId);
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setManuscriptMemoryNeedsRefresh(false);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setRefreshingChapterMemory(false);
    }
  }

  function loadCandidate(documentJson: string) {
    setDraft(documentJson);
    editor?.commands.setContent(documentToJson(documentJson), { emitUpdate: false });
    setManuscriptTab("candidate");
  }

  function recoverLatest() {
    const latest = recovery.data?.[0];
    if (!latest || !chapterId) return;
    if (chapterDirty && !window.confirm("当前编辑器有未保存修改。载入异常草稿会替换这些修改，确定继续吗？")) return;
    loadCandidate(latest.documentJson);
  }

  function storeCandidate(documentJson: string) {
    if (!chapterId || !projectId) throw new Error("项目或章节尚未就绪");
    window.sessionStorage.setItem(writingCandidateTransferKey, JSON.stringify({ projectId, chapterId, documentJson }));
  }

  function openWritingCandidate() {
    if (!chapterId || !draft.trim()) return;
    try {
      storeCandidate(draft);
      setTransferringCandidate(true);
      window.setTimeout(() => { window.location.href = `/writing#${chapterId}`; }, 0);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }

  function openCandidateReview() {
    if (!chapterId || !draft.trim()) return;
    let changedSinceReview = true;
    try {
      const stored = window.sessionStorage.getItem(candidateReviewTransferKey);
      const previous = stored ? JSON.parse(stored) as { chapterId?: string; documentJson?: string } : null;
      changedSinceReview = previous?.chapterId !== chapterId || previous.documentJson !== draft;
    } catch {
      // An unreadable snapshot is treated as a new review.
    }
    if (chapterDirty && changedSinceReview && !window.confirm("当前候选有未同步修改。将以当前版本作为审核快照，前往审核吗？")) return;
    try {
      storeCandidate(draft);
      window.sessionStorage.setItem(candidateReviewTransferKey, JSON.stringify({ chapterId, documentJson: draft }));
      setTransferringCandidate(true);
      window.setTimeout(() => { window.location.href = `/review?tab=manuscript&chapterId=${encodeURIComponent(chapterId)}`; }, 0);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }

  async function discardRecoveryLogs() {
    if (!chapterId || !recovery.data?.length) return;
    if (!window.confirm(`确认不需要恢复这 ${recovery.data.length} 次自动保护记录吗？删除记录不会修改当前正文或已保存版本。`)) return;
    setClearingRecovery(true);
    onError(null);
    try {
      await clearRecoveryLogs(chapterId);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["recovery-logs", chapterId] }),
        client.invalidateQueries({ queryKey: ["recovery-all"] }),
      ]);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setClearingRecovery(false);
    }
  }

  async function mergeDraft() {
    if (!manuscript.data || !draft.trim()) return;
    try {
      setMergeResult(await mergeManuscript({ base: snapshot.baseDocumentJson, current: manuscript.data.documentJson, draft }));
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }

  function restoreRevision(revision: ManuscriptRevision) {
    if (!chapterId) return;
    if (chapterDirty && !window.confirm("当前编辑器有未保存修改。载入历史版本会替换这些修改，确定继续吗？")) return;
    loadCandidate(revision.documentJson);
    onError(null);
  }

  return {
    manuscript, history, recovery, draft, setDraft, editor, chapterDirty,
    manuscriptTab, setManuscriptTab, savingDraft, clearingRecovery, transferringCandidate,
    manuscriptMemoryNeedsRefresh, refreshingChapterMemory, compareLeftId, setCompareLeftId,
    compareRightId, setCompareRightId, mergeResult, saveDraft, refreshChapterMemory,
    recoverLatest, openWritingCandidate, openCandidateReview, discardRecoveryLogs,
    mergeDraft, restoreRevision, loadCandidate,
  };
}
