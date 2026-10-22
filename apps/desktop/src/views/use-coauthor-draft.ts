import { useEffect, useRef, useState } from "react";
import { errorMessage, saveCoauthorDocument, type CoauthorDocument, type CoauthorScope } from "../lib/tauri-client";

export function sameDraft(a: CoauthorDocument, b: CoauthorDocument) {
  return a.sessionId === b.sessionId && a.kind === b.kind && a.title === b.title
    && a.content === b.content && a.targetKey === b.targetKey && a.targetRevision === b.targetRevision
    && a.narrativePosition === b.narrativePosition;
}

function readBackup(key: string, document: CoauthorDocument): CoauthorDocument | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as CoauthorDocument | null;
    return value && value.sessionId === document.sessionId && typeof value.content === "string"
      && typeof value.title === "string" && typeof value.version === "number"
      && ["SETTING", "OUTLINE", "MANUSCRIPT"].includes(value.kind)
      && typeof value.narrativePosition === "string"
      && (value.targetKey === null || typeof value.targetKey === "string")
      && (value.targetRevision === null || typeof value.targetRevision === "string")
      && !sameDraft(value, document) ? value : null;
  } catch { return null; }
}

export function useCoauthorDraft(scope: CoauthorScope, initial: CoauthorDocument) {
  const key = `coauthor-draft:${scope.projectId}:${scope.sessionId}`;
  const [backup, setBackup] = useState(() => readBackup(key, initial));
  const [document, setDocument] = useState(initial);
  const current = useRef(document);
  const saved = useRef(initial);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<CoauthorDocument> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function change(patch: Partial<CoauthorDocument>) {
    const next = { ...current.current, ...patch, sessionId: scope.sessionId, version: saved.current.version };
    current.current = next;
    setDocument(next);
    try { localStorage.setItem(key, JSON.stringify(next)); }
    catch { setError("本地备份失败，请先保存工作稿再离开。"); }
  }

  async function save(): Promise<CoauthorDocument> {
    if (inFlight.current) await inFlight.current;
    if (conflict) throw new Error("服务器版本已变化，请比较后恢复或另建分支。");
    const snapshot = { ...current.current, version: saved.current.version };
    if (sameDraft(snapshot, saved.current)) return saved.current;
    setSaving(true);
    const promise = saveCoauthorDocument({ scope, document: snapshot });
    inFlight.current = promise;
    try {
      const result = await promise;
      saved.current = result;
      if (mounted.current) {
        current.current = { ...current.current, version: result.version };
        setDocument(current.current);
        setError(null);
        if (sameDraft(current.current, result)) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(current.current));
      }
      return result;
    } catch (cause) {
      if (mounted.current) {
        setError(errorMessage(cause));
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "VERSION_CONFLICT") setConflict(true);
      }
      throw cause;
    } finally {
      if (inFlight.current === promise) inFlight.current = null;
      if (mounted.current) setSaving(false);
    }
  }

  // Acknowledgements only advance the base version; they never replace newer typing.
  function acceptSaved(result: CoauthorDocument, expected: CoauthorDocument) {
    saved.current = result;
    if (sameDraft(current.current, expected)) current.current = result;
    else current.current = { ...current.current, version: result.version };
    setDocument(current.current);
    setConflict(false);
    setError(null);
    try {
      if (sameDraft(current.current, result)) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(current.current));
    } catch { setError("本地备份失败，请先保存工作稿再离开。"); }
  }

  const dirty = !sameDraft(document, saved.current);
  useEffect(() => {
    if (!dirty || conflict || backup) return;
    const timer = window.setTimeout(() => { void save().catch(() => {}); }, 700);
    return () => window.clearTimeout(timer);
    // Only content changes schedule a save, never an unrelated render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, conflict, backup]);
  return { document, current, saved, change, save, acceptSaved, dirty, saving, error, conflict, backup,
    dismissBackup: () => setBackup(null) };
}
