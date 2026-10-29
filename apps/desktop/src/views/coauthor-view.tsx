import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, BookOpen, Check, ClipboardList, Columns2, DatabaseZap, FileInput, FileText, GitBranch, GitCompareArrows, History, Info, ListChecks, MessageSquareText, MoreHorizontal, Pencil, Plus, Save, Send, Square, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "../lib/ipc-transport";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  applyCoauthorProposal, cancelCoauthorRun, correctCoauthorDecision, createDiscussionSession, deleteDiscussionSession, errorMessage,
  forkCoauthorSession, getCoauthorState, getCoauthorRun, getCurrentProject, getProjectAiTaskOverrides,
  listCoauthorDocumentHistory, listDiscussionMessages, listDiscussionSessions, listModelProfiles,
  publishCoauthorDocument, readCoauthorSource, renameDiscussionSession, runCoauthor, saveCoauthorDocument,
  type CoauthorDecision, type CoauthorDocument, type CoauthorRun, type CoauthorScope, type CoauthorSource,
  type CoauthorState, type DiscussionMessage, type DiscussionSession,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { useProjectTransition } from "../shell/project-actions-provider";
import { sameDraft, useCoauthorDraft } from "./use-coauthor-draft";
import { WorkspacePanel, useWideWorkspace } from "./workspace-panel";
import { useLayoutPreference } from "../lib/workspace-preferences";
import { CoauthorChangesPanel } from "./coauthor-changes-panel";
import { CoauthorChecksPanel } from "./coauthor-checks-panel";
import { CoauthorDecisionHistory, DecisionContext } from "./coauthor-decision-history";
import { CoauthorDecisionConsumers } from "./coauthor-decision-consumers";
import { CoauthorRunDirectory } from "./coauthor-run-directory";
import { CoauthorKnowledge } from "./coauthor-knowledge";
import { CoauthorSemanticPanel } from "./coauthor-semantic-panel";
import { CoauthorBranchesPanel } from "./coauthor-branches-panel";
import { CoauthorRunFeedback } from "./coauthor-reply-feedback";
import { replyReviewRequest } from "./coauthor-reply-diagnostics";
import { coauthorStepLabel, coauthorToolLabel, retrievalDisplay, splitLegacyRetrieval } from "./coauthor-run-presentation";
import "./coauthor-workspace.css";
import { coauthorKindLabels as kinds, draftIdentity, parseContentOrigin } from "../lib/content-taxonomy";
import { ContentTypeLabel, useInAiWorkspace } from "./content-identity";

