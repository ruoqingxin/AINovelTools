import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, FileText, GitBranch, History, MessageSquareText, Plus, Save, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listen } from "../lib/ipc-transport";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  applyCoauthorProposal, cancelCoauthorRun, correctCoauthorDecision, createDiscussionSession, errorMessage,
  forkCoauthorSession, getCoauthorState, getCurrentProject, getProjectAiTaskOverrides,
  listCoauthorDocumentHistory, listDiscussionMessages, listDiscussionSessions, listModelProfiles,
  publishCoauthorDocument, readCoauthorSource, runCoauthor, saveCoauthorDocument,
  type CoauthorDecision, type CoauthorDocument, type CoauthorRun, type CoauthorScope, type CoauthorSource,
  type CoauthorState, type DiscussionMessage, type DiscussionSession,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { useProjectTransition } from "../shell/project-actions-provider";
import { sameDraft, useCoauthorDraft } from "./use-coauthor-draft";
import { WorkspacePanel } from "./workspace-panel";
import "./coauthor-workspace.css";

const kinds = { SETTING: "设定", OUTLINE: "大纲", MANUSCRIPT: "正文" } as const;
const statuses: Record<string, string> = {
  RUNNING: "进行中", COMPLETED: "已完成", FAILED: "失败，保留结果", CANCELLED: "已停止",
  SUPERSEDED: "已被新指令替代", INTERRUPTED: "中断，可继续讨论", LIMIT_REACHED: "达到本轮预算",
  CHOSEN: "已选择", REJECTED: "已否定", OPEN: "待定", WITHDRAWN: "已撤回",
};
type Proposal = { document: CoauthorDocument; baseDocument: CoauthorDocument };
function proposalFor(run?: CoauthorRun): Proposal | null {
  const item = [...(run?.audit ?? [])].reverse().find((value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && "kind" in value && value.kind === "draft_proposal");
  return item ? item as unknown as Proposal : null;
}
function sourcesFor(run?: CoauthorRun): Array<CoauthorSource & { read: boolean; sent: boolean }> {
  const found = new Map<string, CoauthorSource & { read: boolean; sent: boolean }>();
  for (const raw of run?.audit ?? []) {
    const item = raw as { kind?: string; name?: string; result?: { hits?: CoauthorSource[] } & Partial<CoauthorSource> };
    if (item.kind === "model_request") for (const entry of found.values()) entry.sent = true;
    for (const hit of item.result?.hits ?? []) {
      const key = `${hit.key}:${hit.revision}`;
      if (!found.has(key)) found.set(key, { ...hit, read: false, sent: false });
    }
    if (item.kind === "tool" && item.name === "read_source" && item.result?.key) {
      const source = item.result as CoauthorSource;
      const key = `${source.key}:${source.revision}`;
      found.set(key, { ...source, read: true, sent: false });
    }
  }
  return [...found.values()];
}

export function CoauthorView() {
  const client = useQueryClient();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const sessions = useQuery({ queryKey: ["discussion-sessions"], queryFn: listDiscussionSessions, enabled: Boolean(project.data) });
  const target = new URLSearchParams(window.location.search);
  const [selected, setSelected] = useState<string | null>(() => target.get("targetSession") ?? (window.location.hash.slice(1) || null));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const projectId = project.data?.projectId;
  const available = sessions.data?.filter((entry) => entry.projectId === projectId) ?? [];
  const session = available.find((entry) => entry.id === selected) ?? (!selected ? available[0] : undefined);
  const wrongTarget = Boolean(target.get("targetProject") && target.get("targetProject") !== projectId);
  function select(id: string) {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.delete("targetSession");
    url.searchParams.delete("targetProject");
    url.hash = id;
    window.history.replaceState(null, "", url);
  }
  async function create() {
    if (creating || !projectId) return;
    setCreating(true);
    try {
      const created = await createDiscussionSession({
        title: `共创讨论 ${available.length + 1}`, scopeKind: "PROJECT", scopeId: null, scopeText: null, topicKind: "FREE",
      });
      if (created.projectId !== projectId) throw new Error("项目已切换，未打开新的讨论。");
      client.setQueryData<DiscussionSession[]>(["discussion-sessions"], (entries) => [created, ...(entries ?? [])]);
      select(created.id);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setCreating(false); }
  }
  return <section className="coauthor-workspace">
    <header className="coauthor-heading">
      <h1>共创讨论</h1>
      <select aria-label="当前讨论" value={session?.id ?? ""} onChange={(event) => select(event.target.value)}>
        {!session && <option value="">选择讨论</option>}
        {available.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
      </select>
      <button className="icon-command" type="button" title="新建讨论" aria-label="新建讨论" disabled={creating || !projectId} onClick={() => void create()}><Plus size={18} /></button>
    </header>
    {(error || sessions.error || project.error) && <p className="project-error" role="alert">{error ?? errorMessage(sessions.error ?? project.error)}</p>}
    {wrongTarget ? <p role="alert">讨论链接不属于当前项目，未读取或修改该讨论。</p>
      : session && projectId ? <CoauthorLoader key={`${projectId}:${session.id}`} scope={{ projectId, sessionId: session.id }}
        onFork={(created) => {
          client.setQueryData<DiscussionSession[]>(["discussion-sessions"], (entries) => [created, ...(entries ?? [])]);
          select(created.id);
        }} />
        : sessions.isPending ? <p role="status">正在读取讨论…</p>
          : selected ? <p role="alert">指定讨论不存在，请选择其他讨论。</p>
            : <div className="coauthor-empty"><MessageSquareText size={32} /><h2>从一个想法开始</h2>
              <button className="primary-action" disabled={creating} onClick={() => void create()}><Plus size={16} />新建讨论</button></div>}
  </section>;
}

function CoauthorLoader({ scope, onFork }: { scope: CoauthorScope; onFork: (session: DiscussionSession) => void }) {
  const [state, setState] = useState<CoauthorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A remounted editor needs a fresh baseline, never a cached pre-save document.
  useEffect(() => {
    let current = true;
    setError(null);
    void getCoauthorState(scope).then((value) => { if (current) setState(value); },
      (cause) => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [scope.projectId, scope.sessionId, attempt]);
  if (error) return <p role="alert" className="project-error">{error}<button onClick={() => setAttempt((value) => value + 1)}>重试</button></p>;
  if (!state) return <p role="status">正在读取工作稿…</p>;
  return <CoauthorSession scope={scope} initial={state} onFork={onFork} />;
}

function CoauthorSession({ scope, initial, onFork }: {
  scope: CoauthorScope; initial: CoauthorState; onFork: (session: DiscussionSession) => void;
}) {
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const transitioning = useProjectTransition();
  const draft = useCoauthorDraft(scope, initial.document);
  const [state, setState] = useState(initial);
  const composerKey = `coauthor-input:${scope.projectId}:${scope.sessionId}`;
  const [input, setInput] = useState(() => { try { return localStorage.getItem(composerKey) ?? ""; } catch { return ""; } });
  const inputRef = useRef(input);
  const [allowEdits, setAllowEdits] = useState(true);
  const [selection, setSelection] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const stateEpoch = useRef(0);
  const [stream, setStream] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState("chat");
  const [panel, setPanel] = useState<"sources" | "decisions" | "history" | "proposal" | "publish" | null>(null);
  const [publication, setPublication] = useState<{ document: CoauthorDocument; before: string } | null>(null);
  const [runId, setRunId] = useState(initial.runs[0]?.id ?? "");
  const [history, setHistory] = useState<CoauthorDocument[]>([]);
  const [older, setOlder] = useState<DiscussionMessage[]>([]);
  const [moreHistory, setMoreHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const subscriptions = useRef(new Set<() => void>());
  const editor = useRef<HTMLTextAreaElement>(null);
  const proposalSelection = useRef("");
  const thread = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<CoauthorSource | null>(null);
  const [editingDecision, setEditingDecision] = useState<CoauthorDecision | null>(null);
  const [serverConflict, setServerConflict] = useState<CoauthorDocument | null>(null);
  const messages = useQuery({
    queryKey: ["discussion-messages", scope.sessionId], queryFn: () => listDiscussionMessages(scope.sessionId), retry: false,
  });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const preferences = useAiTaskPreferences();
  const overrides = useQuery({ queryKey: ["project-ai-task-overrides"], queryFn: getProjectAiTaskOverrides });
  const effective = preferences.data ? {
    ...preferences.data, discussion: overrides.data?.discussion ?? resolveTaskPreference(preferences.data, "discussion"),
  } : undefined;
  const profile = resolveTaskChatProfile(profiles.data, effective, "discussion");
  const preference = resolveTaskPreference(effective, "discussion");
  const run = state.runs.find((entry) => entry.id === runId);
  const proposal = proposalFor(run);
  const canApply = run?.status === "COMPLETED" && proposal
    && draft.document.version === proposal.baseDocument.version && sameDraft(draft.document, proposal.baseDocument);
  const visible = [...new Map([...older, ...(messages.data ?? [])].map((message) => [message.id, message])).values()];
  const canSend = Boolean(profile?.hasSecret && preferences.isSuccess && overrides.isSuccess && messages.isSuccess
    && !busy && !draft.conflict && !draft.backup && input.trim() && [...input].length <= 20_000);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; subscriptions.current.forEach((remove) => remove()); subscriptions.current.clear(); };
  }, []);
  useEffect(() => {
    const el = thread.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [stream, messages.data, active]);
  useEffect(() => {
    if (!transitioning || !activeRef.current) return;
    const runId = activeRef.current;
    activeRef.current = null; setActive(null);
    void cancelCoauthorRun({ scope, runId }).catch(() => {});
  }, [transitioning, scope.projectId, scope.sessionId]);
  useUnsavedChangesGuard(draft.dirty || Boolean(input.trim()) || Boolean(active),
    "当前讨论有未发送输入、未保存工作稿或正在生成的结果。");

  function changeInput(value: string) {
    inputRef.current = value;
    setInput(value);
    try { if (value) localStorage.setItem(composerKey, value); else localStorage.removeItem(composerKey); }
    catch { setError("讨论输入备份失败，请暂时不要离开。"); }
  }
  async function refresh() {
    const epoch = ++stateEpoch.current;
    const updated = await getCoauthorState(scope);
    if (mounted.current && stateEpoch.current === epoch) setState(updated);
    await client.invalidateQueries({ queryKey: ["discussion-messages", scope.sessionId] });
    return updated;
  }
  async function act(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function stop() {
    const id = activeRef.current;
    if (!id) return;
    // Invalidate automatic application before waiting for the cancellation response.
    activeRef.current = null; setActive(null);
    await cancelCoauthorRun({ scope, runId: id });
    if (mounted.current) setNotice("已停止；已生成内容保留，尚未完成的结果不会自动改稿。");
  }
  async function send() {
    if (!canSend || !profile || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    const text = input;
    let unlisten: (() => void) | undefined;
    let id: string | null = null;
    let ownsBusy = true;
    let acknowledged = false;
    function acknowledge() {
      if (acknowledged) return;
      acknowledged = true;
      if (inputRef.current === text) changeInput("");
      void client.invalidateQueries({ queryKey: ["discussion-messages", scope.sessionId] });
    }
    try {
      const snapshot = await draft.save();
      if (!mounted.current) return;
      if (activeRef.current) await stop();
      id = crypto.randomUUID();
      const started = id;
      activeRef.current = started; setActive(started); setStream(""); setProgress("正在准备…");
      stateEpoch.current++;
      unlisten = await listen("coauthor-progress", ({ payload }) => {
        if (!mounted.current || activeRef.current !== started || payload.runId !== started || payload.sessionId !== scope.sessionId) return;
        acknowledge();
        if (payload.kind === "text") setStream((value) => value + payload.content);
        else setProgress(payload.kind === "tool" ? `正在查证 / ${payload.content}` : payload.content);
      });
      subscriptions.current.add(unlisten);
      if (!mounted.current || activeRef.current !== started) return;
      // The native request runs in the background; the composer remains available for new instructions.
      busyRef.current = false; ownsBusy = false; setBusy(false);
      const result = await runCoauthor({
        scope, runId: started, profileId: profile.id, message: text,
        expectedDocumentVersion: snapshot.version, selection: selection || null, allowDraftEdits: allowEdits,
        temperature: preference.temperature, maxOutputTokens: preference.maxOutputTokens,
      });
      if (!mounted.current) return;
      await client.invalidateQueries({ queryKey: ["discussion-messages", scope.sessionId] });
      if (activeRef.current !== started) {
        if (!activeRef.current) { stateEpoch.current++; setState(result.state); setRunId(started); setStream(""); }
        return;
      }
      acknowledge();
      stateEpoch.current++; setState(result.state); setRunId(started);
      const completed = result.state.runs.find((entry) => entry.id === started);
      const pending = proposalFor(completed);
      if (completed?.status === "COMPLETED" && pending && allowEdits
        && draft.current.current.version === snapshot.version && sameDraft(draft.current.current, snapshot)) {
        const saved = await applyCoauthorProposal({ scope, runId: started, expectedVersion: snapshot.version });
        if (mounted.current && activeRef.current === started) {
          draft.acceptSaved(saved, snapshot);
          setNotice("工作稿已更新，尚未正式采用。");
        }
      } else if (pending) setNotice("已保留 AI 改稿建议，当前编辑未被覆盖。");
      if (completed?.status !== "COMPLETED") {
        const failure = completed?.audit.find((value) => value && typeof value === "object" && "kind" in value && value.kind === "error");
        setError(failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string"
          ? failure.message : statuses[completed?.status ?? "FAILED"] ?? "本轮未完成");
      }
      setStream("");
    } catch (cause) {
      if (mounted.current && (id === null || activeRef.current === id)) {
        setError(errorMessage(cause));
        // Keep the input and partial text until persistence has been checked.
        void refresh().catch(() => {});
      }
    } finally {
      unlisten?.();
      if (unlisten) subscriptions.current.delete(unlisten);
      if (id !== null && activeRef.current === id) {
        activeRef.current = null;
        if (mounted.current) setActive(null);
      }
      if (ownsBusy) { busyRef.current = false; if (mounted.current) setBusy(false); }
    }
  }
  async function fork(local = false) {
    await act(async () => {
      if (!local) await draft.save();
      const created = await forkCoauthorSession({ scope, title: `${draft.document.title.slice(0, 180)} · 分支` });
      if (local) await saveCoauthorDocument({
        scope: { ...scope, sessionId: created.id }, document: { ...draft.current.current, sessionId: created.id, version: 1 },
      });
      if (mounted.current) onFork(created);
    });
  }
  async function showHistory() {
    await act(async () => {
      setHistory(await listCoauthorDocumentHistory({ scope }));
      if (mounted.current) setPanel("history");
    });
  }
  async function publish() {
    await act(async () => {
      const saved = await draft.save();
      if (!sameDraft(draft.current.current, saved)) throw new Error("工作稿仍在变化，请保存后重新核对。");
      let before = "";
      if (saved.targetKey && saved.targetRevision) {
        let offset = 0;
        do {
          const page = await readCoauthorSource({ scope, key: saved.targetKey, revision: saved.targetRevision, offset });
          before += page.content; offset += [...page.content].length;
          if (offset >= page.totalChars) break;
          if (!page.content || offset > 500_000) throw new Error("原文过长，请在对应资料编辑器核对后采用。");
        } while (mounted.current);
      }
      if (mounted.current) { setPublication({ document: saved, before }); setPanel("publish"); }
    });
  }
  async function commitPublication() {
    if (!publication) return;
    const { document: saved } = publication;
    await act(async () => {
      const snapshot = { ...draft.current.current };
      if (!sameDraft(snapshot, saved) || snapshot.version !== saved.version) throw new Error("差异已过期，请重新核对正式采用。");
      const allowed = await confirm({
        title: "正式采用当前工作稿",
        message: `${kinds[saved.kind]}「${saved.title}」v${saved.version}，${[...saved.content].length} 字。`
          + (saved.targetKey ? `替换关联目标 ${saved.targetKey}。旧结构属性将重置为全书设定，旧修订的作者规则不继承；别名、标签和旧修订保留。` : "创建一个新的正式条目。")
          + "仅提交当前稿件，不会自动同步其他设定、章节、事实或伏笔。",
        confirmLabel: "正式采用",
      });
      if (!allowed || !mounted.current) return;
      if (!sameDraft(draft.current.current, snapshot) || draft.current.current.version !== snapshot.version) {
        throw new Error("确认期间工作稿已变化，旧确认已失效。");
      }
      const key = await publishCoauthorDocument({ scope, expectedVersion: saved.version });
      const updated = await refresh();
      if (mounted.current) { draft.acceptSaved(updated.document, snapshot); setNotice(`已正式采用：${key}。其他内容未同步。`); }
      for (const queryKey of ["entities", "author-settings", "plan-nodes", "planning-sections", "chapters", "search", "manuscript"]) {
        void client.invalidateQueries({ queryKey: [queryKey] });
      }
    });
  }
  return <div className="coauthor-session">
    <nav className="coauthor-toolbar" aria-label="工作区">
      <div className="coauthor-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}><MessageSquareText size={15} />讨论</button>
        <button role="tab" aria-selected={tab === "draft"} onClick={() => setTab("draft")}><FileText size={15} />工作稿</button>
      </div>
      <div className="coauthor-tools">
        <button onClick={() => setPanel("sources")}><BookOpen size={15} />依据</button>
        <button onClick={() => setPanel("decisions")}>决定 <span>{state.decisions.length}</span></button>
        <button className="icon-command" title="工作稿版本" aria-label="工作稿版本" onClick={() => void showHistory()} disabled={busy}><History size={17} /></button>
        <button className="icon-command" title="另开分支" aria-label="另开分支" onClick={() => void fork()} disabled={busy || Boolean(active) || draft.conflict}><GitBranch size={17} /></button>
      </div>
    </nav>
    {(error || draft.error || messages.error || profiles.error || preferences.error || overrides.error) && <p role="alert" className="project-error">
      {error ?? draft.error ?? errorMessage(messages.error ?? profiles.error ?? preferences.error ?? overrides.error)}</p>}
    {notice && <p role="status" className="coauthor-notice">{notice}</p>}
    {draft.backup && <div className="coauthor-recovery" role="status">
      <strong>有尚未保存的本地工作稿</strong>
      <button onClick={() => { draft.change({ ...draft.backup!, version: draft.saved.current.version }); draft.dismissBackup(); }}>恢复到工作稿</button>
      <button onClick={() => { draft.dismissBackup(); setNotice("本地备份未采用，原记录保留至下一次编辑。"); }}>保留服务器版本</button>
      <details><summary>比较备份</summary><pre>{draft.backup.content}</pre></details>
    </div>}
    {draft.conflict && <div className="coauthor-recovery">
      <strong>服务器已出现新版本，你的编辑仍保留</strong>
      <button onClick={() => void act(async () => { setServerConflict((await getCoauthorState(scope)).document); })}>比较服务器版本</button>
      <button onClick={() => void fork(true)}>把本地编辑另存为分支</button>
      {serverConflict && <><pre>{serverConflict.content}</pre><button onClick={() => void act(async () => {
        const expected = { ...draft.current.current };
        if (await confirm({ message: "放弃当前本地修改，读取服务器版本？", confirmLabel: "读取服务器版本" })) {
          draft.acceptSaved(serverConflict, expected); setServerConflict(null);
        }
      })}>读取此版本</button></>}
    </div>}
    <div className="coauthor-columns" data-tab={tab}>
      <section className="coauthor-chat" aria-label="共创对话">
        <div className="coauthor-thread" ref={thread}>
          {visible.length >= 100 && moreHistory && <button disabled={busy} onClick={() => void act(async () => {
            const page = await listDiscussionMessages(scope.sessionId, 100, visible[0]?.id);
            if (mounted.current) { setOlder((entries) => [...page, ...entries]); setMoreHistory(page.length === 100); }
          })}>更早的讨论</button>}
          {!visible.length && !active && <p className="coauthor-placeholder">今天想推敲哪一部分？</p>}
          {visible.map((message) => <article key={message.id} className={`coauthor-message ${message.role === "USER" ? "is-author" : ""}`}>
            <header><strong>{message.role === "USER" ? "作者" : "共创伙伴"}</strong>
              {message.contextVersion?.startsWith("coauthor:") && <button onClick={() => {
                setRunId(message.contextVersion!.slice(9)); setPanel("sources");
              }}><BookOpen size={13} />依据与记录</button>}
              {message.contextVersion?.startsWith("coauthor:") && <small>{statuses[state.runs.find((entry) =>
                entry.id === message.contextVersion!.slice(9))?.status ?? ""]}</small>}
            </header>
            <div>{message.content}</div>
          </article>)}
          {(active || stream) && <article className="coauthor-message"><header><strong>共创伙伴</strong><small>{active ? progress : "未完成的输出"}</small></header><div>{stream}</div></article>}
        </div>
        <form className="coauthor-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {selection && <div className="coauthor-selection"><span>选区 · {selection.slice(0, 40)}</span>
            <button type="button" className="icon-command" title="清除选区" aria-label="清除选区" onClick={() => setSelection("")}><X size={14} /></button></div>}
          <textarea aria-label="讨论输入" placeholder="聊想法、查资料，或接着写…" value={input}
            onChange={(event) => changeInput(event.target.value)} rows={3} />
          <div className="coauthor-composer-actions">
            <label><input type="checkbox" checked={allowEdits} onChange={(event) => setAllowEdits(event.target.checked)} />允许改工作稿</label>
            <small>{profile?.name ?? "未选择模型"}</small>
            {active && <button type="button" className="icon-command" title="停止生成" aria-label="停止生成" onClick={() => void stop().catch((cause) => setError(errorMessage(cause)))}><Square size={16} /></button>}
            <button type="submit" className="primary-action" disabled={!canSend} title={active ? "停止旧任务并发送补充指令" : "发送"}
              aria-label={active ? "发送补充指令" : "发送"}><Send size={16} /></button>
          </div>
          {input && <button className="coauthor-clear-input" type="button" onClick={() => changeInput("")}>清空输入</button>}
          {[...input].length > 20_000 && <p role="alert" className="project-error">本轮输入超过 20000 字，请分轮讨论；原文未被截断。</p>}
        </form>
      </section>
      <section className="coauthor-draft" aria-label="当前工作稿">
        <div className="coauthor-draft-toolbar">
          <select aria-label="稿件类型" value={draft.document.kind} onChange={(event) => draft.change({
            kind: event.target.value as CoauthorDocument["kind"], targetKey: null, targetRevision: null,
          })}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <small>{draft.saving ? "保存中…" : draft.dirty ? "待保存" : `已保存 v${draft.document.version}`}</small>
          <button className="icon-command" title="保存工作稿" aria-label="保存工作稿" disabled={draft.saving || busy || draft.conflict}
            onClick={() => void act(async () => { await draft.save(); })}><Save size={16} /></button>
          <button className="secondary-action" disabled={busy || Boolean(active) || draft.conflict || Boolean(draft.backup) || !draft.document.content.trim()
            || Boolean(draft.document.targetKey && draft.document.kind !== "SETTING")} onClick={() => void publish()}><Check size={15} />正式采用</button>
        </div>
        <input className="coauthor-title" aria-label="稿件标题" maxLength={200} value={draft.document.title} onChange={(event) => draft.change({ title: event.target.value })} />
        <input className="coauthor-position" aria-label="叙事位置与视角" placeholder="叙事位置 / 视角" value={draft.document.narrativePosition}
          onChange={(event) => draft.change({ narrativePosition: event.target.value })} />
        {draft.document.targetKey && <div className="coauthor-target"><span>关联：{draft.document.targetKey}</span>
          <button title="解除关联，下一次采用将创建新条目" onClick={() => draft.change({ targetKey: null, targetRevision: null })}>解除关联</button></div>}
        {draft.document.targetKey && draft.document.kind !== "SETTING" && <p className="coauthor-notice">已关联的正文与大纲暂不支持在此覆盖；正式修订请进入对应编辑器。</p>}
        <textarea ref={editor} className="coauthor-manuscript" aria-label="工作稿内容" value={draft.document.content}
          onChange={(event) => { draft.change({ content: event.target.value }); setSelection(""); }}
          onSelect={(event) => {
            const el = event.currentTarget;
            if (el.selectionEnd > el.selectionStart) setSelection(el.value.slice(el.selectionStart, el.selectionEnd));
          }} />
        <footer><small>{[...draft.document.content].length} 字 · 工作稿</small>
          {proposal && <button onClick={() => setPanel("proposal")}>查看改稿差异</button>}</footer>
      </section>
    </div>
    <WorkspacePanel open={panel !== null} title={panel === "sources" ? "依据与运行记录" : panel === "decisions" ? "讨论决定" : panel === "history" ? "稿件版本" : panel === "publish" ? "正式采用预览" : "改稿差异"}
      onClose={() => { setPanel(null); setSource(null); }}>
      {panel === "sources" && <>
        <select aria-label="查看运行" value={runId} onChange={(event) => { setRunId(event.target.value); setSource(null); }}>
          <option value="">选择运行</option>{state.runs.map((entry) => <option key={entry.id} value={entry.id}>{statuses[entry.status] ?? entry.status} · {entry.id.slice(0, 8)}</option>)}
        </select>
        {run && <p>{statuses[run.status]} · 基础稿件 v{run.documentVersion}</p>}
        {run && run.status !== "COMPLETED" && run.output && <details><summary>保留的回复（未完成）</summary><pre>{run.output}</pre></details>}
        {run?.status === "RUNNING" && <button disabled={busy} onClick={() => void act(async () => {
          await cancelCoauthorRun({ scope, runId: run.id }); await refresh();
        })}>停止此运行</button>}
        {sourcesFor(run).map((hit) => <article className="coauthor-source" key={`${hit.key}:${hit.revision}`}>
          <strong>{hit.title}</strong><small>{hit.kind} · {hit.read ? "已读取原文片段" : "检索命中"} · {hit.sent ? "已随请求发送" : "尚未随请求发送"}</small><p>{hit.content}</p>
          <button onClick={() => void act(async () => { setSource(await readCoauthorSource({ scope, key: hit.key, revision: hit.revision, offset: 0 })); })}>查看原文</button>
        </article>)}
        {!run && <p>此记录不在最近的运行列表中，原始讨论仍保留。</p>}
        {source && <section className="coauthor-source-text"><h3>{source.title}</h3><small>修订 {source.revision}</small><pre>{source.content}</pre>
          {source.offset + [...source.content].length < source.totalChars && <button disabled={busy} onClick={() => void act(async () => {
            const next = await readCoauthorSource({ scope, key: source.key, revision: source.revision, offset: source.offset + [...source.content].length });
            if (mounted.current) setSource(next);
          })}>下一段</button>}</section>}
        {run && <details><summary>运行步骤</summary><ol>{run.audit.map((raw, index) => {
          const step = raw as { kind?: string; name?: string; round?: number; inputChars?: number; message?: string };
          return <li key={index}>{step.kind === "model_request" ? `模型请求 ${step.round} · 输入估算 ${step.inputChars} 字符`
            : step.kind === "tool" ? `工具：${step.name}` : step.kind === "initial_search" ? "自动检索候选"
              : step.kind === "draft_proposal" ? "准备工作稿修改，未正式提交" : step.message ?? step.kind}</li>;
        })}</ol></details>}
      </>}
      {panel === "decisions" && <>
        <p>仅适用于当前讨论与分支，尚未改变正式设定。</p>
        {state.decisions.map((decision) => <article className="coauthor-source" key={decision.id}>
          <strong>{decision.topic}</strong><small>{statuses[decision.status]} · v{decision.version}</small><p>{decision.content}</p>
          <button onClick={() => setEditingDecision({ ...decision })}>纠正</button>
        </article>)}
        {editingDecision && <form onSubmit={(event) => {
          event.preventDefault(); void act(async () => {
            if (activeRef.current) await stop();
            await correctCoauthorDecision({ scope, id: editingDecision.id, expectedVersion: editingDecision.version,
              content: editingDecision.content, status: editingDecision.status });
            await refresh(); if (mounted.current) setEditingDecision(null);
          });
        }}>
          <textarea aria-label="决定内容" value={editingDecision.content} onChange={(event) => setEditingDecision({ ...editingDecision, content: event.target.value })} />
          <select aria-label="决定状态" value={editingDecision.status} onChange={(event) => setEditingDecision({ ...editingDecision, status: event.target.value })}>
            {["CHOSEN", "REJECTED", "OPEN", "WITHDRAWN"].map((value) => <option key={value} value={value}>{statuses[value]}</option>)}
          </select><button disabled={busy} type="submit">保存纠正</button>
        </form>}
      </>}
      {panel === "history" && <p><a href={`/discussion?design=results&targetProject=${encodeURIComponent(scope.projectId)}&targetSession=${encodeURIComponent(scope.sessionId)}`}>历史构思草稿与候选</a></p>}
      {panel === "history" && history.map((version) => <article className="coauthor-source" key={version.version}>
        <strong>v{version.version} · {version.title}</strong><details><summary>查看内容</summary><pre>{version.content}</pre></details>
        <button disabled={busy} onClick={() => void act(async () => {
          const snapshot = { ...draft.current.current };
          if (!await confirm({ message: `将 v${version.version} 恢复为新的工作稿修订？现有修订仍保留。`, confirmLabel: "恢复版本" })) return;
          if (!sameDraft(draft.current.current, snapshot)) throw new Error("确认期间稿件已变化，未恢复。");
          draft.change({ ...version, version: snapshot.version }); await draft.save();
          setNotice("已恢复为新的工作稿修订，未改变正式内容。");
        })}>恢复为新版本</button>
        {history[history.length - 1]?.version === version.version && history.length % 50 === 0 && <button onClick={() => void act(async () => {
          const page = await listCoauthorDocumentHistory({ scope, beforeVersion: version.version });
          setHistory((entries) => [...entries, ...page]);
        })}>更早版本</button>}
      </article>)}
      {panel === "publish" && publication && <>
        <h3>{kinds[publication.document.kind]} · {publication.document.title} · v{publication.document.version}</h3>
        <p>{publication.document.targetKey ? `替换目标：${publication.document.targetKey}` : "创建新的正式条目"}</p>
        {publication.document.targetKey && publication.document.kind === "SETTING"
          && <p>本次完整替换会重置结构属性为全书设定，并不继承旧修订的作者规则。别名、标签和旧修订保留。</p>}
        <div className="coauthor-diff"><section><h4>正式原文</h4><pre>{publication.before || "无，新建条目"}</pre></section>
          <section><h4>采用后</h4><pre>{publication.document.content}</pre></section></div>
        <p>仅采用本稿件。未同步其他章节、设定或伏笔；正文知识仍需单独审核。</p>
        <button className="primary-action" disabled={busy || Boolean(active)} onClick={() => void commitPublication()}><Check size={15} />确认正式采用</button>
      </>}
      {panel === "proposal" && <>
        <h3>{draft.document.title} · 当前工作稿 v{draft.document.version}</h3>
        <pre className="coauthor-review-text">{draft.document.content}</pre>
        {proposal && <>
          <h3>AI 建议 · {statuses[run?.status ?? "FAILED"]}</h3>
          <div className="coauthor-diff"><section><h4>修改前 v{proposal.baseDocument.version}</h4><pre>{proposal.baseDocument.content}</pre></section>
            <section><h4>建议稿</h4><textarea aria-label="AI 建议稿" readOnly value={proposal.document.content} onSelect={(event) => {
              proposalSelection.current = event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
            }} /></section></div>
          <button disabled={!canApply || busy || Boolean(active)} onClick={() => void act(async () => {
            const snapshot = { ...draft.current.current };
            const saved = await applyCoauthorProposal({ scope, runId, expectedVersion: snapshot.version });
            if (mounted.current) draft.acceptSaved(saved, snapshot);
          })}>采用整份工作稿修改</button>
          <button disabled={busy || Boolean(active)} onClick={() => {
            const text = proposalSelection.current;
            if (!text) { setError("请先在 AI 建议稿中选择要采用的文字。"); return; }
            const current = draft.current.current;
            if (selection && current.content.split(selection).length !== 2) { setError("选区无法唯一定位，请重新选择。"); return; }
            draft.change({ content: selection ? current.content.replace(selection, text) : `${current.content}${text}` });
            setSelection(""); setNotice("仅采用选中文字，相关规则与其余建议未自动采用。");
          }}>仅采用选中文字</button>
          {!canApply && <p>整稿修改已过期或本轮未完成。当前稿件保留，可比较后仅采用所选文字。</p>}
        </>}
      </>}
    </WorkspacePanel>
  </div>;
}
