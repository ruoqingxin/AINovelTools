import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, BookmarkPlus, CheckCircle2, ChevronUp, Cpu, Lightbulb, MapPin, MessageSquareText, Plus, RefreshCw, Save, Send, Sparkles, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  askProjectDiscussion,
  createDiscussionCandidate,
  createDiscussionSession,
  dismissDiscussionCandidate,
  errorMessage,
  listDiscussionCandidates,
  listDiscussionMessages,
  listDiscussionSessions,
  listEvidenceAnchors,
  listModelProfiles,
  listPlanNodes,
  listPlanningSections,
  promoteDiscussionCandidate,
  promoteDiscussionCandidateToForeshadowingReview,
  type DiscussionCandidate,
  type DiscussionCandidateKind,
  type DiscussionMessage,
  type DiscussionScopeKind,
  type DiscussionTopicKind,
  DISCUSSION_LIMITS,
  getDiscussionWorkspace,
  saveDiscussionWorkspace,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";
import { planningSectionGroups } from "./story-planning-workbench";
import { DiscussionDesignPanel, discussionTopics } from "./discussion-design-panel";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

const planningOptions = planningSectionGroups.flatMap((group) => group.children);

const discussionStarters = [
  { label: "塑造一个角色", prompt: "我想设计一个角色。请先和我一起确定他的目标、矛盾和独特之处。", icon: UserRound },
  { label: "设计一件物品", prompt: "我想设计一件有独特能力的物品。请和我一起构思它的用途、限制与代价。", icon: Sparkles },
  { label: "构思一个地点", prompt: "我想构思一个让人印象深刻的地点。请和我一起探索它的氛围、规则和隐藏的秘密。", icon: MapPin },
  { label: "推敲一段剧情", prompt: "我想推敲一段剧情。请先帮我梳理人物动机、冲突和可能的转折。", icon: ArrowUpRight },
];

const candidateKindLabels: Record<DiscussionCandidateKind, string> = {
  NOTE: "临时笔记",
  PLANNING: "候选计划",
  SETTING: "候选设定",
  FORESHADOWING: "候选伏笔",
};

function messageLabel(message: DiscussionMessage) {
  return message.role === "USER" ? "作者" : "AI 协作者";
}

function candidateTarget(candidate: DiscussionCandidate) {
  if (candidate.kind === "FORESHADOWING" && candidate.status === "PROMOTED") {
    return "已送入事实审核";
  }
  if (!candidate.targetSectionId) return "未指定目标";
  return planningOptions.find((section) => section.id === candidate.targetSectionId)?.label
    ?? candidate.targetSectionId;
}

function discussionScopeLabel(kind: DiscussionScopeKind) {
  switch (kind) {
    case "PROJECT": return "全书";
    case "VOLUME": return "分卷";
    case "CHAPTER": return "章节";
    case "SCENE": return "场景";
    case "SELECTION": return "选区";
  }
}

