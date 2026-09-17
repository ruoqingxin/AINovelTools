import type { ManuscriptRevision, RecoveryLog } from "../lib/tauri-client";
import { diffLines, documentCharacterCount, documentToText, formatSavedAt, revisionReasonLabel } from "./project-workspace-utils";

type ManuscriptVersionsPanelProps = {
  clearingRecovery: boolean;
  compareLeftId: string | null;
  compareRightId: string | null;
  history: ManuscriptRevision[];
  onCompareLeftChange: (revisionId: string) => void;
  onCompareRightChange: (revisionId: string) => void;
  onDiscardRecovery: () => Promise<void>;
  onRecoverLatest: () => void;
  onRestoreRevision: (revision: ManuscriptRevision) => void;
  recovery: RecoveryLog[];
};

export function ManuscriptVersionsPanel(props: ManuscriptVersionsPanelProps) {
  return <div className="chapter-tab-panel manuscript-versions-panel" id="manuscript-panel-versions" role="tabpanel" aria-labelledby="manuscript-tab-versions">
    <div className="manuscript-stage-heading"><div><h2>草稿与版本</h2><p>异常草稿和历史版本都先载入候选区，由你确认内容后再同步为正文。</p></div><span>{props.history.length} 个已保存版本</span></div>
    <section className="recovery-section" data-empty={!props.recovery.length || undefined}>
      <div className="recovery-section-heading"><div><strong>异常退出草稿</strong><span>程序异常退出前连续生成的自动保护快照</span></div><small>{props.recovery.length ? `${props.recovery.length} 次自动保护` : "无需处理"}</small></div>
      {props.recovery.length ? <div className="recovery-banner"><div><strong>最近保护：{formatSavedAt(props.recovery[0]!.createdAt)} · 约 {documentCharacterCount(props.recovery[0]!.documentJson)} 字</strong><span>需要保留内容时，先载入候选区检查并同步为正文；确认当前正文正确时，可以直接清除这些保护记录。</span></div><div className="recovery-actions"><button type="button" className="primary-action" onClick={props.onRecoverLatest}>载入候选区</button><button type="button" className="secondary-action" onClick={() => void props.onDiscardRecovery()} disabled={props.clearingRecovery}>{props.clearingRecovery ? "处理中…" : "确认无需恢复"}</button></div></div> : <p className="recovery-explanation">当前没有需要处理的异常草稿。</p>}
    </section>
    <div className="revision-history">
      <div className="section-heading"><div><h2>已保存版本</h2><span className="section-subtitle">载入旧版本不会改变正文，可以先在候选区检查。</span></div><span>{props.history.length} 个</span></div>
      {props.history.map((revision, index) => <div className="revision-row" key={revision.id}><div className="revision-row-copy"><strong>版本 {props.history.length - index}{index === 0 ? <small>当前</small> : null}</strong><span>{formatSavedAt(revision.createdAt)} · 约 {documentCharacterCount(revision.documentJson)} 字 · {revisionReasonLabel(revision.creationReason)}</span></div>{index === 0 ? <span className="revision-current">正在使用</span> : <button type="button" className="secondary-action" onClick={() => props.onRestoreRevision(revision)}>载入候选区</button>}</div>)}
      {props.history.length < 2 ? <p className="revision-hint">保存两次正文后，可以在这里选择两个版本进行差异对比。</p> : (
        <div className="revision-compare">
          <div className="compare-selects">
            <select value={props.compareLeftId ?? ""} onChange={(event) => props.onCompareLeftChange(event.target.value)} aria-label="较早版本"><option value="">选择较早版本</option>{props.history.map((revision, index) => <option key={revision.id} value={revision.id}>版本 {props.history.length - index}</option>)}</select>
            <span>对比</span>
            <select value={props.compareRightId ?? ""} onChange={(event) => props.onCompareRightChange(event.target.value)} aria-label="较新版本"><option value="">选择较新版本</option>{props.history.map((revision, index) => <option key={revision.id} value={revision.id}>版本 {props.history.length - index}</option>)}</select>
          </div>
          {props.compareLeftId && props.compareRightId ? <div className="diff-view">{diffLines(documentToText(props.history.find((revision) => revision.id === props.compareLeftId)?.documentJson ?? ""), documentToText(props.history.find((revision) => revision.id === props.compareRightId)?.documentJson ?? "")).map((row, index) => <div className={`diff-line diff-${row.kind}`} key={`${index}-${row.kind}`}><span>{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span><code>{row.text || " "}</code></div>)}</div> : null}
        </div>
      )}
    </div>
  </div>;
}
