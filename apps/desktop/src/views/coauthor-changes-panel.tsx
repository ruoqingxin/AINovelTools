import { Check, ClipboardList, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  commitCoauthorChangeset, discardCoauthorChangeset, errorMessage, getCoauthorChanges, getCoauthorChangeset,
  prepareCoauthorChangeset, readCoauthorSource, updateCoauthorImpact,
  type CoauthorChangeSet, type CoauthorChangesPage, type CoauthorDocument, type CoauthorImpact, type CoauthorScope, type CoauthorSource, type CoauthorDecisionDependencyInput,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { sameDraft } from "./use-coauthor-draft";
import { ManuscriptReader } from "./manuscript-reader";
import { CoauthorReversalPanel } from "./coauthor-reversal-panel";
import { DecisionDependencyPicker, DecisionDependenciesReview, hasStaleDecisionDependencies } from "./coauthor-decision-dependencies";

const labels: Record<string, string> = {
  PENDING: "待核对", COMMITTED: "已提交", DISCARDED: "已放弃", RESOLVED: "已处理",
  NOT_APPLICABLE: "不适用", ACCEPTED_DIFFERENCE: "保留差异",
};
const kinds = { SETTING: "设定", OUTLINE: "大纲", MANUSCRIPT: "正文" } as const;
const empty: CoauthorChangesPage = { changeSets: [], impacts: [], hasMoreChanges: false, hasMoreImpacts: false };
type ImpactEdit = Pick<CoauthorImpact, "id" | "version" | "status" | "resolution">;
function recoverForm(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value.settingTitle !== "string" || typeof value.settingContent !== "string"
      || typeof value.newSetting !== "boolean" || typeof value.dependent !== "boolean") return null;
    const editing = value.editing;
    return {
      settingTitle: value.settingTitle as string, settingContent: value.settingContent as string,
      newSetting: value.newSetting as boolean, dependent: value.dependent as boolean,
      rules: (Array.isArray(value.rules) ? value.rules.filter((entry: CoauthorDecisionDependencyInput) =>
        entry && typeof entry.decisionId === "string" && Number.isSafeInteger(entry.version) && entry.version > 0
        && Array.isArray(entry.itemIds) && entry.itemIds.length > 0 && entry.itemIds.every((id) => ["draft", "setting"].includes(id))) : []) as CoauthorDecisionDependencyInput[],
      editing: editing && typeof editing.id === "string" && typeof editing.version === "number"
        && typeof editing.status === "string" && typeof editing.resolution === "string" ? editing as ImpactEdit : null,
    };
  } catch { return null; }
}