export function DiscussionView() {
  const client = useQueryClient();
  const sessions = useQuery({ queryKey: ["discussion-sessions"], queryFn: listDiscussionSessions });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const anchors = useQuery({ queryKey: ["evidence-anchors"], queryFn: listEvidenceAnchors });
  const aiPreferences = useAiTaskPreferences();
  const profile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "workDesign");
  const preference = resolveTaskPreference(aiPreferences.data, "workDesign");
  const [sessionId, setSessionId] = useState<string | null>(() => window.location.hash.slice(1) || null);
  const [topicKind, setTopicKind] = useState<DiscussionTopicKind>("FREE");
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [scopeKind, setScopeKind] = useState<DiscussionScopeKind>("PROJECT");
  const [scopeId, setScopeId] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [sessionTitle, setSessionTitle] = useState("作品共创讨论");
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const message = sessionId ? composerDrafts[sessionId] ?? "" : "";
  const [olderMessages, setOlderMessages] = useState<DiscussionMessage[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [designPending, setDesignPending] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "draft">("chat");
  const [draftFocus, setDraftFocus] = useState<{ field: "chosen" | "alternatives" } | null>(null);
  const [candidateTargetId, setCandidateTargetId] = useState("seed-premise");
  const [candidateKinds, setCandidateKinds] = useState<Record<string, DiscussionCandidateKind>>({});
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, string>>({});
  const [reviewAnchorIds, setReviewAnchorIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingDefault = useRef(false);
  const initialSessionSelected = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const activeSession = sessions.data?.find((session) => session.id === sessionId) ?? null;
  const messages = useQuery({
    queryKey: ["discussion-messages", sessionId],
    queryFn: () => listDiscussionMessages(sessionId!),
    enabled: Boolean(sessionId),
  });
  const candidates = useQuery({
    queryKey: ["discussion-candidates", sessionId],
    queryFn: () => listDiscussionCandidates(sessionId!),
    enabled: Boolean(sessionId),
  });
  useUnsavedChangesGuard(Boolean(message.trim()), "讨论输入还有未发送的内容。");

  useEffect(() => {
    setOlderMessages([]);
    setHasMoreHistory(true);
    setLoadingHistory(false);
    autoScroll.current = true;
    if (!sessionId) return;
    try {
      const stored = localStorage.getItem(`discussion-composer:${sessionId}`);
      if (stored) setComposerDrafts((current) => sessionId in current ? current : { ...current, [sessionId]: stored });
    } catch { /* In-memory drafts remain available when browser storage is disabled. */ }
  }, [sessionId]);

  useEffect(() => {
    if (autoScroll.current && messages.data?.length && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages.data, sessionId, busy]);

  function setMessage(value: string) {
    if (!sessionId) return;
    setComposerDrafts((current) => ({ ...current, [sessionId]: value }));
    try {
      if (value) localStorage.setItem(`discussion-composer:${sessionId}`, value);
      else localStorage.removeItem(`discussion-composer:${sessionId}`);
    } catch { setError("输入仍保留在当前页面，但无法保存本地输入草稿，请暂时不要关闭页面。"); }
  }

  function selectSession(id: string | null) {
    if (designPending && !window.confirm("构思草稿仍有未保存内容，确定切换讨论吗？")) return;
    setSessionId(id);
    setDraftFocus(null);
    setMobileView("chat");
    window.history.replaceState(null, "", id ? `#${id}` : window.location.pathname);
  }

  async function loadEarlier() {
    const first = olderMessages[0] ?? messages.data?.[0];
    if (!first || !sessionId) return;
    setLoadingHistory(true);
    try {
      const page = await listDiscussionMessages(sessionId, DISCUSSION_LIMITS.pageSize, first.id);
      setOlderMessages((current) => [...page, ...current]);
      setHasMoreHistory(page.length === DISCUSSION_LIMITS.pageSize);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoadingHistory(false); }
  }

  async function rememberIdea(item: DiscussionMessage) {
    if (!sessionId || designPending) return;
    const selection = window.getSelection();
    const parent = selection?.anchorNode?.parentElement?.closest(".discussion-message");
    const content = parent?.getAttribute("data-message-id") === item.id
      && selection?.toString().trim() ? selection.toString().trim() : item.content;
    const field = item.role === "USER" ? "chosen" : "alternatives";
    setBusy(true);
    setError(null);
    try {
      const workspace = await getDiscussionWorkspace(sessionId);
      const draft = { ...workspace.draft, [field]: [workspace.draft[field], content].filter(Boolean).join("\n\n") };
      const next = await saveDiscussionWorkspace({ ...workspace, draft });
      client.setQueryData(["discussion-workspace", sessionId], next);
      await client.invalidateQueries({ queryKey: ["discussion-draft-revisions", sessionId] });
      setDraftFocus({ field });
      setMobileView("draft");
      setNotice(field === "chosen" ? "已记入选定内容。" : "已记入备选方向。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!sessions.isSuccess || sessions.data.length || creatingDefault.current) return;
    creatingDefault.current = true;
    void createDiscussionSession({
      title: "作品共创讨论",
      scopeKind: "PROJECT",
      scopeId: null,
      scopeText: null,
      topicKind: "FREE",
    }).then(async (session) => {
      setSessionId(session.id);
      window.history.replaceState(null, "", `#${session.id}`);
      setShowSessionForm(false);
      setDraftFocus(null);
      setMobileView("chat");
      await client.invalidateQueries({ queryKey: ["discussion-sessions"] });
    }).catch((cause) => {
      setError(errorMessage(cause));
    }).finally(() => {
      creatingDefault.current = false;
    });
  }, [client, sessions.data, sessions.isSuccess]);

  useEffect(() => {
    if (!sessions.isSuccess || !sessions.data.length || initialSessionSelected.current) return;
    initialSessionSelected.current = true;
    if (!sessions.data.some((session) => session.id === sessionId)) setSessionId(sessions.data[0].id);
  }, [sessionId, sessions.data]);

  const scopeNodeKind = scopeKind === "VOLUME"
    ? "VOLUME"
    : scopeKind === "SCENE"
      ? "SCENE"
      : scopeKind === "CHAPTER" || scopeKind === "SELECTION"
        ? "CHAPTER"
        : null;
  const scopeNodes = scopeNodeKind
    ? (nodes.data ?? []).filter((node) => node.kind === scopeNodeKind)
    : [];

  async function createSession() {
    if (busy || designPending) return;
    if (!sessionTitle.trim()) {
      setError("请填写讨论标题。");
      return;
    }
    if (scopeKind !== "PROJECT" && !scopeId) {
      setError("请选择讨论范围对应的分卷、章节或场景。");
      return;
    }
    if (scopeKind === "SELECTION" && !scopeText.trim()) {
      setError("请填写当前选区内容。");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await createDiscussionSession({
        title: sessionTitle.trim(),
        scopeKind,
        scopeId: scopeKind === "PROJECT" ? null : scopeId || null,
        scopeText: scopeKind === "SELECTION" ? scopeText.trim() : null,
        topicKind,
      });
      setSessionId(session.id);
      setDraftFocus(null);
      setMobileView("chat");
      window.history.replaceState(null, "", `#${session.id}`);
      setShowSessionForm(false);
      await client.invalidateQueries({ queryKey: ["discussion-sessions"] });
      setNotice("已建立新的讨论会话。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!sessionId || !profile?.hasSecret || !message.trim() || busy || designPending
      || Array.from(message).length > DISCUSSION_LIMITS.messageChars) return;
    autoScroll.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await askProjectDiscussion({
        sessionId,
        profileId: profile.id,
        message: message.trim(),
        ...(preference.temperature !== null ? { temperature: preference.temperature } : {}),
        ...(preference.maxOutputTokens !== null ? { maxOutputTokens: preference.maxOutputTokens } : {}),
      });
      setMessage("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["discussion-messages", sessionId] }),
        client.invalidateQueries({ queryKey: ["discussion-sessions"] }),
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveCandidate(messageItem: DiscussionMessage, kind: DiscussionCandidateKind) {
    if (!sessionId) return;
    const content = candidateDrafts[messageItem.id] ?? messageItem.content;
    if (!content.trim()) {
      setError("候选内容不能为空。");
      return;
    }
    const needsTarget = kind === "PLANNING" || kind === "SETTING";
    if (needsTarget && !candidateTargetId.trim()) {
      setError("请选择候选内容要写入的规划项。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createDiscussionCandidate({
        sessionId,
        messageId: messageItem.id,
        kind,
        content: content.trim(),
        ...(needsTarget ? { targetSectionId: candidateTargetId } : {}),
      });
      await client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] });
      setNotice(kind === "NOTE" ? "已保存为临时笔记。" : "已保存为候选内容，确认前不会进入规划。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function promote(candidate: DiscussionCandidate) {
    setBusy(true);
    setError(null);
    try {
      await promoteDiscussionCandidate({
        id: candidate.id,
        expectedStatus: candidate.status,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] }),
        client.invalidateQueries({ queryKey: ["planning-sections"] }),
      ]);
      setNotice("候选已写入规划待定区，仍需在规划工作台确认为正式设定。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function promoteForeshadowing(candidate: DiscussionCandidate) {
    const evidenceAnchorId = reviewAnchorIds[candidate.id];
    if (!evidenceAnchorId) {
      setError("请先选择这条伏笔候选对应的正文证据。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await promoteDiscussionCandidateToForeshadowingReview({
        id: candidate.id,
        expectedStatus: candidate.status,
        evidenceAnchorId,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] }),
        client.invalidateQueries({ queryKey: ["chapter-extractions"] }),
      ]);
      setNotice("候选伏笔已送入事实审核，请在左侧审核中心批准后才会成为正式伏笔。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(candidate: DiscussionCandidate) {
    setBusy(true);
    setError(null);
    try {
      await dismissDiscussionCandidate({
        id: candidate.id,
        expectedStatus: candidate.status,
      });
      await client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const visibleMessages = [...new Map([...olderMessages, ...(messages.data ?? [])]
    .map((item) => [item.id, item])).values()];
  return <div className="discussion-workspace" data-mobile-view={mobileView}>
    <div className="workspace-heading">
      <p className="eyebrow">作品共创</p>
      <h1>灵感共创</h1>
    </div>
    <div className="discussion-layout">
      <section className="discussion-sidebar" aria-label="讨论会话">
        <div className="discussion-session-toolbar">
          <label className="discussion-session-picker"><MessageSquareText size={16} /><span>当前讨论</span>
          <select value={sessionId ?? ""} onChange={(event) => selectSession(event.target.value || null)} aria-label="选择讨论会话" disabled={busy || loadingHistory}>
            {(sessions.data ?? []).map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
          </select>
          </label>
          <span className="discussion-session-count">{sessions.data?.length ?? 0} 个讨论</span>
          <button type="button" className="secondary-action discussion-create-toggle" onClick={() => {
            setShowSessionForm((current) => !current);
            setError(null);
          }}
            disabled={busy} aria-expanded={showSessionForm} aria-controls="discussion-session-form">
            {showSessionForm ? <X size={14} /> : <Plus size={14} />}{showSessionForm ? "取消新建" : "新建讨论"}
          </button>
        </div>
        {sessions.isError ? <p className="project-error" role="alert">{errorMessage(sessions.error)}
          <button type="button" className="secondary-action" onClick={() => void sessions.refetch()}>重试</button>
        </p> : null}
        {showSessionForm ? <section className="discussion-session-create" id="discussion-session-form">
          <div className="discussion-session-fields">
          <label><span>标题</span><input aria-label="标题" value={sessionTitle} maxLength={200} onChange={(event) => setSessionTitle(event.target.value)} /></label>
          <label><span>构思类型</span><select aria-label="构思类型" value={topicKind} onChange={(event) => setTopicKind(event.target.value as DiscussionTopicKind)}>
            {discussionTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.label}</option>)}
          </select></label>
          <label><span>范围</span><select aria-label="范围" value={scopeKind} onChange={(event) => { setScopeKind(event.target.value as DiscussionScopeKind); setScopeId(""); setScopeText(""); }}><option value="PROJECT">全书</option><option value="VOLUME">当前卷</option><option value="CHAPTER">当前章节</option><option value="SCENE">当前场景</option><option value="SELECTION">当前选区</option></select></label>
          {scopeKind !== "PROJECT" ? <label><span>{scopeKind === "VOLUME" ? "分卷" : scopeKind === "SCENE" ? "场景" : "章节"}</span><select value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="" disabled>请选择</option>{scopeNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label> : null}
          {scopeKind === "SELECTION" ? <label><span>选区内容</span><textarea rows={3} value={scopeText} onChange={(event) => setScopeText(event.target.value)} placeholder="粘贴当前选中的正文片段…" /></label> : null}
          <button type="button" className="secondary-action" onClick={() => void createSession()} disabled={busy || designPending || scopeKind !== "PROJECT" && (!scopeId || scopeKind === "SELECTION" && !scopeText.trim())}><Plus size={13} />建立会话</button>
          </div>
          {error ? <p className="project-error" role="alert">{error}</p> : null}
        </section> : null}
        {candidates.isError ? <p className="project-error" role="alert">{errorMessage(candidates.error)}</p> : null}
        {candidates.data?.length ? <details className="discussion-candidate-drawer">
          <summary>候选内容 <span>{candidates.data.length} 条</span></summary>
          <div className="discussion-candidate-list">
            {(candidates.data ?? []).map((candidate) => <article className="discussion-candidate" data-status={candidate.status.toLowerCase()} key={candidate.id}>
              <div><strong>{candidateKindLabels[candidate.kind]}</strong><small>{candidateTarget(candidate)}</small></div>
              <p>{candidate.content}</p>
              {candidate.status === "PENDING" ? <div className="discussion-candidate-actions">
                {candidate.kind === "PLANNING" || candidate.kind === "SETTING" ? <button type="button" className="primary-action" onClick={() => void promote(candidate)} disabled={busy}><CheckCircle2 size={12} />写入规划待定区</button> : null}
                {candidate.kind === "FORESHADOWING" ? <>
                  <label><span>正文证据</span><select aria-label={`选择${candidate.content}的正文证据`} value={reviewAnchorIds[candidate.id] ?? ""} onChange={(event) => setReviewAnchorIds((current) => ({ ...current, [candidate.id]: event.target.value }))}><option value="">选择证据锚点</option>{(anchors.data ?? []).map((anchor) => <option key={anchor.id} value={anchor.id}>{anchor.sourceVersion} · {anchor.blockId}</option>)}</select></label>
                  <button type="button" className="primary-action" onClick={() => void promoteForeshadowing(candidate)} disabled={busy || !reviewAnchorIds[candidate.id]}><CheckCircle2 size={12} />送入事实审核</button>
                </> : null}
                <button type="button" className="secondary-action destructive-action" onClick={() => void dismiss(candidate)} disabled={busy}><X size={12} />忽略</button>
              </div> : null}
            </article>)}
            {!candidates.data?.length ? <p className="plan-empty">从一条 AI 回复中保存笔记或候选内容。</p> : null}
          </div>
        </details> : null}
      </section>
      <div className="discussion-mobile-tabs" role="tablist" aria-label="共创视图">
        <button type="button" role="tab" aria-selected={mobileView === "chat"} onClick={() => setMobileView("chat")}>讨论</button>
        <button type="button" role="tab" aria-selected={mobileView === "draft"} onClick={() => setMobileView("draft")}>构思草稿</button>
      </div>
      <section className="discussion-thread" aria-label="讨论消息">
        <section className="discussion-thread-heading">
          <div><MessageSquareText size={17} /><div><strong>{activeSession?.title ?? "正在准备讨论"}</strong><span>{activeSession ? `${discussionScopeLabel(activeSession.scopeKind)} · ${visibleMessages.length} 条消息` : "会话加载中"}</span></div></div>
          <button type="button" className="secondary-action discussion-icon-button" aria-label="刷新讨论" title="刷新讨论"
            onClick={() => void Promise.all([messages.refetch(), sections.refetch()])} disabled={!sessionId || busy || messages.isFetching}><RefreshCw size={15} /></button>
        </section>
        <details className="discussion-model-details">
          <summary><Cpu size={13} /><span>{profile?.hasSecret ? profile.modelId : "模型未就绪"}</span><span>模型与费用</span></summary>
          <AiModelNote taskLabel="共创讨论" taskKey="workDesign" profile={profile} preference={preference} />
        </details>
        {notice ? <p className="project-notice" role="status">{notice}</p> : null}
        {error && !showSessionForm ? <p className="project-error" role="alert">{error}</p> : null}
        <div className="discussion-messages" ref={messagesRef} aria-busy={busy || messages.isFetching}
          onScroll={(event) => {
            const element = event.currentTarget;
            autoScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
          }}>
          {(messages.data?.length === DISCUSSION_LIMITS.pageSize || olderMessages.length > 0) && hasMoreHistory
            ? <button type="button" className="secondary-action discussion-load-earlier" disabled={loadingHistory}
              onClick={() => void loadEarlier()}><ChevronUp size={13} />{loadingHistory ? "加载中…" : "更早讨论"}</button> : null}
          {messages.isError ? <p className="project-error" role="alert">{errorMessage(messages.error)}</p> : null}
          {messages.isPending && sessionId ? <p className="plan-empty">正在加载讨论…</p> : visibleMessages.map((messageItem) => <article className="discussion-message" data-role={messageItem.role.toLowerCase()} data-message-id={messageItem.id} key={messageItem.id}>
            <header><strong>{messageLabel(messageItem)}</strong><small>{messageItem.contextVersion ? `上下文 ${messageItem.contextVersion.slice(0, 8)}` : "未绑定生成上下文"}</small></header>
            <div className="discussion-message-content">{messageItem.content}</div>
            <button type="button" className="secondary-action discussion-remember" title="选中消息片段时只记录选中的内容"
              disabled={busy || designPending} onClick={() => void rememberIdea(messageItem)}>
              <BookmarkPlus size={12} />{messageItem.role === "USER" ? "记入选定内容" : "记入备选方向"}
            </button>
            {messageItem.role === "ASSISTANT" ? (() => {
              const selectedKind = candidateKinds[messageItem.id] ?? "SETTING";
              const needsTarget = selectedKind === "PLANNING" || selectedKind === "SETTING";
              return <details className="discussion-message-actions"><summary>保存片段为候选</summary>
                <textarea rows={3} value={candidateDrafts[messageItem.id] ?? messageItem.content} onChange={(event) => setCandidateDrafts((current) => ({ ...current, [messageItem.id]: event.target.value }))} aria-label="转为候选时使用的内容" />
                <div>
                  <label><span>保存类型</span><select value={selectedKind} onChange={(event) => setCandidateKinds((current) => ({ ...current, [messageItem.id]: event.target.value as DiscussionCandidateKind }))}><option value="NOTE">{candidateKindLabels.NOTE}</option><option value="PLANNING">{candidateKindLabels.PLANNING}</option><option value="SETTING">{candidateKindLabels.SETTING}</option><option value="FORESHADOWING">{candidateKindLabels.FORESHADOWING}</option></select></label>
                  {needsTarget ? <label><span>目标规划项</span><select value={candidateTargetId} onChange={(event) => setCandidateTargetId(event.target.value)}>{planningOptions.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select></label> : null}
                  <button type="button" className="primary-action" onClick={() => void saveCandidate(messageItem, selectedKind)} disabled={busy}><Save size={12} />保存候选</button>
                </div>
              </details>;
            })() : null}
          </article>)}
          {!messages.isPending && !messages.isError && !visibleMessages.length ? <div className="discussion-empty">
            <Lightbulb size={28} strokeWidth={1.5} />
            <h2>这次想构思什么？</h2>
            <div className="discussion-starters">
              {discussionStarters.map(({ label, prompt, icon: Icon }) => <button key={label} type="button"
                disabled={!sessionId || busy} onClick={() => {
                  setMessage(message.trim() ? `${message}\n\n${prompt}` : prompt);
                  composerRef.current?.focus();
                }}><Icon size={17} /><span>{label}</span><ArrowUpRight size={14} /></button>)}
            </div>
          </div> : null}
          {busy ? <p className="discussion-processing" role="status"><span />正在处理…</p> : null}
        </div>
        <section className="discussion-composer">
          <textarea ref={composerRef} rows={3} value={message} onChange={(event) => setMessage(event.target.value)} aria-label="讨论内容"
            placeholder="一个灵感、一个疑问，或一段想推敲的剧情…" disabled={!sessionId || busy}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }} />
          <div><span>{Array.from(message).length.toLocaleString()} / 20,000 字</span><button type="button" className="primary-action" onClick={() => void send()} disabled={!sessionId || !profile?.hasSecret || !message.trim() || busy || designPending || Array.from(message).length > DISCUSSION_LIMITS.messageChars}><Send size={14} />{busy ? "处理中…" : "发送讨论"}</button></div>
          {designPending ? <p className="discussion-composer-status" role="status">构思草稿尚未保存或正在处理，暂不能发送。</p> : null}
        </section>
        {!profile?.hasSecret ? <p className="project-error" role="alert">请先在设置中配置可用的作品设定模型。</p> : null}
      </section>
      {sessionId ? <DiscussionDesignPanel key={sessionId} sessionId={sessionId} profile={profile}
        preference={preference} hasDiscussion={visibleMessages.length > 0} conversationBusy={busy}
        draftFocus={draftFocus} onPendingChange={setDesignPending} /> : null}
    </div>
  </div>;
}
