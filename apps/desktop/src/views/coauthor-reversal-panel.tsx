import { Check, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  commitCoauthorReversal, errorMessage, getCoauthorReversal, prepareCoauthorReversal,
  type CoauthorChangeSet, type CoauthorDocument, type CoauthorReversal, type CoauthorScope,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { ManuscriptReader } from "./manuscript-reader";
import { sameDraft } from "./use-coauthor-draft";

export function CoauthorReversalPanel({ scope, changes, disabled, getDocument, saveDraft, isGenerating, onReversed }: {
  scope: CoauthorScope;
  changes: CoauthorChangeSet;
  disabled: boolean;
  getDocument: () => CoauthorDocument;
  saveDraft: () => Promise<CoauthorDocument>;
  isGenerating: () => boolean;
  onReversed: (base: CoauthorDocument, linked: boolean) => Promise<void>;
}) {
  const confirm = useConfirmAction();
  const [preview, setPreview] = useState<CoauthorReversal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const request = ++epoch.current;
    let active = true;
    setPreview(null);
    void getCoauthorReversal({ scope, id: changes.id }).then((value) => {
      if (active && epoch.current === request) setPreview(value);
    }).catch((cause) => { if (active && epoch.current === request) setError(errorMessage(cause)); });
    return () => { active = false; mounted.current = false; epoch.current++; };
  }, [scope.projectId, scope.sessionId, changes.id]);

  async function act(action: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }

  async function prepare() {
    await act(async () => {
      const request = ++epoch.current;
      if (isGenerating()) throw new Error("请先停止生成或等待完成，再核对撤销。");
      const saved = await saveDraft();
      if (!mounted.current || epoch.current !== request) return;
      if (!sameDraft(getDocument(), saved) || getDocument().version !== saved.version) {
        throw new Error("工作稿仍在变化，请保存后重新核对撤销。");
      }
      const value = await prepareCoauthorReversal({ scope, id: changes.id, expectedVersion: changes.version,
        expectedDocumentVersion: saved.version });
      if (mounted.current && epoch.current === request) setPreview(value);
    });
  }

  async function commit() {
    if (!preview || preview.status !== "PENDING" || preview.blockers.length) return;
    const reviewed = preview;
    await act(async () => {
      const request = ++epoch.current;
      const snapshot = getDocument();
      if (isGenerating()) throw new Error("请先停止生成或等待完成，再核对撤销。");
      if (snapshot.version !== reviewed.baseDocument.version || !sameDraft(snapshot, reviewed.baseDocument)) {
        throw new Error("工作稿已变化，请重新检查撤销。");
      }
      const allowed = await confirm({
        title: "撤销已采用的关联变更",
        message: `撤销本次实际采用的全部 ${reviewed.items.length} 项：${reviewed.items.map((item) => item.title).join("、")}。`
          + `已有内容追加恢复修订，新建条目归档保留。原有 ${reviewed.impactCount} 项影响待办及处理记录不删除，需要重新复查。`,
        confirmLabel: "确认整组撤销",
      });
      if (!allowed || !mounted.current || epoch.current !== request) return;
      if (isGenerating() || getDocument().version !== snapshot.version || !sameDraft(getDocument(), snapshot)) {
        throw new Error("确认期间工作稿或任务已变化，旧撤销确认已失效。");
      }
      let receipt: CoauthorReversal;
      try {
        receipt = await commitCoauthorReversal({ scope, id: changes.id, expectedVersion: reviewed.version });
      } catch (cause) {
        const actual = await getCoauthorReversal({ scope, id: changes.id }).catch(() => null);
        if (actual?.id !== reviewed.id || actual.status !== "COMMITTED" || actual.version !== reviewed.version + 1) {
          throw new Error(`${errorMessage(cause)}。撤销状态需重新核对，请刷新回执；不要据此认定已经撤销。`);
        }
        receipt = actual;
      }
      if (!mounted.current || epoch.current !== request) return;
      setPreview(receipt);
      await onReversed(snapshot, receipt.linkedDraft);
    });
  }

  return <section className="coauthor-reversal" aria-label="关联撤销">
    <h3>撤销采用</h3>
    {error && <p className="project-error" role="alert">{error}</p>}
    {preview?.status === "COMMITTED" || changes.reversedBy
      ? <p role="status" className="coauthor-notice">本次采用已整组撤销，原采用回执与历史内容保留。</p>
      : <button disabled={busy || disabled} onClick={() => void prepare()}>
        {preview ? <RefreshCw size={15} /> : <Undo2 size={15} />}{preview ? "重新检查撤销" : "核对整组撤销"}
      </button>}
    {preview && <>
      <p className="coauthor-notice">仅检查版本和可追踪引用，不代表已完成全书语义核对。原有影响待办及作者处理记录保留。</p>
      {preview.blockers.map((message, index) => <p key={index} className="project-error" role="alert">{message}</p>)}
      {preview.items.map((item) => <article key={item.itemId} className="coauthor-change-item">
        <strong>{item.title}</strong>
        <p className="coauthor-notice">{item.action === "ARCHIVE" ? "撤销后归档，内容与修订保留" : "恢复采用前内容，追加新修订"}</p>
        <small>{item.sourceKey} · 核对修订 {item.before.revision}</small>
        <div className="coauthor-diff">
          <section><h4>撤销前</h4>{item.beforeDocumentJson
            ? <ManuscriptReader documentJson={item.beforeDocumentJson} ariaLabel="撤销前正文" /> : <pre>{item.before.content}</pre>}</section>
          <section><h4>撤销后</h4>{item.action === "ARCHIVE" ? <p>归档，原文不删除。</p>
            : item.afterDocumentJson ? <ManuscriptReader documentJson={item.afterDocumentJson} ariaLabel="撤销后正文" />
              : <pre>{item.after?.content}</pre>}</section>
        </div>
        {preview.status === "COMMITTED" && <small className="coauthor-receipt">
          {item.action === "ARCHIVE" ? "已归档" : `已恢复 · ${item.resultRevision}`}
        </small>}
      </article>)}
      {preview.status === "PENDING" && <button disabled={busy || disabled || Boolean(preview.blockers.length)}
        onClick={() => void commit()}><Check size={15} />确认撤销本次全部采用</button>}
    </>}
  </section>;
}