export function CoauthorChangesPanel({ scope, initialChangeSetId = null, getDocument, saveDraft, isGenerating, onCommitted }: {
  scope: CoauthorScope;
  initialChangeSetId?: string | null;
  getDocument: () => CoauthorDocument;
  saveDraft: () => Promise<CoauthorDocument>;
  isGenerating: () => boolean;
  onCommitted: (base: CoauthorDocument, linkedDraft: boolean) => Promise<void>;
}) {
  const confirm = useConfirmAction();
  const [page, setPage] = useState<CoauthorChangesPage>(empty);
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<CoauthorSource | null>(null);
  const [changes, setChanges] = useState<CoauthorChangeSet | null>(null);
  const [rulesVerified, setRulesVerified] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const detailEpoch = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const backupKey = `coauthor-change-form:${scope.projectId}:${scope.sessionId}`;
  const [recovered] = useState(() => recoverForm(backupKey));
  const [newSetting, setNewSetting] = useState(recovered?.newSetting ?? false);
  const [settingTitle, setSettingTitle] = useState(recovered?.settingTitle ?? "");
  const [settingContent, setSettingContent] = useState(recovered?.settingContent ?? "");
  const [dependent, setDependent] = useState(recovered?.dependent ?? true);
  const [rules, setRules] = useState<CoauthorDecisionDependencyInput[]>(recovered?.rules ?? []);
  const [editing, setEditing] = useState<ImpactEdit | null>(recovered?.editing ?? null);
  useUnsavedChangesGuard(Boolean(settingTitle || settingContent || editing?.resolution || rules.length),
    "关联变更有尚未保存的设定或待办处理依据。");
  useEffect(() => {
    try {
      if (!settingTitle && !settingContent && !editing && !rules.length) localStorage.removeItem(backupKey);
      else localStorage.setItem(backupKey, JSON.stringify({ newSetting, settingTitle, settingContent, dependent, editing, rules }));
    } catch { setError("变更输入的本地备份失败，请暂时不要关闭面板。"); }
  }, [backupKey, newSetting, settingTitle, settingContent, dependent, editing, rules]);

  async function reload() {
    const current = ++epoch.current;
    const result = await getCoauthorChanges({ scope, changesOffset: 0, impactsOffset: 0 });
    if (mounted.current && epoch.current === current) { setPage(result); setLoaded(true); }
  }
  useEffect(() => {
    mounted.current = true;
    void reload().catch((cause) => { if (mounted.current) setError(errorMessage(cause)); });
    return () => { mounted.current = false; epoch.current++; };
  }, [scope.projectId, scope.sessionId]);
  useEffect(() => {
    let current = true;
    const request = ++detailEpoch.current;
    if (initialChangeSetId) { setChanges(null); setSelected([]); setRulesVerified(false); }
    if (initialChangeSetId) void getCoauthorChangeset({ scope, id: initialChangeSetId }).then((value) => {
      if (value.id !== initialChangeSetId) throw new Error("返回方案身份与请求不符，未接入其他方案。");
      if (current && request === detailEpoch.current) show(value);
    }).catch((cause) => {
      if (current && mounted.current && request === detailEpoch.current) setError(`指定方案无法核实：${errorMessage(cause)}`);
    });
    return () => { current = false; };
  }, [scope.projectId, scope.sessionId, initialChangeSetId]);

  async function act(action: () => Promise<void>) {
    if (busyRef.current) return;
    detailEpoch.current++;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function show(value: CoauthorChangeSet) {
    if (!mounted.current) return;
    setChanges(value);
    setRulesVerified(true);
    setSelected(value.status === "COMMITTED" ? value.selectedIds : value.items.map((item) => item.id));
  }
  async function create() {
    await act(async () => {
      if (isGenerating()) throw new Error("请先停止生成或等待完成，再准备正式采用。");
      const saved = await saveDraft();
      if (!mounted.current) return;
      if (!sameDraft(getDocument(), saved)) throw new Error("稿件仍在变化，请保存后重新核对。");
      const created = await prepareCoauthorChangeset({ scope, request: {
        expectedDocumentVersion: saved.version,
        title: newSetting ? `${saved.title}与${settingTitle}`.slice(0, 200) : saved.title,
        draftDependsOn: newSetting && dependent ? ["setting"] : [],
        items: newSetting ? [{
          id: "setting", kind: "SETTING", title: settingTitle, content: settingContent,
          targetKey: null, targetRevision: null, dependsOn: [],
        }] : [],
        impacts: [], coverage: "作者手动准备当前稿件；未检索其他章节、设定或伏笔的影响。",
        decisionDependencies: rules.map((entry) => ({ ...entry, itemIds: entry.itemIds.filter((id) => id === "draft" || newSetting) }))
          .filter((entry) => entry.itemIds.length > 0),
      } });
      show(created);
      if (mounted.current) { setSettingTitle(""); setSettingContent(""); setNewSetting(false); setRules([]); }
      await reload();
    });
  }
  const missingDependencies = changes?.items.filter((item) => selected.includes(item.id)
    && item.dependsOn.some((id) => !selected.includes(id))) ?? [];
  const applicableImpacts = changes?.impacts.filter((impact) => impact.itemIds.some((id) => selected.includes(id))) ?? [];

  async function commit() {
    if (!changes || changes.status !== "PENDING" || missingDependencies.length || !selected.length
      || !rulesVerified || hasStaleDecisionDependencies(changes, selected)) return;
    const reviewed = changes;
    const reviewedIds = [...selected];
    await act(async () => {
      const snapshot = getDocument();
      setRulesVerified(false);
      const fresh = await getCoauthorChangeset({ scope, id: reviewed.id });
      if (!mounted.current) return;
      setChanges(fresh); setRulesVerified(true);
      if (fresh.version !== reviewed.version || fresh.status !== "PENDING" || hasStaleDecisionDependencies(fresh, reviewedIds)) {
        throw new Error("决定依赖或方案状态已变化，请查看当前状态并重新准备；尚未正式采用。");
      }
      if (isGenerating()) throw new Error("请先停止生成或等待完成，再核对采用。");
      if (snapshot.version !== reviewed.baseDocument.version || !sameDraft(snapshot, reviewed.baseDocument)) {
        throw new Error("工作稿已变化，此变更集不再基于当前版本；请重新准备。");
      }
      const allowed = await confirm({
        title: "正式采用关联变更",
        message: `提交以下 ${reviewedIds.length} 项：${reviewed.items.filter((item) => reviewedIds.includes(item.id))
          .map((item) => item.document.title).join("、")}。整组成功或整体回滚。`
          + `核对 ${(fresh.decisionDependencies ?? []).filter((entry) => entry.itemIds.some((id) => reviewedIds.includes(id))).length} 条明确声明的决定依赖；未声明的隐含关系未核验。`
          + `保留 ${applicableImpacts.length} 项有依据的影响待办，其他内容未同步。未勾选的变更不会采用。`,
        confirmLabel: "采用所选变更",
      });
      if (!allowed || !mounted.current) return;
      if (isGenerating() || getDocument().version !== snapshot.version || !sameDraft(getDocument(), snapshot)) {
        throw new Error("确认期间稿件或任务已变化，旧确认已失效。");
      }
      let result: CoauthorChangeSet;
      try {
        result = await commitCoauthorChangeset({
          scope, id: reviewed.id, expectedVersion: reviewed.version, selectedIds: reviewedIds,
        });
      } catch (cause) {
        // A lost response is not proof of a failed commit. Check the durable
        // receipt before offering the exact same idempotent request again.
        const actual = await getCoauthorChangeset({ scope, id: reviewed.id }).catch(() => null);
        if (actual?.status !== "COMMITTED" || actual.reversedBy || actual.version !== reviewed.version + 1
          || [...actual.selectedIds].sort().join("\0") !== [...reviewedIds].sort().join("\0")) {
          if (mounted.current) {
            if (actual) setChanges(actual);
            setRulesVerified(actual !== null);
          }
          throw new Error(`${errorMessage(cause)}。提交状态需重新核对，请刷新此变更集；重试不会重复创建条目。`);
        }
        result = actual;
      }
      show(result);
      await onCommitted(snapshot, reviewedIds.includes("draft"));
      await reload();
      if (mounted.current) setNotice(`已正式采用 ${result.published.length} 项；其他内容未同步。`);
    });
  }

  return <div className="coauthor-changes">
    <div className="coauthor-change-actions">
      <h3><ClipboardList size={16} />关联变更</h3>
      <button className="icon-command" title="刷新变更与待办" aria-label="刷新变更与待办" disabled={busy}
        onClick={() => void act(async () => { setRulesVerified(false); await reload(); if (changes) show(await getCoauthorChangeset({ scope, id: changes.id })); })}>
        <RefreshCw size={16} />
      </button>
    </div>
    {error && <p className="project-error" role="alert">{error}</p>}
    {notice && <p className="coauthor-notice" role="status">{notice}</p>}
    {!loaded && !error && <p role="status">正在读取变更与待办…</p>}
    {page.changeSets.map((entry) => <article className="coauthor-source" key={entry.id}>
      <strong>{entry.title}</strong><small>{entry.reversedBy ? "已撤销" : labels[entry.status]} · {entry.itemCount} 项 · v{entry.version}</small>
      <button disabled={busy} onClick={() => void act(async () => show(await getCoauthorChangeset({ scope, id: entry.id })))}>
        {entry.status === "COMMITTED" ? "查看采用回执" : entry.status === "DISCARDED" ? "查看已放弃方案" : "核对差异"}
      </button>
    </article>)}
    {page.hasMoreChanges && <button disabled={busy} onClick={() => void act(async () => {
      const next = await getCoauthorChanges({ scope, changesOffset: page.changeSets.length, impactsOffset: 0 });
      if (mounted.current) setPage((current) => ({ ...current,
        changeSets: [...current.changeSets, ...next.changeSets], hasMoreChanges: next.hasMoreChanges }));
    })}>更早变更</button>}
    {changes && <section className="coauthor-change-review" aria-label="关联变更差异">
      <h3>{changes.title}</h3>
      <p className="coauthor-notice">{changes.coverage}</p>
      <p className="coauthor-notice">以上为准备者报告的检查范围，尚无全书完备性核验；影响清单只列出当前已知项。</p>
      {changes.runId && changes.status === "PENDING" && <p className="coauthor-notice">AI 准备的待核对方案，尚未正式采用。</p>}
      <DecisionDependenciesReview changes={changes} selected={selected} />
      {!rulesVerified && <p className="coauthor-notice">决定依赖尚未重新核实，请刷新方案后再采用。</p>}
      {changes.items.map((item) => <article className="coauthor-change-item" key={item.id}>
        <label className="coauthor-change-check">
          <input type="checkbox" checked={selected.includes(item.id)} disabled={busy || changes.status !== "PENDING"}
            onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />
          <strong>{item.document.title}</strong><span>{kinds[item.document.kind]}</span>
        </label>
        <p className="coauthor-notice">{item.document.targetKey
          ? `${item.manuscriptEdits?.length || item.outlineEdits?.length ? "局部修改" : "替换"}：${item.document.targetKey}` : "新建正式条目"}</p>
        {Boolean(item.manuscriptEdits?.length || item.outlineEdits?.length) && <small>原文修订：{item.document.targetRevision}</small>}
        {item.dependsOn.length > 0 && <p className="coauthor-notice">依赖：{item.dependsOn.map((id) =>
          changes.items.find((entry) => entry.id === id)?.document.title ?? id).join("、")}</p>}
        {item.before && item.document.kind === "SETTING" && <p className="coauthor-notice">完整替换会重置结构属性为全书设定，旧修订作者规则不继承；别名、标签和旧修订保留。</p>}
        {Boolean(item.manuscriptEdits?.length) && <section aria-label="正文局部修改范围">
          {item.manuscriptEdits?.map((edit, index) => <div key={index}>
            <small>块 {edit.blockId} · 字符 {edit.start} 至 {edit.end}（不含末位）</small>
            <div className="coauthor-diff"><pre>{edit.before}</pre><pre>{edit.after || "（删除）"}</pre></div>
            {Boolean(edit.afterRuns?.length) && <details className="coauthor-format-mapping">
              <summary>替换文字格式来源</summary>
              <dl>{edit.afterRuns?.map((run, runIndex) => <div key={runIndex}>
                <dt>原文字符 {run.marksFrom}</dt><dd>{run.text}</dd>
              </div>)}</dl>
            </details>}
          </div>)}
        </section>}
        {Boolean(item.outlineEdits?.length) && <section aria-label="大纲局部修改范围">
          {item.outlineEdits.map((edit, index) => <div key={index}>
            <small>正式内容 · 字符 {edit.start} 至 {edit.end}（不含末位）</small>
            <div className="coauthor-diff"><pre>{edit.before}</pre><pre>{edit.after || "（删除）"}</pre></div>
          </div>)}
          <p className="coauthor-notice">仅修改正式内容；标题、层级、候选稿、备注、原有影响说明与引用不变。</p>
          {item.outlineBefore && <details><summary>保留的大纲记录 · v{item.outlineBefore.version}</summary>
            <dl className="coauthor-outline-record"><dt>候选稿</dt><dd><pre>{item.outlineBefore.pendingContent || "无"}</pre></dd>
              <dt>备注</dt><dd><pre>{item.outlineBefore.rationale || "无"}</pre></dd>
              <dt>后续影响</dt><dd><pre>{item.outlineBefore.consequence || "无"}</pre></dd>
              <dt>引用</dt><dd><pre>{item.outlineBefore.references.join("\n") || "无"}</pre></dd></dl>
          </details>}
        </section>}
        <div className="coauthor-diff">
          <section><h4>正式原文{item.before ? ` · ${item.before.title}` : ""}</h4>
            {item.manuscriptBeforeJson ? <ManuscriptReader documentJson={item.manuscriptBeforeJson} ariaLabel="局部修改前正文" />
              : <pre aria-label={item.outlineBefore ? "局部修改前大纲" : undefined}>
                {item.outlineBefore?.content ?? item.before?.content ?? "无，新建条目"}</pre>}</section>
          <section><h4>采用后 · {item.document.title}</h4>
            {item.manuscriptAfterJson ? <ManuscriptReader documentJson={item.manuscriptAfterJson} ariaLabel="局部修改后正文" />
              : <pre aria-label={item.outlineBefore ? "局部修改后大纲" : undefined}>{item.document.content}</pre>}</section>
        </div>
        {changes.published.find((entry) => entry.itemId === item.id) && <small className="coauthor-receipt">
          已采用：{changes.published.find((entry) => entry.itemId === item.id)?.sourceKey}
        </small>}
        {changes.status === "COMMITTED" && !changes.selectedIds.includes(item.id) && <small>本项未采用</small>}
      </article>)}
      {missingDependencies.length > 0 && <p role="alert" className="project-error">
        {missingDependencies.map((item) => item.document.title).join("、")}依赖未勾选的变更，不能单独采用。
      </p>}
      {applicableImpacts.map((impact, index) => <blockquote key={index}>
        <p>{impact.quote}</p><p>{impact.reason}</p><small>{impact.key} · 待复查，不自动认定矛盾</small>
      </blockquote>)}
      {changes.status === "DISCARDED" && <p className="coauthor-notice">此方案已放弃，原方案保留，正式内容未变更。</p>}
      {changes.status === "PENDING" && <><button className="primary-action"
        disabled={busy || !selected.length || Boolean(missingDependencies.length) || !rulesVerified || hasStaleDecisionDependencies(changes, selected)}
        onClick={() => void commit()}><Check size={15} />确认采用所选变更</button>
        <button disabled={busy} onClick={() => void act(async () => {
          if (!await confirm({ title: "放弃关联变更", message: "放弃此方案，不修改工作稿或正式内容，原方案仍保留。",
            confirmLabel: "放弃此方案" }) || !mounted.current) return;
          show(await discardCoauthorChangeset({ scope, id: changes.id, expectedVersion: changes.version }));
          await reload();
        })}>放弃此方案</button></>}
      {changes.status === "COMMITTED" && <CoauthorReversalPanel key={changes.id}
        scope={scope} changes={changes} disabled={busy} getDocument={getDocument}
        saveDraft={saveDraft} isGenerating={isGenerating} onReversed={async (base, linked) => {
          await onCommitted(base, linked);
          show(await getCoauthorChangeset({ scope, id: changes.id }));
          await reload();
        }} />}
    </section>}
    <details className="coauthor-change-create">
      <summary>准备新的变更集</summary>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label className="coauthor-change-check"><input type="checkbox" checked={newSetting} disabled={busy}
          onChange={(event) => { setNewSetting(event.target.checked); if (!event.target.checked) setRules((values) =>
            values.map((entry) => ({ ...entry, itemIds: entry.itemIds.filter((id) => id !== "setting") })).filter((entry) => entry.itemIds.length > 0)); }} />同时新建设定</label>
        {newSetting && <>
          <label>设定标题<input aria-label="关联设定标题" required maxLength={200} value={settingTitle}
            disabled={busy} onChange={(event) => setSettingTitle(event.target.value)} /></label>
          <label>设定内容<textarea aria-label="关联设定内容" required value={settingContent}
            disabled={busy} onChange={(event) => setSettingContent(event.target.value)} /></label>
          <label className="coauthor-change-check"><input type="checkbox" checked={dependent} disabled={busy}
            onChange={(event) => setDependent(event.target.checked)} />当前稿件依赖此设定</label>
        </>}
        <DecisionDependencyPicker key={`${scope.projectId}:${scope.sessionId}`} scope={scope} value={rules} hasSetting={newSetting} disabled={busy} onChange={setRules} />
        <button disabled={busy} type="submit"><Plus size={15} />从当前工作稿准备</button>
      </form>
    </details>
    <section className="coauthor-impact-list" aria-label="影响待办">
      <h3>影响待办</h3>
      {loaded && !page.impacts.length && <p className="coauthor-notice">暂无已记录待办，不代表已检查全书。</p>}
      {page.impacts.map((impact) => <article key={impact.id} className="coauthor-source">
        <strong>{impact.title}</strong><small>{labels[impact.status]} · v{impact.version}</small>
        <p>{impact.evidence.reason}</p>
        <blockquote>{impact.evidence.quote}</blockquote>
        <small>{impact.evidence.key} · 原文修订 {impact.evidence.revision}</small>
        {impact.sourceChanged && <p className="project-error">依据已变更或不可用，请核对当前原文；旧引文仍保留。</p>}
        {impact.originReversed && <p className="project-error">引发此待办的采用已撤销，请复查处理依据；原处理记录保留。</p>}
        {impact.resolution && <p>处理依据：{impact.resolution}</p>}
        <button disabled={busy} onClick={() => setEditing({ ...impact })}>处理待办</button>
        <button disabled={busy} onClick={() => void act(async () => {
          const original = await readCoauthorSource({ scope, key: impact.evidence.key, revision: impact.evidence.revision, offset: 0 });
          if (mounted.current) setSource(original);
        })}>查看引用原文</button>
      </article>)}
      {page.hasMoreImpacts && <button disabled={busy} onClick={() => void act(async () => {
        const next = await getCoauthorChanges({ scope, changesOffset: 0, impactsOffset: page.impacts.length });
        if (mounted.current) setPage((current) => ({ ...current,
          impacts: [...current.impacts, ...next.impacts], hasMoreImpacts: next.hasMoreImpacts }));
      })}>更多待办</button>}
      {editing && <form aria-label="处理影响待办" onSubmit={(event) => {
        event.preventDefault(); void act(async () => {
          await updateCoauthorImpact({ scope, id: editing.id, expectedVersion: editing.version,
            status: editing.status, resolution: editing.resolution });
          await reload(); if (mounted.current) setEditing(null);
        });
      }}>
        <label>状态<select aria-label="待办状态" value={editing.status} disabled={busy}
          onChange={(event) => setEditing({ ...editing, status: event.target.value })}>
          {["PENDING", "RESOLVED", "NOT_APPLICABLE", "ACCEPTED_DIFFERENCE"].map((status) =>
            <option key={status} value={status}>{labels[status]}</option>)}
        </select></label>
        <label>处理依据<textarea aria-label="待办处理依据" required maxLength={2000} value={editing.resolution}
          disabled={busy} onChange={(event) => setEditing({ ...editing, resolution: event.target.value })} /></label>
        <button type="submit" disabled={busy || !editing.resolution.trim()}><Check size={15} />保存处理</button>
        <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
      </form>}
      {source && <section className="coauthor-source-text" aria-label="影响引用原文">
        <h3>{source.title}</h3><small>修订 {source.revision}</small><pre>{source.content}</pre>
        {source.offset + [...source.content].length < source.totalChars && <button disabled={busy} onClick={() => void act(async () => {
          const next = await readCoauthorSource({ scope, key: source.key, revision: source.revision,
            offset: source.offset + [...source.content].length });
          if (mounted.current) setSource(next);
        })}>下一段原文</button>}
        <button onClick={() => setSource(null)}>收起原文</button>
      </section>}
    </section>
  </div>;
}