const statuses: Record<string, string> = {
  RUNNING: "进行中", COMPLETED: "运行完成", FAILED: "本轮失败", CANCELLED: "已停止",
  SUPERSEDED: "已被新指令替代", INTERRUPTED: "中断，可继续讨论", LIMIT_REACHED: "达到本轮上限",
  CHOSEN: "已选择", REJECTED: "已否定", OPEN: "待定", WITHDRAWN: "已撤回",
};
type Proposal = { document: CoauthorDocument; baseDocument: CoauthorDocument };
function proposalFor(run?: CoauthorRun): Proposal | null {
  const item = [...(run?.audit ?? [])].reverse().find((value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && "kind" in value && value.kind === "draft_proposal");
  return item ? item as unknown as Proposal : null;
}
function sourcesFor(run?: CoauthorRun): Array<CoauthorSource & { read: boolean; sent: boolean; semantic?: boolean }> {
  const found = new Map<string, CoauthorSource & { read: boolean; sent: boolean; semantic?: boolean; checkReadId?: string }>();
  for (const raw of run?.audit ?? []) {
    const item = raw as { kind?: string; name?: string; readIds?: string[]; result?: {
      hits?: CoauthorSource[]; blocks?: Array<{ text: string }>; readId?: string;
    } & Partial<CoauthorSource> };
    if (item.kind === "model_request") for (const entry of found.values()) if (!entry.checkReadId) entry.sent = true;
    if (item.kind === "check_delivery") for (const entry of found.values()) {
      if (entry.checkReadId && item.readIds?.includes(entry.checkReadId)) entry.sent = true;
    }
    for (const hit of item.result?.hits ?? []) {
      const key = `${hit.key}:${hit.revision}`;
      const semantic = item.kind === "initial_semantic_search" || item.name === "search_semantic_sources";
      if (!found.has(key)) found.set(key, { ...hit, read: false, sent: false, semantic });
      else if (semantic) found.get(key)!.semantic = true;
    }
    if (item.kind === "tool" && (item.name === "read_source" || item.name === "read_check_source") && item.result?.key) {
      const source = item.result as CoauthorSource;
      const key = `${source.key}:${source.revision}`;
      found.set(key, { ...source, read: true, sent: false, semantic: found.get(key)?.semantic,
        checkReadId: item.name === "read_check_source" ? item.result?.readId : undefined });
    }
    if (item.kind === "tool" && (item.name === "read_outline_content" || item.name === "read_manuscript_blocks")
      && item.result?.key && item.result.revision) {
      const result = item.result;
      const key = `${result.key}:${result.revision}`;
      const previous = found.get(key);
      const content = result.content ?? result.blocks?.map((block) => block.text).join("\n") ?? "";
      found.set(key, { key: result.key!, revision: result.revision!, kind: item.name === "read_outline_content" ? "PLAN" : "MANUSCRIPT",
        title: result.title ?? previous?.title ?? result.key!, content, offset: result.offset ?? 0,
        totalChars: result.totalChars ?? previous?.totalChars ?? [...content].length, sessionId: null, read: true, sent: false });
    }
  }
  return [...found.values()];
}

export function CoauthorView() {
  const aiWorkspace = useInAiWorkspace();
  const client = useQueryClient();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const sessions = useQuery({ queryKey: ["discussion-sessions"], queryFn: listDiscussionSessions, enabled: Boolean(project.data) });
  const target = new URLSearchParams(window.location.search);
  const [selected, setSelected] = useState<string | null>(() => target.get("targetSession") ?? (window.location.hash.slice(1) || null));
  const [error, setError] = useState<string | null>(null);
  const [nameEditor, setNameEditor] = useState<{ projectId: string; session?: DiscussionSession; title: string } | null>(null);
  const projectId = project.data?.projectId;
  useEffect(() => { setNameEditor(null); }, [projectId]);
  const available = sessions.data?.filter((entry) => entry.projectId === projectId) ?? [];
  const session = available.find((entry) => entry.id === selected) ?? (!selected ? available[0] : undefined);
  const wrongTarget = Boolean(target.get("targetProject") && target.get("targetProject") !== projectId);
  const origin = parseContentOrigin(session?.scopeText, projectId);
  function select(id: string | null) {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.delete("targetSession");
    url.searchParams.delete("targetProject");
    url.hash = id ?? "";
    window.history.replaceState(null, "", url);
  }
  function openCreate() {
    if (!projectId || nameEditor) return;
    let number = available.length + 1;
    while (available.some((entry) => entry.title === `共创讨论 ${number}`)) number++;
    setNameEditor({ projectId, title: `共创讨论 ${number}` });
  }
  return <section className="coauthor-workspace">
    {(available.length > 0 || !aiWorkspace) && <header className="coauthor-heading">
      {!aiWorkspace && <h1>共创讨论</h1>}
      <label className="coauthor-session-picker">当前讨论<select aria-label="当前讨论" value={session?.id ?? ""} onChange={(event) => select(event.target.value)}>
        {!session && <option value="">选择讨论</option>}
        {available.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
      </select></label>
      <button className="icon-command" type="button" title="重命名讨论" aria-label="重命名讨论" disabled={Boolean(nameEditor) || !session}
        onClick={() => { if (session && projectId) setNameEditor({ projectId, session, title: session.title }); }}><Pencil size={16} /></button>
      {available.length > 0 && <button className="secondary-action" type="button" title="创建独立讨论，不复制当前工作稿" disabled={Boolean(nameEditor) || !projectId} onClick={openCreate}><Plus size={16} />新建讨论</button>}
    </header>}
    {origin && !wrongTarget && <div className="ai-workspace-identity" aria-label="讨论来源">
      <div><ContentTypeLabel identity={origin} /><h2>{origin.title}</h2></div>
    </div>}
    {(error || sessions.error || project.error) && <p className="project-error" role="alert">{error ?? errorMessage(sessions.error ?? project.error)}</p>}
    {wrongTarget ? <p role="alert">讨论链接不属于当前项目，未读取或修改该讨论。</p>
      : session && projectId ? <CoauthorLoader key={`${projectId}:${session.id}`} scope={{ projectId, sessionId: session.id }}
        sessionTitle={session.title} onDeleted={(warning) => {
          const remaining = client.getQueryData<DiscussionSession[]>(["discussion-sessions"])?.filter((entry) => entry.id !== session.id) ?? [];
          client.setQueryData(["discussion-sessions"], remaining);
          client.removeQueries({ queryKey: ["discussion-messages", session.id] });
          client.removeQueries({ predicate: (query) => query.queryKey.includes(projectId) && query.queryKey.includes(session.id) });
          if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId === projectId) {
            select(remaining.find((entry) => entry.projectId === projectId)?.id ?? null);
            setError(warning ?? null);
          }
        }}
        onFork={(created) => {
          client.setQueryData<DiscussionSession[]>(["discussion-sessions"], (entries) => [created, ...(entries ?? [])]);
          select(created.id);
        }} />
        : sessions.isPending ? <p role="status">正在读取讨论…</p>
          : selected ? <p role="alert">指定讨论不存在，请选择其他讨论。</p>
            : <div className="coauthor-empty"><MessageSquareText size={32} /><h2>从一个想法开始</h2>
              <button className="primary-action" disabled={Boolean(nameEditor) || !projectId} onClick={openCreate}><Plus size={16} />新建讨论</button></div>}
    {nameEditor && nameEditor.projectId === projectId && <DiscussionNameDialog
      key={`discussion-name:${nameEditor.projectId}:${nameEditor.session?.id ?? "new"}`} projectId={nameEditor.projectId}
      session={nameEditor.session} initialTitle={nameEditor.title} onClose={() => setNameEditor(null)}
      onSaved={(saved) => {
        client.setQueryData<DiscussionSession[]>(["discussion-sessions"], (entries) => nameEditor.session
          ? (entries ?? []).map((entry) => entry.id === saved.id ? saved : entry)
          : [saved, ...(entries ?? []).filter((entry) => entry.id !== saved.id)]);
        if (!nameEditor.session) select(saved.id);
        setError(null);
        setNameEditor(null);
      }} />}
  </section>;
}

function DiscussionNameDialog({ projectId, session, initialTitle, onClose, onSaved }: {
  projectId: string; session?: DiscussionSession; initialTitle: string; onClose: () => void;
  onSaved: (session: DiscussionSession) => void;
}) {
  const client = useQueryClient();
  const transitioning = useProjectTransition();
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useUnsavedChangesGuard(busy || title !== initialTitle, busy ? "讨论名正在保存。" : "讨论名尚未保存。");
  async function submit() {
    if (inFlight.current || transitioning || !title.trim()) return;
    if (client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== projectId) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = session
        ? await renameDiscussionSession({ scope: { projectId, sessionId: session.id }, title: title.trim(), expectedTitle: session.title })
        : await createDiscussionSession({ title: title.trim(), scopeKind: "PROJECT", scopeId: null, scopeText: null, topicKind: "FREE" });
      if (!mounted.current || client.getQueryData<{ projectId: string }>(["current-project"])?.projectId !== projectId) return;
      if (saved.projectId !== projectId) throw new Error("项目已切换，未打开新的讨论。");
      onSaved(saved);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <WorkspacePanel open title={session ? "重命名讨论" : "新建讨论"} className="coauthor-name-dialog"
    onClose={() => { if (!inFlight.current) onClose(); }}>
    <form className="coauthor-name-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>讨论名<input ref={input} autoFocus maxLength={200} value={title} disabled={busy}
        onChange={(event) => setTitle(event.target.value)} /></label>
      {error && <p className="project-error" role="alert">{error}</p>}
      <div className="coauthor-name-actions">
        <button className="secondary-action" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-action" type="submit" disabled={busy || transitioning || !title.trim()}>
          {session ? <Check size={16} /> : <Plus size={16} />}{busy ? "保存中…" : session ? "保存名称" : "创建讨论"}</button>
      </div>
    </form>
  </WorkspacePanel>;
}

function CoauthorLoader({ scope, sessionTitle, onFork, onDeleted }: {
  scope: CoauthorScope; sessionTitle: string; onFork: (session: DiscussionSession) => void; onDeleted: (warning?: string) => void;
}) {
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
  return <CoauthorSession scope={scope} initial={state} sessionTitle={sessionTitle} onFork={onFork} onDeleted={onDeleted} />;
}

function CoauthorSession({ scope, initial, sessionTitle, onFork, onDeleted }: {
  scope: CoauthorScope; initial: CoauthorState; sessionTitle: string; onFork: (session: DiscussionSession) => void; onDeleted: (warning?: string) => void;
}) {
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const transitioning = useProjectTransition();
  const draft = useCoauthorDraft(scope, initial.document);
  const [state, setState] = useState(initial);
  const composerKey = `coauthor-input:${scope.projectId}:${scope.sessionId}`;
  const [input, setInput] = useState(() => { try { return localStorage.getItem(composerKey) ?? ""; } catch { return ""; } });
  const inputRef = useRef(input);
  const [allowEdits, setAllowEdits] = useState(false);
  const [selection, setSelection] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const stateEpoch = useRef(0);
  const [stream, setStream] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState("chat");
  const wide = useWideWorkspace(1180);
  const [preferSplit, setPreferSplit] = useLayoutPreference("coauthor-split", false);
  const split = wide && preferSplit;
  const [panel, setPanel] = useState<"sources" | "semantic" | "checks" | "decisions" | "history" | "publish" | "changes" | "branches" | null>(null);
  const [recordSections, setRecordSections] = useState(["sources"]);
  const recordsOpen = panel === "sources" || panel === "checks" || panel === "semantic";
  const [publication, setPublication] = useState<{ document: CoauthorDocument; before: string } | null>(null);
  const [runId, setRunId] = useState(initial.runs[0]?.id ?? "");
  const [recordTab, setRecordTab] = useState<"overview" | "retrieval" | "sources" | "steps" | "proposal">("overview");
  const [recordMessageId, setRecordMessageId] = useState<string | null>(null);
  const [history, setHistory] = useState<CoauthorDocument[]>([]);
  const [changeSetId, setChangeSetId] = useState<string | null>(null);
  const [older, setOlder] = useState<DiscussionMessage[]>([]);
  const [moreHistory, setMoreHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const subscriptions = useRef(new Set<() => void>());
  const editor = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const focusReview = useRef(false);
  const [proposalSelection, setProposalSelection] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const historyScroll = useRef<{ height: number; top: number } | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const panelFeedback = useRef<HTMLDivElement>(null);
  const discussionMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (discussionMenu.current && !discussionMenu.current.contains(event.target as Node)) discussionMenu.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const [source, setSource] = useState<CoauthorSource | null>(null);
  const [editingDecision, setEditingDecision] = useState<CoauthorDecision | null>(null);
  const [serverConflict, setServerConflict] = useState<CoauthorDocument | null>(null);
  useEffect(() => {
    if (panel !== null || !focusReview.current || !composer.current) return;
    focusReview.current = false;
    const element = composer.current;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollTop = element.scrollHeight;
  }, [panel, input, tab]);
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
  const runQuery = useQuery({
    queryKey: ["coauthor-run", scope.projectId, scope.sessionId, runId],
    queryFn: () => getCoauthorRun({ scope, id: runId }),
    enabled: Boolean(runId && panel === "sources"), retry: false,
  });
  const run = runQuery.data;
  const runVerified = runQuery.isSuccess && !runQuery.isFetching;
  const proposal = proposalFor(run);
  const canApply = runVerified && run?.status === "COMPLETED" && proposal && state.runs[0]?.id === run.id
    && draft.document.version === proposal.baseDocument.version && sameDraft(draft.document, proposal.baseDocument);
  const visible = [...new Map([...older, ...(messages.data ?? [])].map((message) => [message.id, message])).values()];
  const recordReply = visible.find((message) => message.id === recordMessageId)
    ?? visible.find((message) => message.role === "ASSISTANT" && message.contextVersion === `coauthor:${runId}`);
  const legacyReceipt = recordReply?.contextVersion?.startsWith("coauthor:") ? splitLegacyRetrieval(recordReply.content).receipt : null;
  const receiptText = (run ? retrievalDisplay(run) : null) ?? legacyReceipt;
  const canSend = Boolean(profile?.hasSecret && preferences.isSuccess && overrides.isSuccess && messages.isSuccess
    && !busy && !draft.conflict && !draft.backup && input.trim() && [...input].length <= 20_000);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; subscriptions.current.forEach((remove) => remove()); subscriptions.current.clear(); };
  }, []);
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el || (!split && tab !== "chat")) return;
    if (historyScroll.current) {
      el.scrollTop = historyScroll.current.top + el.scrollHeight - historyScroll.current.height;
      historyScroll.current = null;
    } else if (followLatest.current) {
      el.scrollTop = el.scrollHeight;
      setAwayFromLatest(false);
    }
  }, [stream, messages.data, active, older, tab, split]);
  useEffect(() => {
    const el = thread.current;
    if (!el || (!split && tab !== "chat") || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab, split]);
  useEffect(() => { setProposalSelection(""); }, [run]);
  useEffect(() => { setSource(null); }, [runId]);
  useEffect(() => {
    if (panel && (error || notice || draft.error)) panelFeedback.current?.scrollIntoView?.({ block: "nearest" });
  }, [error, notice, draft.error, panel]);
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
  function jumpToLatest() {
    followLatest.current = true;
    setAwayFromLatest(false);
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }
  function reviewReply(message: DiscussionMessage) {
    if (activeRef.current || busyRef.current) return;
    const request = replyReviewRequest(message);
    const next = inputRef.current.trim() ? `${inputRef.current}\n\n${request}` : request;
    if ([...next].length > 20_000) {
      setError("这条回复与当前输入合计超过 20000 字，未截断或覆盖。请在输入框粘贴需核对的原句并补充问题。");
      setPanel(null); setTab("chat"); focusReview.current = true;
      return;
    }
    changeInput(next);
    // Reviewing a reply must not carry a prior permission to edit the draft.
    setAllowEdits(false);
    setSelection("");
    setPanel(null); setTab("chat"); focusReview.current = true;
    setNotice("已将指定回复带入输入框，尚未发送；本轮已关闭工作稿修改授权。");
  }
  function openRecords(message?: DiscussionMessage, id?: string, category: typeof recordTab = "overview") {
    setRecordMessageId(message?.id ?? null);
    setRunId(id ?? (message ? (message.contextVersion?.startsWith("coauthor:") ? message.contextVersion.slice(9) : "")
      : state.runs[0]?.id || ""));
    setProposalSelection(""); setRecordSections(["sources"]);
    setRecordTab(category); setSource(null); setPanel("sources");
  }
  async function appendReply(message: DiscussionMessage) {
    if (activeRef.current || busyRef.current || draft.conflict || draft.backup) return;
    const text = message.contextVersion?.startsWith("coauthor:")
      ? splitLegacyRetrieval(message.content).reply : message.content;
    if (!text.trim()) return;
    await act(async () => {
      if (draft.current.current.content.trim() && !await confirm({
        title: "追加回复到工作稿",
        message: "将这条回复的正文追加到工作稿末尾，已有稿件和讨论原文保留，不写入正式内容。",
        confirmLabel: "追加到末尾",
      })) return;
      if (!mounted.current || activeRef.current || draft.conflict || draft.backup) return;
      const content = draft.current.current.content;
      draft.change({ content: content.trim() ? `${content}\n\n${text}` : text });
      setSelection(""); setTab("draft");
      setNotice("回复已放入工作稿，尚未正式采用。");
    });
  }
  async function removeDiscussion() {
    if (activeRef.current || busyRef.current || draft.saving) return;
    await act(async () => {
      if (!await confirm({
        title: "删除当前讨论",
        message: `删除「${sessionTitle}」？讨论及工作稿将从列表移除，当前输入和本地备份会清除，不能在此恢复。已正式采用的内容和其他分支不变；历史记录仍保留用于来源追溯。`,
        confirmLabel: "删除讨论",
      })) return;
      if (!mounted.current || activeRef.current) return;
      await deleteDiscussionSession(scope);
      let warning: string | undefined;
      for (const key of [composerKey, `coauthor-draft:${scope.projectId}:${scope.sessionId}`]) {
        try { localStorage.removeItem(key); }
        catch { warning = "讨论已从列表移除，但本机输入或工作稿备份未能完全清除；历史来源记录仍保留。"; }
      }
      if (mounted.current) onDeleted(warning);
    });
  }
  async function refresh() {
    const epoch = ++stateEpoch.current;
    const updated = await getCoauthorState(scope);
    if (mounted.current && stateEpoch.current === epoch) setState(updated);
    await client.invalidateQueries({ queryKey: ["coauthor-run", scope.projectId, scope.sessionId] });
    await client.invalidateQueries({ queryKey: ["coauthor-runs", scope.projectId, scope.sessionId] });
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
      jumpToLatest();
      activeRef.current = started; setActive(started); setStream(""); setProgress("正在准备…");
      stateEpoch.current++;
      unlisten = await listen("coauthor-progress", ({ payload }) => {
        if (!mounted.current || activeRef.current !== started || payload.runId !== started || payload.sessionId !== scope.sessionId) return;
        acknowledge();
        if (payload.kind === "text") setStream((value) => value + payload.content);
        else setProgress(payload.kind === "tool" ? `正在${coauthorToolLabel(payload.content)}` : payload.content);
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
      client.setQueryData(["coauthor-run", scope.projectId, scope.sessionId, started], result.run);
      void client.invalidateQueries({ queryKey: ["coauthor-runs", scope.projectId, scope.sessionId] });
      await client.invalidateQueries({ queryKey: ["discussion-messages", scope.sessionId] });
      if (activeRef.current !== started) {
        if (!activeRef.current) { stateEpoch.current++; setState(result.state); setRunId(started); setStream(""); }
        return;
      }
      acknowledge();
      stateEpoch.current++; setState(result.state); setRunId(started);
      const completed = result.run;
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
      if (draft.current.current.kind === "UNCLASSIFIED") throw new Error("工作稿尚未归类，未提交正式采用。");
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
  async function changeKind(kind: CoauthorDocument["kind"]) {
    if (kind === draft.current.current.kind || activeRef.current || busyRef.current) return;
    const snapshot = { ...draft.current.current };
    await act(async () => {
      if ((snapshot.content.trim() || snapshot.targetKey) && !await confirm({
        title: "更改工作稿类型", message: `将「${snapshot.title}」从${kinds[snapshot.kind]}改为${kinds[kind]}？内容保留，原采用目标将解除，正式内容不变。`,
        confirmLabel: "确认更改类型",
      })) return;
      if (!mounted.current || !sameDraft(snapshot, draft.current.current) || activeRef.current) return;
      const title = ["未命名工作稿", "未命名设定", "未命名大纲", "未命名正文"].includes(snapshot.title)
        ? kind === "UNCLASSIFIED" ? "未命名工作稿" : `未命名${kinds[kind]}` : snapshot.title;
      draft.change({ kind, title, targetKey: null, targetRevision: null });
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
  const feedback = <>
    {(error || draft.error || messages.error || profiles.error || preferences.error || overrides.error) && <p role="alert" className="project-error">
      {error ?? draft.error ?? errorMessage(messages.error ?? profiles.error ?? preferences.error ?? overrides.error)}</p>}
    {notice && <p role="status" className="coauthor-notice">{notice}</p>}
  </>;
  return <div className="coauthor-session">
    <nav className="coauthor-toolbar" aria-label="工作区">
      <div className="coauthor-tabs" role="tablist" aria-label="共创页签">
        <button id="coauthor-chat-tab" role="tab" aria-controls="coauthor-chat-panel" aria-selected={tab === "chat"} onClick={() => { setTab("chat"); setPreferSplit(false); }}><MessageSquareText size={15} />讨论</button>
        <button id="coauthor-draft-tab" role="tab" aria-controls="coauthor-draft-panel" aria-selected={tab === "draft"} onClick={() => { setTab("draft"); setPreferSplit(false); }}><FileText size={15} />工作稿</button>
      </div>
      <div className="coauthor-tools" role="group" aria-label="讨论工具">
        <button title="查看本轮记录、改稿建议、查证清单及检索设置" onClick={() => openRecords()}><BookOpen size={15} />依据与运行记录</button>
        <button title="查看和纠正当前讨论的决定" onClick={() => setPanel("decisions")}><ListChecks size={15} />讨论决定 <span>{state.decisions.length}</span></button>
      </div>
      {wide && <button className="icon-command coauthor-split-toggle" type="button"
        aria-label="并排显示讨论与工作稿" aria-pressed={split}
        title={split ? "取消并排，保留当前页签" : "并排显示讨论与工作稿"}
        onClick={() => setPreferSplit(!preferSplit)}><Columns2 size={17} /></button>}
      <details ref={discussionMenu} className="coauthor-discussion-menu" onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
        event.stopPropagation();
      }}>
        <summary aria-label="更多讨论操作" title="更多讨论操作"><MoreHorizontal size={17} /></summary>
        <div><button className="coauthor-delete" title={active ? "请先停止生成并等待运行结束" : "删除当前讨论，已采用的正式内容不变"}
        disabled={busy || Boolean(active) || draft.saving || transitioning || state.runs.some((entry) => entry.status === "RUNNING")}
        onClick={() => void removeDiscussion()}><Trash2 size={15} />删除当前讨论</button></div>
      </details>
    </nav>
    {!panel && feedback}
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
    <div className="coauthor-columns" data-tab={tab} data-split={split}>
      <section id="coauthor-chat-panel" className="coauthor-chat" role={split ? "region" : "tabpanel"} aria-label="讨论" hidden={!split && tab !== "chat"}>
        <header className="coauthor-area-heading"><h2><MessageSquareText size={17} />讨论区</h2>
          <details className="coauthor-reliability-note"><summary><Info size={14} />生成完成不代表内容可靠</summary>
            <p>AI 内容仍需核对。条件范围、新旧规则与前文承接仍可能出错，请对照原文确认。</p></details>
        </header>
        {state.runs[0] && state.runs[0].status !== "COMPLETED" && state.runs[0].id !== active && <div className="coauthor-incomplete" role="status">
          <span>最近一轮：{statuses[state.runs[0].status] ?? "状态待核实"}，不代表已完成你的要求。</span>
          <button type="button" onClick={() => openRecords(undefined, state.runs[0].id)}>查看原因与保留结果</button>
        </div>}
        <div className="coauthor-thread-wrap">
        <div className="coauthor-thread" ref={thread} role="log" aria-label="讨论记录" aria-live="off"
          onScroll={(event) => {
            if (!split && tab !== "chat") return;
            const el = event.currentTarget;
            const away = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
            followLatest.current = !away;
            setAwayFromLatest(away);
          }}>
          {visible.length >= 100 && moreHistory && <button disabled={busy} onClick={() => void act(async () => {
            const before = thread.current ? { height: thread.current.scrollHeight, top: thread.current.scrollTop } : null;
            const page = await listDiscussionMessages(scope.sessionId, 100, visible[0]?.id);
            if (mounted.current) {
              const el = thread.current;
              // Hidden tabs have zero layout metrics; retain the last visible reading position.
              historyScroll.current = el && el.clientHeight > 0 ? { height: el.scrollHeight, top: el.scrollTop } : before;
              setOlder((entries) => [...page, ...entries]); setMoreHistory(page.length === 100);
            }
          })}>更早的讨论</button>}
          {messages.isPending && <p role="status">正在读取讨论记录…</p>}
          {messages.isSuccess && !visible.length && !active && <p className="coauthor-placeholder">今天想推敲哪一部分？</p>}
          {visible.map((message) => {
            const display = message.role === "ASSISTANT" && message.contextVersion?.startsWith("coauthor:")
              ? splitLegacyRetrieval(message.content) : { reply: message.content, receipt: null };
            return <article key={message.id} className={`coauthor-message ${message.role === "USER" ? "is-author" : ""}`}>
            <header><strong>{message.role === "USER" ? "作者" : "共创伙伴"}</strong>
              {message.role === "ASSISTANT" && <button onClick={() => openRecords(message)}
                title="查看这条回复的依据与运行记录、问题说明及核对操作"><BookOpen size={13} />查看本轮记录</button>}
              {message.role === "ASSISTANT" && display.reply.trim() && <button
                disabled={busy || Boolean(active) || draft.conflict || Boolean(draft.backup)}
                title="将这条回复正文追加到工作稿；不自动采用为正式内容"
                onClick={() => void appendReply(message)}><FileInput size={13} />放入工作稿</button>}
            </header>
            <div>{display.reply}</div>
          </article>;
          })}
          {(active || stream) && <article className="coauthor-message"><header><strong>共创伙伴</strong><small>{active ? progress : "未完成的输出"}</small></header><div>{stream}</div></article>}
        </div>
        {awayFromLatest && <button type="button" className="coauthor-jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={14} />回到最新</button>}
        </div>
        <form className="coauthor-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {selection && <div className="coauthor-selection"><span>选区 · {selection.slice(0, 40)}</span>
            <button type="button" className="icon-command" title="清除选区" aria-label="清除选区" onClick={() => setSelection("")}><X size={14} /></button></div>}
          <textarea ref={composer} aria-label="讨论输入" placeholder="聊想法、查资料，或接着写…" value={input}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey
                || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void send();
            }}
            onChange={(event) => changeInput(event.target.value)} rows={2} />
          <div className="coauthor-composer-actions">
            <label><input type="checkbox" checked={allowEdits} onChange={(event) => setAllowEdits(event.target.checked)} />允许改工作稿</label>
            <small>{profile?.name ?? "未选择模型"}</small>
            {[...input].length > 16_000 && <span className="coauthor-input-count">{[...input].length} / 20000</span>}
            <button className="icon-command" type="button" title="清空输入" aria-label="清空输入" disabled={!input}
              onClick={() => { changeInput(""); composer.current?.focus(); }}><Trash2 size={15} /></button>
            {active && <button type="button" className="secondary-action" title="停止生成" aria-label="停止生成" onClick={() => void stop().catch((cause) => setError(errorMessage(cause)))}><Square size={16} />停止生成</button>}
            <button type="submit" className="primary-action" disabled={!canSend} title={active ? "停止旧任务并发送补充指令 (Ctrl/Cmd+Enter)" : "发送 (Ctrl/Cmd+Enter)"}
              aria-label={active ? "发送补充指令" : "发送"}><Send size={16} />{active ? "发送补充" : "发送"}</button>
          </div>
          {profiles.isSuccess && preferences.isSuccess && overrides.isSuccess && !profile?.hasSecret
            && <p className="coauthor-notice" role="status">未配置可用的讨论模型。<a href="/settings#models">配置模型</a></p>}
          {[...input].length > 20_000 && <p role="alert" className="project-error">本轮输入超过 20000 字，请分轮讨论；原文未被截断。</p>}
        </form>
      </section>
      <section id="coauthor-draft-panel" className="coauthor-draft" role={split ? "region" : "tabpanel"} aria-label="工作稿" hidden={!split && tab !== "draft"}>
        <header className="coauthor-area-heading"><h2><FileText size={17} /><ContentTypeLabel identity={draftIdentity(draft.document)} /></h2>
          <small><span>{draft.document.targetKey ? `已关联正式${kinds[draft.document.kind]}` : "仅保存在当前讨论"}</span>
            {" · "}<span>{draft.saving ? "保存中…" : draft.dirty ? "待保存" : `已保存 v${draft.document.version}`}</span></small></header>
        <div className="coauthor-draft-toolbar">
          <label className="coauthor-draft-kind">工作稿类型<select aria-label="稿件类型" value={draft.document.kind}
            disabled={busy || Boolean(active) || draft.conflict || Boolean(draft.backup)}
            onChange={(event) => void changeKind(event.target.value as CoauthorDocument["kind"])}>
            {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button className="secondary-action" title="仅保存工作稿，不改变正式内容" aria-label="保存工作稿" disabled={draft.saving || busy || draft.conflict}
            onClick={() => void act(async () => { await draft.save(); })}><Save size={16} />保存工作稿</button>
          <button className="secondary-action" title="预览并确认仅将当前工作稿写入正式内容，其他章节与设定不变" disabled={draft.document.kind === "UNCLASSIFIED" || busy || Boolean(active) || draft.conflict || Boolean(draft.backup) || !draft.document.content.trim()
            || Boolean(draft.document.targetKey && draft.document.kind !== "SETTING")} onClick={() => void publish()}><Check size={15} />正式采用</button>
        </div>
        <p className="coauthor-notice">采用目标：{draft.document.kind === "UNCLASSIFIED" ? "尚未确定"
          : draft.document.targetKey ? `${kinds[draft.document.kind]} · ${draft.document.title}`
            : `新建${draft.document.kind === "SETTING" ? "世界规则与概念设定" : kinds[draft.document.kind]} · ${draft.document.title}`}</p>
        <label className="coauthor-field coauthor-draft-title">稿件标题<input className="coauthor-title" aria-label="稿件标题" maxLength={200} value={draft.document.title} onChange={(event) => draft.change({ title: event.target.value })} /></label>
        {draft.document.targetKey && draft.document.kind !== "SETTING" && <p className="coauthor-notice">已关联的正文与大纲暂不支持在此覆盖；正式修订请进入对应编辑器。</p>}
        <label className="coauthor-field" htmlFor="coauthor-manuscript">工作稿内容</label>
        <textarea id="coauthor-manuscript" ref={editor} className="coauthor-manuscript" aria-label="工作稿内容" placeholder="暂无工作稿内容" value={draft.document.content}
          onChange={(event) => { draft.change({ content: event.target.value }); setSelection(""); }}
          onSelect={(event) => {
            const el = event.currentTarget;
            if (el.selectionEnd > el.selectionStart) setSelection(el.value.slice(el.selectionStart, el.selectionEnd));
          }} />
        <footer><small>{[...draft.document.content].length} 字 · {selection ? `已选 ${[...selection].length} 字` : "工作稿"}</small>
          {state.runs[0] && <button title="查看最近一轮的改稿建议，不改变工作稿" onClick={() => openRecords(undefined, state.runs[0].id, "proposal")}><FileText size={14} />查看改稿建议</button>}</footer>
        <details className="coauthor-draft-details coauthor-draft-advanced">
          <summary>更多稿件选项</summary>
          <label className="coauthor-field">叙事位置与视角<input className="coauthor-position" aria-label="叙事位置与视角" placeholder="尚未填写" value={draft.document.narrativePosition}
            onChange={(event) => draft.change({ narrativePosition: event.target.value })} /></label>
          {draft.document.targetKey && <div className="coauthor-target"><span>关联：{draft.document.targetKey}</span>
            <button title="解除关联，下一次采用将创建新条目" onClick={() => draft.change({ targetKey: null, targetRevision: null })}>解除关联</button></div>}
          <div className="coauthor-tools coauthor-draft-tools" role="group" aria-label="工作稿工具">
            <button title="查看或恢复工作稿的历史版本" onClick={() => void showHistory()} disabled={busy}><History size={15} />工作稿版本</button>
            <button title="复制当前工作稿和讨论决定，尝试另一方向" onClick={() => void fork()} disabled={busy || Boolean(active) || draft.conflict}><GitBranch size={15} />另开分支</button>
            <button onClick={() => setPanel("branches")}><GitCompareArrows size={15} />分支比较与合并</button>
            <button title="核对并采用涉及多处正式内容的修改，与仅采用当前工作稿不同"
              onClick={() => { setChangeSetId(null); setPanel("changes"); }}><ClipboardList size={15} />关联变更</button>
          </div>
        </details>
      </section>
    </div>
    <WorkspacePanel open={panel !== null} title={recordsOpen ? "依据与运行记录" : panel === "branches" ? "分支比较与合并" : panel === "changes" ? "关联变更与影响" : panel === "decisions" ? "讨论决定" : panel === "history" ? "稿件版本" : "正式采用预览"}
      onClose={() => { setPanel(null); setSource(null); }}>
      {panel && <div ref={panelFeedback}>{feedback}</div>}
      {recordsOpen && <div className="coauthor-record-sections" role="tablist" aria-label="依据与运行记录页签">
        {([["sources", "本轮记录", BookOpen], ["checks", "查证清单", ListChecks], ["semantic", "检索设置", DatabaseZap]] as const).map(([value, label, Icon]) =>
          <button key={value} id={`coauthor-section-${value}`} role="tab" aria-selected={panel === value} aria-controls={`coauthor-section-content-${value}`}
            onClick={() => { setRecordSections((sections) => sections.includes(value) ? sections : [...sections, value]); setPanel(value); }}><Icon size={15} />{label}</button>)}
      </div>}
      {panel === "branches" && <CoauthorBranchesPanel key={`${scope.projectId}:${scope.sessionId}`} scope={scope}
        getDocument={() => draft.current.current} saveDraft={async () => {
          if (draft.backup || draft.conflict) throw new Error("请先处理本地恢复稿或版本冲突，再比较分支。");
          return draft.save();
        }} isGenerating={() => Boolean(activeRef.current)} onDecisionsApplied={async () => { await refresh(); }} onApplied={async (merge) => {
          draft.acceptSaved(merge.after, merge.before); setSelection("");
          await refresh();
        }} />}
      {recordsOpen && recordSections.includes("semantic") && <section id="coauthor-section-content-semantic" role="tabpanel" aria-labelledby="coauthor-section-semantic" hidden={panel !== "semantic"}>
        <CoauthorSemanticPanel key={`${scope.projectId}:${scope.sessionId}`} scope={scope} />
      </section>}
      {recordsOpen && recordSections.includes("checks") && <section id="coauthor-section-content-checks" role="tabpanel" aria-labelledby="coauthor-section-checks" hidden={panel !== "checks"}><CoauthorChecksPanel key={`${scope.projectId}:${scope.sessionId}`} scope={scope}
        isGenerating={Boolean(active)} onContinue={(check) => {
          const continuation = `继续查证清单 ${check.id}：${check.query}。先读取清单的当前进度和范围变化，沿未送达的原文范围继续核对；如版本或范围已变化，说明差异并准备新的完整清单。`;
          changeInput(inputRef.current.trim() ? `${inputRef.current}\n\n${continuation}` : continuation);
          setPanel(null); setTab("chat");
        }} /></section>}
      {panel === "changes" && <CoauthorChangesPanel scope={scope} initialChangeSetId={changeSetId} getDocument={() => draft.current.current}
        saveDraft={draft.save} isGenerating={() => Boolean(activeRef.current)} onCommitted={async (snapshot, linkedDraft) => {
          const updated = await refresh();
          if (mounted.current && linkedDraft) draft.acceptSaved(updated.document, snapshot);
          for (const queryKey of ["entities", "author-settings", "plan-nodes", "planning-sections", "chapters", "search", "manuscript"]) {
            void client.invalidateQueries({ queryKey: [queryKey] });
          }
        }} />}
      {recordsOpen && <section id="coauthor-section-content-sources" role="tabpanel" aria-labelledby="coauthor-section-sources" hidden={panel !== "sources"}>
        <CoauthorRunDirectory key={`${scope.projectId}:${scope.sessionId}`} scope={scope} selected={runId} messages={visible}
          refreshing={runQuery.isFetching} onRefresh={() => { if (runId) void runQuery.refetch(); }}
          onSelect={(id) => { setRunId(id); setRecordMessageId(null); setRecordTab("overview"); setSource(null); }} />
        {run && <p className="coauthor-run-status">{statuses[run.status]} · 基础稿件 v{run.documentVersion} · {run.id === state.runs[0]?.id ? "最近一轮" : "历史轮次"}</p>}
        <div className="coauthor-record-tabs" role="tablist" aria-label="运行记录分类">
          {([["overview", "本轮概览"], ["retrieval", "检索回执"], ["sources", "参考资料"], ["steps", "运行步骤"], ["proposal", "改稿建议"]] as const).map(([value, label]) =>
            <button key={value} id={`coauthor-record-tab-${value}`} role="tab" aria-selected={recordTab === value}
              aria-controls="coauthor-record-content" onClick={() => setRecordTab(value)}>{label}</button>)}
        </div>
        <section id="coauthor-record-content" className="coauthor-record-content" role="tabpanel" aria-labelledby={`coauthor-record-tab-${recordTab}`}>
        {recordTab === "overview" && <>
          {run && <CoauthorRunFeedback run={run} />}
          {!runId && recordReply && <p>此回复没有关联的运行记录，无法核实是否复核过；内容仍需对照原文确认。</p>}
          {(run?.output || recordReply) && <details><summary>{run && run.status !== "COMPLETED" ? "保留的回复（未完成）" : "保留的回复"}</summary>
            <pre>{splitLegacyRetrieval(run?.output || recordReply!.content).reply}</pre></details>}
          {recordReply && <button type="button" disabled={Boolean(active) || busy}
            title={active || busy ? "请先等待当前操作结束，或停止生成" : "将这条回复带入输入框，尚不发送"}
            onClick={() => reviewReply(recordReply)}><MessageSquareText size={14} />核对这条回复</button>}
        </>}
        {recordTab === "retrieval" && (receiptText
          ? <section className="coauthor-retrieval-record" aria-label="检索操作回执"><pre>{receiptText}</pre></section>
          : <p>没有可展示的检索回执，不能据此认定未检索、没有命中或已经查全。</p>)}
        {recordTab === "steps" && (run ? <ol className="coauthor-run-steps">{run.audit.map((raw, index) => <li key={index}>{coauthorStepLabel(raw)}</li>)}</ol>
          : <p>没有可核实的运行步骤。</p>)}
        {recordTab === "proposal" && <>
          <h3>{draft.document.title} · 当前工作稿 v{draft.document.version}</h3>
          {proposal && <>
            <div className="coauthor-diff"><section><h4>修改前 v{proposal.baseDocument.version}</h4><pre>{proposal.baseDocument.content}</pre></section>
              <section><h4>AI 建议稿</h4><textarea aria-label="AI 建议稿" readOnly value={proposal.document.content} onSelect={(event) => {
                setProposalSelection(event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd));
              }} /></section></div>
            <details><summary>对照当前工作稿</summary><pre className="coauthor-review-text">{draft.document.content}</pre></details>
            <button disabled={!canApply || busy || Boolean(active) || draft.conflict || Boolean(draft.backup)} onClick={() => void act(async () => {
              const snapshot = { ...draft.current.current };
              const saved = await applyCoauthorProposal({ scope, runId, expectedVersion: snapshot.version });
              if (mounted.current) { draft.acceptSaved(saved, snapshot); setProposalSelection(""); setNotice("已采用整份建议到工作稿，尚未正式采用。"); }
            })}>采用整份工作稿修改</button>
            <button disabled={busy || Boolean(active) || !runVerified || !proposalSelection || draft.conflict || Boolean(draft.backup)}
              title={proposalSelection ? (selection ? "替换工作稿选区，尚未正式采用" : "追加到工作稿末尾，尚未正式采用") : "请先在 AI 建议稿中选择文字"}
              onClick={() => {
                const current = draft.current.current;
                if (selection && current.content.split(selection).length !== 2) { setError("选区无法唯一定位，请重新选择。"); return; }
                draft.change({ content: selection ? current.content.replace(selection, proposalSelection) : `${current.content}${proposalSelection}` });
                setSelection(""); setProposalSelection(""); setNotice("仅采用选中文字到工作稿，相关规则与其余建议未自动采用。");
              }}>仅采用选中文字</button>
            <p className="coauthor-notice">{proposalSelection ? `已选 ${[...proposalSelection].length} 字，${selection ? "将替换工作稿选区" : "将追加到工作稿末尾"}。` : "尚未选择建议文字。"}</p>
            {!canApply && <p>整稿修改已过期或本轮未完成。当前稿件保留，可比较后仅采用所选文字。</p>}
          </>}
          {runVerified && !proposal && <p>此运行没有保存工作稿修改建议。</p>}
        </>}
        {run?.status === "RUNNING" && <button disabled={busy || !runVerified} onClick={() => void act(async () => {
          await cancelCoauthorRun({ scope, runId: run.id }); await refresh();
        })}>停止此运行</button>}
        {recordTab === "sources" && run?.audit.map((raw, index) => {
          const step = raw as { kind?: string; name?: string; result?: { coverage?: string; error?: string; sentChars?: number } };
          if (step.kind !== "initial_semantic_search" && step.name !== "search_semantic_sources") return null;
          return <details key={`semantic:${index}`}><summary>语义检索覆盖 · {index + 1}</summary>
            <p>{step.result?.coverage}</p>
            {step.result?.error && <p role="alert">语义检索无法核实：{step.result.error}</p>}
            {step.result?.sentChars !== undefined && <small>查询外发 {step.result.sentChars} 字符</small>}
          </details>;
        })}
        {recordTab === "sources" && !sourcesFor(run).length && <p>本轮没有保留可展示的参考资料，不代表没有相关内容。</p>}
        {recordTab === "sources" && sourcesFor(run).map((hit) => <article className="coauthor-source" key={`${hit.key}:${hit.revision}`}>
          <strong>{hit.title}</strong><small>{hit.kind} · {hit.semantic ? "语义相似候选 · " : ""}{hit.read ? (hit.knowledgeContext ? "已读取记录" : "已读取原文片段") : "检索命中"} · {hit.sent ? "已随请求发送" : "尚未随请求发送"}</small><p>{hit.content}</p>
          {hit.semantic && <small>来源文本字符 {hit.offset} 至 {hit.offset + [...hit.content].length}，不等于正文块内范围。</small>}
          <DecisionContext context={hit.decisionContext} />
          <CoauthorKnowledge key={`${scope.projectId}:${scope.sessionId}:${hit.key}:${hit.revision}`} scope={scope} source={hit}
            onRead={(key, revision) => void act(async () => { setSource(await readCoauthorSource({ scope, key, revision, offset: 0 })); })} />
          <button onClick={() => void act(async () => { setSource(await readCoauthorSource({ scope, key: hit.key, revision: hit.revision, offset: 0 })); })}>{hit.knowledgeContext ? "查看记录" : "查看原文"}</button>
          {hit.semantic && hit.offset > 0 && <button onClick={() => void act(async () => {
            setSource(await readCoauthorSource({ scope, key: hit.key, revision: hit.revision, offset: hit.offset }));
          })}>查看匹配段</button>}
        </article>)}
        {!runId && !recordReply && <p>当前没有选中的运行记录。</p>}
        {recordTab === "sources" && source && <section className="coauthor-source-text"><h3>{source.title}</h3><small>修订 {source.revision}</small><pre>{source.content}</pre>
          <DecisionContext context={source.decisionContext} />
          <CoauthorKnowledge key={`${scope.projectId}:${scope.sessionId}:${source.key}:${source.revision}`} scope={scope} source={source}
            onRead={(key, revision) => void act(async () => { setSource(await readCoauthorSource({ scope, key, revision, offset: 0 })); })} />
          {source.offset + [...source.content].length < source.totalChars && <button disabled={busy} onClick={() => void act(async () => {
            const next = await readCoauthorSource({ scope, key: source.key, revision: source.revision, offset: source.offset + [...source.content].length });
            if (mounted.current) setSource(next);
          })}>下一段</button>}</section>}
        </section>
      {runId && <>
        {runQuery.isPending && <p role="status">正在读取本次运行记录…</p>}
        {runQuery.error && <p role="alert" className="project-error">运行记录无法核实：{errorMessage(runQuery.error)}。不能据此认定回答没有问题。</p>}
        {run && !runVerified && <p role="status">以下为上次读取的运行记录，当前状态尚未核实。</p>}
      </>}
      </section>}
      {panel === "decisions" && <>
        <p>仅适用于当前讨论与分支，尚未改变正式设定。</p>
        {!state.decisions.length && <p>当前讨论尚无决定。</p>}
        {state.decisions.map((decision) => <article className="coauthor-source" key={decision.id}>
          <strong>{decision.topic}</strong><small>{statuses[decision.status]} · v{decision.version}</small><p>{decision.content}</p>
          <button onClick={() => setEditingDecision({ ...decision })}>纠正</button>
          <CoauthorDecisionHistory key={`${decision.id}:${decision.version}`} scope={scope} decision={decision} />
          <CoauthorDecisionConsumers scope={scope} decision={decision} onOpenChangeSet={(id) => { setChangeSetId(id); setPanel("changes"); }}
            onDiscussItem={(current, item) => {
              const continuation = `请核对决定 ${current.id}（目录读取时 v${current.version}）变化对方案 ${item.changeSetId}（v${item.changeSetVersion}）项目 ${item.itemId} 的影响，该项原依赖决定 v${item.decisionVersion}。`
                + "先用 get_change_plan 重新核对准确方案和项目，再用 read_change_item 分页读取所需前后快照、用 get_decisions 核对当前决定及必要历史。"
                + "历史快照不是当前正式原文；已采用项还需按实际目标重新读取当前原文。区分已知差异、推测与未核对范围，不因版本不同就认定矛盾。"
                + "本次只讨论核对，暂不修改稿件或正式内容，不自动重准备、采用或撤销。";
              changeInput(inputRef.current.trim() ? `${inputRef.current}\n\n${continuation}` : continuation);
              focusReview.current = true;
              setPanel(null); setTab("chat");
            }} />
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
      {panel === "history" && !history.length && <p>尚无已保存的历史版本。</p>}
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
    </WorkspacePanel>
  </div>;
}
