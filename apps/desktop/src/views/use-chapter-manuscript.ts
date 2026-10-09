import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearRecoveryLogs, enqueueChapterSummaryRefresh, errorMessage,
  currentManuscriptDraft, listManuscriptRevisions, listRecoveryLogs, mergeManuscript,
  saveRecoveryLog, type ManuscriptRevision, type MergeResult,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import type { ManuscriptWorkspaceTab } from "./manuscript-workspace-tabs";
import { candidateReviewTransferKey, documentToJson, writingCandidateTransferKey } from "./project-workspace-utils";
import { manuscriptQuery } from "../lib/manuscript-query";
import { createChapterDraftWriter } from "../lib/chapter-draft-writer";

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
  initialTab = "manuscript",
}: {
  chapterId: string | undefined;
  projectId: string | undefined;
  mode: "planning" | "chapters" | "writing";
  onError: (message: string | null) => void;
  initialTab?: ManuscriptWorkspaceTab;
}) {
  const client = useQueryClient();
  const enabled = Boolean(chapterId && mode !== "planning");
  const [manuscriptTab, setManuscriptTab] = useState<ManuscriptWorkspaceTab>(initialTab);
  const manuscript = useQuery({
    ...manuscriptQuery(chapterId),
    enabled,
  });
  const localDraft = useQuery({
    queryKey: ["manuscript-draft", projectId, chapterId],
    queryFn: () => currentManuscriptDraft(chapterId!),
    enabled, refetchOnWindowFocus: false,
  });
  const writer = useRef<ReturnType<typeof createChapterDraftWriter> | null>(null);
  const savingFormal = useRef(false);
  const [savingLocalDraft, setSavingLocalDraft] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null);
  const [persistenceTick, setPersistenceTick] = useState(0);
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
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const draft = snapshot.chapterId === chapterId ? snapshot.documentJson : "";
  const chapterDirty = enabled && snapshot.chapterId === chapterId && draft !== snapshot.baseDocumentJson;
  const draftReady = enabled && snapshot.chapterId === chapterId && writer.current !== null;
  const persisted = writer.current?.current();
  const draftNeedsPersistence = draftReady && Boolean(chapterDirty || persisted?.documentJson !== null)
    && (persisted?.documentJson !== draft || (persisted?.baseRevisionId ?? undefined) !== snapshot.baseRevisionId);
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

  useUnsavedChangesGuard((draftNeedsPersistence || savingDraft) && !transferringCandidate, "当前章节草稿尚未保存在本地。");

  useEffect(() => {
    setSnapshot({ chapterId: "", documentJson: "", baseDocumentJson: "", baseRevisionId: undefined });
    setManuscriptTab(initialTab);
    setMergeResult(null);
    setCompareLeftId(null);
    setCompareRightId(null);
    setManuscriptMemoryNeedsRefresh(false);
    setTransferringCandidate(false);
    writer.current = null;
    setDraftStorageError(null);
    setSavingLocalDraft(false);
  }, [chapterId, projectId, initialTab]);

  useEffect(() => {
    if (!enabled || !chapterId || !manuscript.isSuccess || !localDraft.isSuccess || !editor) return;
    const sameChapter = snapshot.chapterId === chapterId;
    // A refetch must not replace a local candidate or advance its conflict-check baseline.
    if (sameChapter && (chapterDirty || snapshot.baseRevisionId === manuscript.data?.id)) return;
    if (!sameChapter) writer.current = createChapterDraftWriter(localDraft.data);
    const hasLocalChanges = !sameChapter && localDraft.data.documentJson !== null
      && localDraft.data.documentJson !== localDraft.data.baseDocumentJson;
    const next = hasLocalChanges ? localDraft.data.documentJson! : manuscript.data?.documentJson ?? "";
    setSnapshot({
      chapterId, documentJson: next,
      baseDocumentJson: hasLocalChanges ? localDraft.data.baseDocumentJson : manuscript.data?.documentJson ?? "",
      baseRevisionId: hasLocalChanges ? localDraft.data.baseRevisionId ?? undefined : manuscript.data?.id,
    });
    editor.commands.setContent(documentToJson(next), { emitUpdate: false });
  }, [chapterDirty, chapterId, editor, enabled, manuscript.data, manuscript.isSuccess, localDraft.data, localDraft.isSuccess, snapshot.baseRevisionId, snapshot.chapterId]);

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
    if (!draftNeedsPersistence || savingDraft || savingLocalDraft || draftStorageError) return;
    const timer = window.setTimeout(() => {
      if (!savingFormal.current) void persistLocalDraft();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draftNeedsPersistence, draft, snapshot.baseRevisionId, savingDraft, savingLocalDraft, persistenceTick, draftStorageError]);

  async function persistLocalDraft() {
    const currentWriter = writer.current;
    if (!draftReady || !currentWriter || savingFormal.current || savingLocalDraft) return;
    setSavingLocalDraft(true);
    setDraftStorageError(null);
    try {
      const saved = await currentWriter.save({ documentJson: draft, baseRevisionId: snapshot.baseRevisionId });
      client.setQueryData(["manuscript-draft", projectId, saved.chapterId], saved);
    } catch (cause) {
      if (writer.current === currentWriter) setDraftStorageError(errorMessage(cause));
    } finally {
      if (writer.current === currentWriter) {
        setSavingLocalDraft(false);
        setPersistenceTick((value) => value + 1);
      }
    }
  }

  async function invalidateManuscript(chapter: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["manuscript", chapter] }),
      client.invalidateQueries({ queryKey: ["manuscript-history", chapter] }),
      client.invalidateQueries({ queryKey: ["recovery-logs", chapter] }),
      client.invalidateQueries({ queryKey: ["recovery-all"] }),
      client.invalidateQueries({ queryKey: ["summary-materials"] }),
      client.invalidateQueries({ queryKey: ["ai-proposals", chapter] }),
      client.invalidateQueries({ queryKey: ["project-search"] }),
    ]);
  }

  async function saveDraft(showManuscriptAfterSave = false) {
    const currentWriter = writer.current;
    if (!chapterId || !draftReady || !chapterDirty || !draft.trim() || savingFormal.current || !currentWriter) return;
    savingFormal.current = true;
    setSavingDraft(true);
    onError(null);
    try {
      const committed = await currentWriter.commit({ baseRevisionId: snapshot.baseRevisionId, documentJson: draft });
      const saved = committed.revision;
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
      client.setQueryData(["manuscript-draft", projectId, chapterId], committed.draft);
      setDraftStorageError(null);
      await invalidateManuscript(chapterId);
      setManuscriptMemoryNeedsRefresh(true);
      if (showManuscriptAfterSave && mode === "writing") setManuscriptTab("manuscript");
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      savingFormal.current = false;
      setSavingDraft(false);
      setPersistenceTick((value) => value + 1);
    }
  }

  async function discardLocalDraft() {
    const currentWriter = writer.current;
    if (!chapterId || !draftReady || !currentWriter || savingFormal.current) return;
    if (!window.confirm("放弃本章本地草稿并载入已保存正文吗？历史版本和恢复记录不会被删除。")) return;
    savingFormal.current = true;
    setSavingDraft(true);
    try {
      const cleared = await currentWriter.discard();
      const formal = await manuscript.refetch();
      if (!formal.isSuccess) throw formal.error;
      if (writer.current !== currentWriter) return;
      const next = formal.data?.documentJson ?? "";
      const unchanged = snapshotRef.current.chapterId === chapterId && snapshotRef.current.documentJson === draft;
      setSnapshot((current) => current.chapterId !== chapterId ? current : {
        ...current, documentJson: unchanged ? next : current.documentJson,
        baseDocumentJson: next, baseRevisionId: formal.data?.id,
      });
      if (unchanged) editor?.commands.setContent(documentToJson(next), { emitUpdate: false });
      client.setQueryData(["manuscript-draft", projectId, chapterId], cleared);
      setDraftStorageError(null);
    } catch (cause) { onError(errorMessage(cause)); }
    finally { savingFormal.current = false; setSavingDraft(false); setPersistenceTick((value) => value + 1); }
  }

  async function reloadLocalDraft() {
    if (!chapterId || savingFormal.current) return;
    if (draftReady && !window.confirm("保留当前内容为恢复副本，再重新读取本地草稿吗？")) return;
    const currentWriter = writer.current;
    savingFormal.current = true;
    setSavingDraft(true);
    try {
      await currentWriter?.idle();
      if (draftReady && draft.trim()) await saveRecoveryLog({ chapterId, documentJson: draft });
      const refreshed = await localDraft.refetch();
      if (!refreshed.isSuccess) return;
      if (draftReady && snapshotRef.current.documentJson !== draft) {
        onError("重新读取期间有新编辑，已保留当前内容。请完成编辑后再重读草稿。");
        return;
      }
      writer.current = null;
      setSnapshot({ chapterId: "", documentJson: "", baseDocumentJson: "", baseRevisionId: undefined });
      setDraftStorageError(null);
      await client.invalidateQueries({ queryKey: ["recovery-logs", chapterId] });
    } catch (cause) { onError(errorMessage(cause)); }
    finally { savingFormal.current = false; setSavingDraft(false); }
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
    manuscript, localDraft, history, recovery, draft, setDraft, editor, chapterDirty,
    draftReady, draftNeedsPersistence, savingLocalDraft, draftStorageError,
    persistLocalDraft, discardLocalDraft, reloadLocalDraft,
    manuscriptTab, setManuscriptTab, savingDraft, clearingRecovery, transferringCandidate,
    manuscriptMemoryNeedsRefresh, refreshingChapterMemory, compareLeftId, setCompareLeftId,
    compareRightId, setCompareRightId, mergeResult, saveDraft, refreshChapterMemory,
    recoverLatest, openWritingCandidate, openCandidateReview, discardRecoveryLogs,
    mergeDraft, restoreRevision, loadCandidate,
  };
}
