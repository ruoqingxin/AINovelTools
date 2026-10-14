import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, BookmarkPlus, CheckCircle2, ChevronUp, Cpu, Lightbulb, MapPin, MessageSquareText, Plus, RefreshCw, Save, Send, Sparkles, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  askProjectDiscussion,
  createDiscussionCandidate,
  createDiscussionSession,
  createPlanNode,
  dismissDiscussionCandidate,
  errorMessage,
  getProjectAiTaskOverrides,
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
import { discussionSourceHref, planningTargetHref } from "../lib/discussion-source";
import "./discussion-source.css";
import { WorkspacePanel, useWideWorkspace } from "./workspace-panel";
import "./discussion-workspace.css";
import { sourceReturnTo } from "../lib/manuscript-source";
import { useConfirmAction } from "../shell/confirm-action-provider";

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

function candidateTarget(candidate: DiscussionCandidate, nodeTitles: Map<string, string>) {
  if (candidate.kind === "FORESHADOWING" && candidate.status === "PROMOTED") {
    return "已送入伏笔提取审核";
  }
  if (!candidate.targetSectionId) return "未指定目标";
  return planningOptions.find((section) => section.id === candidate.targetSectionId)?.label
    ?? nodeTitles.get(candidate.targetSectionId)
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
  const confirmAction = useConfirmAction();
  const sessionOperation = useRef(false);
  const collectorClosing = useRef(false);
  const editEpoch = useRef(0);
  const targetParams = new URLSearchParams(window.location.search);
  const targetSession = targetParams.get("targetSession");
  const targetProject = targetParams.get("targetProject");
  const returnTo = sourceReturnTo(targetParams.get("returnTo"));
  const sessions = useQuery({ queryKey: ["discussion-sessions"], queryFn: listDiscussionSessions });
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const sections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const anchors = useQuery({ queryKey: ["evidence-anchors"], queryFn: listEvidenceAnchors });
  const aiPreferences = useAiTaskPreferences();
  const projectOverrides = useQuery({ queryKey: ["project-ai-task-overrides"], queryFn: getProjectAiTaskOverrides });
  const effectivePreferences = aiPreferences.data ? {
    ...aiPreferences.data,
    discussion: projectOverrides.data?.discussion ?? resolveTaskPreference(aiPreferences.data, "discussion"),
    discussionDesign: projectOverrides.data?.discussionDesign ?? resolveTaskPreference(aiPreferences.data, "discussionDesign"),
  } : undefined;
  const profile = resolveTaskChatProfile(profiles.data, effectivePreferences, "discussion");
  const preference = resolveTaskPreference(effectivePreferences, "discussion");
  const designProfile = resolveTaskChatProfile(profiles.data, effectivePreferences, "discussionDesign");
  const designPreference = resolveTaskPreference(effectivePreferences, "discussionDesign");
  const [sessionId, setSessionId] = useState<string | null>(() => targetSession ?? (window.location.hash.slice(1) || null));
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
  const [showDraft, setShowDraft] = useState(() => new URLSearchParams(window.location.search).get("design") === "results");
  const [showSessions, setShowSessions] = useState(false);
  const wide = useWideWorkspace(1100);
  const [draftFocus, setDraftFocus] = useState<{ field: "chosen" | "alternatives" | "questions" } | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectionTargets, setCollectionTargets] = useState<Record<string, string>>({});
  const collectedSources = useRef(new Set<string>());
  const [candidateTargetId, setCandidateTargetId] = useState("seed-tone");
  const [writingChapterId, setWritingChapterId] = useState("");
  const [writingDestination, setWritingDestination] = useState<string | null>(null);
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, string>>({});
  const latestCandidateDrafts = useRef(candidateDrafts);
  latestCandidateDrafts.current = candidateDrafts;
  const collectionTrigger = useRef<HTMLButtonElement | null>(null);
  const draftReturnFocus = useRef<HTMLElement | null>(null);
  const [reviewAnchorIds, setReviewAnchorIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [planningDestination, setPlanningDestination] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingDefault = useRef(false);
  const initialSessionSelected = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const activeSession = sessions.data?.find((session) => session.id === sessionId) ?? null;
  const invalidTarget = targetSession !== null && sessions.isSuccess
    && (!sessions.data.some((session) => session.id === targetSession && (!targetProject || session.projectId === targetProject)));
  const nodeTargets = (nodes.data ?? []).filter((node) => !node.archived && ["OUTLINE", "VOLUME", "CHAPTER", "SCENE"].includes(node.kind))
    .map((node) => ({ id: `plan-node:${node.id}`, label: `${node.kind === "CHAPTER" ? "章节执行卡" : node.kind === "VOLUME" ? "分卷规划" : node.kind === "SCENE" ? "场景执行卡" : "故事大纲"} · ${node.title}` }));
  const targetOptions = [...planningOptions, ...nodeTargets];
  const nodeTitles = new Map(nodeTargets.map((node) => [node.id, node.label]));
  const targetKind = (id: string | null) => (nodes.data ?? []).find((node) => `plan-node:${node.id}` === id)?.kind;
  const writingChapters = (nodes.data ?? []).filter((node) => !node.archived && node.kind === "CHAPTER");
  const chosenChapterId = writingChapterId || (activeSession?.scopeKind === "CHAPTER"
    && writingChapters.some((node) => node.id === activeSession.scopeId) ? activeSession.scopeId : "")
    || writingChapters[0]?.id || "";
  const messages = useQuery({
    queryKey: ["discussion-messages", sessionId],
    queryFn: () => listDiscussionMessages(sessionId!),
    enabled: Boolean(sessionId) && !invalidTarget,
  });
  const candidates = useQuery({
    queryKey: ["discussion-candidates", sessionId],
    queryFn: () => listDiscussionCandidates(sessionId!),
    enabled: Boolean(sessionId) && !invalidTarget,
  });
  const candidateEditsPending = Object.keys(candidateDrafts).length > 0;
  const latest = useRef<{ sessionId: string | null; candidateDrafts: typeof candidateDrafts; designPending: boolean;
    busy: boolean; creatingSession: boolean; collectingId: string | null; sessionTitle: string;
    scopeKind: DiscussionScopeKind; scopeId: string; scopeText: string; topicKind: DiscussionTopicKind } | null>(null);
  latest.current = { sessionId, candidateDrafts, designPending, busy, creatingSession, collectingId,
    sessionTitle, scopeKind, scopeId, scopeText, topicKind };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useUnsavedChangesGuard(Boolean(message.trim()) || candidateEditsPending || busy, "讨论还有未发送输入、未保存候选或正在处理的操作。");

  useEffect(() => {
    setOlderMessages([]);
    setHasMoreHistory(true);
    setLoadingHistory(false);
    autoScroll.current = true;
    setPlanningDestination(null);
    setWritingDestination(null);
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

  function unchangedSession(expected: NonNullable<typeof latest.current>, epoch: number) {
    const current = latest.current;
    if (!mounted.current || !current || current.sessionId !== expected.sessionId || current.busy || current.creatingSession) return false;
    if (current.candidateDrafts !== expected.candidateDrafts || current.designPending !== expected.designPending || editEpoch.current !== epoch) {
      setError("确认期间讨论内容已变化，已保留当前编辑。请重新确认。"); return false;
    }
    return true;
  }

  async function selectSession(id: string | null) {
    if (id === sessionId || busy || sessionOperation.current || !latest.current) return;
    const expected = latest.current, epoch = editEpoch.current;
    sessionOperation.current = true;
    try {
      if ((designPending || candidateEditsPending) && !await confirmAction({ message: "讨论仍有未保存草稿或候选，确定切换讨论吗？",
        confirmLabel: "放弃修改并切换" })) return;
      if (!unchangedSession(expected, epoch)) return;
      setCandidateDrafts({});
      setSessionId(id);
      setDraftFocus(null);
      setShowDraft(false);
      setCollectingId(null);
      window.history.replaceState(null, "", id ? `#${id}` : window.location.pathname);
    } finally { sessionOperation.current = false; }
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

  function openCollector(item: DiscussionMessage, trigger: HTMLButtonElement) {
    if (creatingSession) return;
    collectionTrigger.current = trigger;
    const selection = window.getSelection();
    const parent = selection?.anchorNode?.parentElement?.closest(".discussion-message");
    const content = parent?.getAttribute("data-message-id") === item.id
      && selection?.toString().trim() ? selection.toString().trim() : item.content;
    if (content !== item.content) setCandidateDrafts((current) => ({ ...current, [item.id]: current[item.id] ?? content }));
    setCollectingId(item.id);
  }
  async function closeCollector(item: DiscussionMessage) {
    const current = latest.current;
    if (!current || current.busy || current.creatingSession || collectorClosing.current) return;
    const expectedDraft = current.candidateDrafts[item.id];
    const expectedSession = current.sessionId;
    collectorClosing.current = true;
    try {
      if (expectedDraft !== undefined && expectedDraft !== item.content
        && !await confirmAction({ message: "放弃尚未收集的片段修改吗？", confirmLabel: "放弃片段修改" })) return;
      const fresh = latest.current;
      if (!mounted.current || !fresh || fresh.busy || fresh.creatingSession || fresh.sessionId !== expectedSession || fresh.collectingId !== item.id) return;
      if (fresh.candidateDrafts[item.id] !== expectedDraft) {
        setError("确认期间片段已变化，已保留当前内容。请重新确认。"); return;
      }
      setCollectingId(null);
      setCandidateDrafts((drafts) => { const next = { ...drafts }; delete next[item.id]; return next; });
    } finally { collectorClosing.current = false; }
  }
  function finishCollection(item: DiscussionMessage, content: string) {
    if ((latestCandidateDrafts.current[item.id] ?? item.content) !== content) return;
    setCandidateDrafts((current) => { const next = { ...current }; delete next[item.id]; return next; });
    setCollectingId((current) => current === item.id ? null : current);
    collectionTrigger.current?.focus();
  }
  async function collectIntoDraft(item: DiscussionMessage, field: "chosen" | "alternatives" | "questions") {
    if (!sessionId || busy || designPending) return;
    const content = candidateDrafts[item.id] ?? item.content;
    if (!content.trim()) return;
    setBusy(true);
    setError(null);
    const sourceKey = JSON.stringify([sessionId, item.id, field, content]);
    try {
      const workspace = await getDiscussionWorkspace(sessionId);
      const draft = { ...workspace.draft, [field]: [workspace.draft[field], content].filter(Boolean).join("\n\n") };
      if (Array.from(Object.values(draft).join("")).length > DISCUSSION_LIMITS.draftChars) throw new Error("构思草稿合计最多 50000 字，请拆成多个讨论。");
      // Keep a message-linked source even if the subsequent workspace CAS fails.
      if (!collectedSources.current.has(sourceKey)) {
        await createDiscussionCandidate({ sessionId, messageId: item.id, kind: "NOTE", content: content.trim() });
        collectedSources.current.add(sourceKey);
        await client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] });
      }
      const next = await saveDiscussionWorkspace({ ...workspace, draft });
      client.setQueryData(["discussion-workspace", sessionId], next);
      await client.invalidateQueries({ queryKey: ["discussion-draft-revisions", sessionId] });
      setDraftFocus({ field });
      draftReturnFocus.current = collectionTrigger.current;
      setShowDraft(true);
      finishCollection(item, content);
      setNotice(`已收集到${field === "chosen" ? "已选定内容" : field === "alternatives" ? "备选方向" : "未决问题"}，讨论来源已保留。`);
    } catch (cause) { setError(`${errorMessage(cause)}${collectedSources.current.has(sourceKey) ? " 片段来源已保留在收集记录中，草稿未写入；可重试，不会重复保存来源。" : ""}`); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (targetSession !== null || !sessions.isSuccess || sessions.data.length || creatingDefault.current) return;
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
      setShowSessions(false);
      setDraftFocus(null);
      setShowDraft(false);
      await client.invalidateQueries({ queryKey: ["discussion-sessions"] });
    }).catch((cause) => {
      setError(errorMessage(cause));
    }).finally(() => {
      creatingDefault.current = false;
    });
  }, [client, sessions.data, sessions.isSuccess, targetSession]);

  useEffect(() => {
    if (targetSession !== null || !sessions.isSuccess || !sessions.data.length || initialSessionSelected.current) return;
    initialSessionSelected.current = true;
    if (!sessions.data.some((session) => session.id === sessionId)) setSessionId(sessions.data[0].id);
  }, [sessionId, sessions.data, targetSession]);

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
    if (busy || designPending || sessionOperation.current || !latest.current) return;
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
    const expected = latest.current, epoch = editEpoch.current;
    sessionOperation.current = true;
    try {
      if (candidateEditsPending && !await confirmAction({ message: "候选仍有未保存修改，确定放弃并建立新讨论吗？",
        confirmLabel: "放弃修改并新建" })) return;
      if (!unchangedSession(expected, epoch)) return;
      await submitSession();
    } finally { sessionOperation.current = false; }
  }

  async function submitSession() {
    setBusy(true);
    setCreatingSession(true);
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
      setCandidateDrafts({});
      setSessionId(session.id);
      setDraftFocus(null);
      setShowDraft(false);
      setCollectingId(null);
      window.history.replaceState(null, "", `#${session.id}`);
      setShowSessionForm(false);
      setShowSessions(false);
      await client.invalidateQueries({ queryKey: ["discussion-sessions"] });
      setNotice("已建立新的讨论会话。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreatingSession(false);
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
    if (!sessionId || busy) return;
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
      finishCollection(messageItem, content);
      await client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] });
      setNotice(kind === "NOTE" ? "已保存为临时笔记。" : "已保存为候选内容，确认前不会进入规划。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function useFragment(messageItem: DiscussionMessage, destination: string) {
    if (!sessionId || !activeSession || busy || designPending) return;
    const content = candidateDrafts[messageItem.id] ?? messageItem.content;
    if (!content.trim()) return;
    const chapter = writingChapters.find((node) => node.id === chosenChapterId);
    if (destination === "CHAPTER_WRITING" && !chapter) {
      setError("请选择要写的章节。");
      return;
    }
    setBusy(true);
    setError(null);
    setPlanningDestination(null);
    setWritingDestination(null);
    try {
      let targetSectionId = "seed-tone";
      if (destination === "STORY_DIRECTION") {
        const outline = (nodes.data ?? []).find((node) => node.kind === "OUTLINE" && !node.archived)
          ?? await createPlanNode({ kind: "OUTLINE", title: "故事方向" });
        targetSectionId = `plan-node:${outline.id}`;
        await client.invalidateQueries({ queryKey: ["plan-nodes"] });
      } else if (chapter && destination === "CHAPTER_WRITING") {
        targetSectionId = `plan-node:${chapter.id}`;
      } else if (destination === "BOOK_PREFERENCES"
        && !(nodes.data ?? []).some((node) => node.kind === "WORK_DESIGN" && !node.archived)) {
        await createPlanNode({ kind: "WORK_DESIGN", title: "本书偏好" });
        await client.invalidateQueries({ queryKey: ["plan-nodes"] });
      }
      const candidate = await createDiscussionCandidate({
        sessionId, messageId: messageItem.id,
        kind: destination === "CHAPTER_WRITING" ? "NOTE" : destination === "BOOK_PREFERENCES" ? "SETTING" : "PLANNING",
        content: content.trim(), targetSectionId,
      });
      // Save a source-linked note, not a chapter plan or a formal project fact.
      if (destination === "CHAPTER_WRITING" && chapter) {
        const params = new URLSearchParams({
          planNode: chapter.id, targetProject: activeSession.projectId, assistant: "ai", writingCandidate: candidate.id,
          returnTo: `/discussion#${sessionId}`,
        });
        setWritingDestination(`/writing?${params}`);
        setNotice("片段已保留，将作为本章写作要求，不会改动章节计划或正文。");
      } else {
        const promoted = await promoteDiscussionCandidate({ id: candidate.id, expectedStatus: candidate.status });
        setPlanningDestination(planningTargetHref(targetSectionId, activeSession.projectId,
          destination === "STORY_DIRECTION" ? "OUTLINE" : undefined));
        setNotice(promoted.status === "PROMOTED" ? "片段已送入待采用区，当前笔记和正式设定未改变。" : "片段已保留。");
        await client.invalidateQueries({ queryKey: ["planning-sections"] });
        await client.invalidateQueries({ queryKey: ["planning-discussion-sources"] });
      }
      finishCollection(messageItem, content);
    } catch (cause) { setError(errorMessage(cause)); }
    finally {
      await client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] });
      setBusy(false);
    }
  }

  async function promote(candidate: DiscussionCandidate) {
    setBusy(true);
    setError(null);
    try {
      const promoted = await promoteDiscussionCandidate({
        id: candidate.id,
        expectedStatus: candidate.status,
      });
      if (promoted.targetSectionId) setPlanningDestination(planningTargetHref(promoted.targetSectionId, activeSession?.projectId, targetKind(promoted.targetSectionId)));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["discussion-candidates", sessionId] }),
        client.invalidateQueries({ queryKey: ["planning-sections"] }),
        client.invalidateQueries({ queryKey: ["planning-discussion-sources"] }),
        client.invalidateQueries({ queryKey: ["discussion-source"] }),
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
      setNotice("候选伏笔已送入本章提取候选，作者采用后才会生成正式伏笔。");
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
  if (invalidTarget) return <section className="discussion-workspace"><p className="project-error" role="alert">目标讨论已不可用或不属于当前作品，未打开其他讨论。</p><a href="/review">返回待办</a></section>;
  return <div className="discussion-workspace discussion-stage-three" data-draft-open={showDraft && wide}>
    {returnTo ? <a className="activity-return" href={returnTo}>返回来源</a> : null}
    <div className="workspace-heading">
      <h1>构思</h1>
      <div className="library-actions">
        <button type="button" className="secondary-action" onClick={() => setShowSessions(true)}><MessageSquareText size={15} />讨论列表</button>
        <button type="button" className="secondary-action" disabled={busy} onClick={() => {
          setShowSessionForm((current) => !current); setShowSessions(true); setError(null);
        }}><Plus size={15} />新建讨论</button>
        <button type="button" className="secondary-action" aria-expanded={showDraft} onClick={(event) => {
          draftReturnFocus.current = event.currentTarget; setShowDraft((current) => !current);
        }}><BookmarkPlus size={15} />构思草稿</button>
      </div>
    </div>
    <div className="discussion-layout" onChangeCapture={() => { editEpoch.current += 1; }}>
      <WorkspacePanel open={showSessions} title="讨论与收集" onClose={() => setShowSessions(false)}>
      <section className="discussion-sidebar" aria-label="讨论会话">
        <div className="discussion-session-toolbar">
          <label className="discussion-session-picker"><MessageSquareText size={16} /><span>当前讨论</span>
          <select value={sessionId ?? ""} onChange={(event) => selectSession(event.target.value || null)} aria-label="选择讨论会话" disabled={busy || loadingHistory}>
            {(sessions.data ?? []).map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
          </select>
          </label>
          <span className="discussion-session-count">{sessions.data?.length ?? 0} 个讨论</span>
          {showSessionForm ? <button type="button" className="secondary-action" disabled={busy} onClick={() => setShowSessionForm(false)}><X size={14} />取消新建</button> : null}
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
        {notice && showSessions ? <p className="project-notice" role="status">{notice}{planningDestination ? <a href={planningDestination}>打开待采用内容</a> : null}
          {writingDestination ? <a href={writingDestination}>打开本章写作</a> : null}</p> : null}
        {error && showSessions && !showSessionForm ? <p className="project-error" role="alert">{error}</p> : null}
        {candidates.data?.length ? <details className="discussion-candidate-drawer">
          <summary>收集记录 <span>{candidates.data.length} 条</span></summary>
          <div className="discussion-candidate-list">
            {(candidates.data ?? []).map((candidate) => <article className="discussion-candidate" data-status={candidate.status.toLowerCase()} key={candidate.id}>
              <div><strong>{candidateKindLabels[candidate.kind]}</strong><small>{candidateTarget(candidate, nodeTitles)}</small></div>
              <p>{candidate.content}</p>
              <div className="discussion-candidate-links">
                <a href={discussionSourceHref({ candidateId: candidate.id, sessionId: candidate.sessionId, projectId: activeSession?.projectId },
                  `/discussion#${encodeURIComponent(candidate.sessionId)}`)}><MessageSquareText size={12} />查看讨论来源</a>
                {activeSession && candidate.kind === "NOTE" && candidate.status !== "DISMISSED" && targetKind(candidate.targetSectionId) === "CHAPTER"
                  ? <a href={`/writing?${new URLSearchParams({
                    planNode: candidate.targetSectionId!.slice("plan-node:".length),
                    targetProject: activeSession.projectId, assistant: "ai", writingCandidate: candidate.id,
                    returnTo: `/discussion#${candidate.sessionId}`,
                  })}`}><ArrowUpRight size={12} />打开本章写作</a> : null}
                {candidate.status === "PROMOTED" && (candidate.kind === "PLANNING" || candidate.kind === "SETTING")
                  && candidate.targetSectionId && candidate.promotedObjectId === candidate.targetSectionId ? <a
                    href={planningTargetHref(candidate.targetSectionId, activeSession?.projectId, targetKind(candidate.targetSectionId))}><ArrowUpRight size={12} />打开规划待定区</a> : null}
              </div>
              {candidate.status === "PENDING" ? <div className="discussion-candidate-actions">
                {candidate.kind === "PLANNING" || candidate.kind === "SETTING" ? <button type="button" className="primary-action" onClick={() => void promote(candidate)} disabled={busy}><CheckCircle2 size={12} />写入规划待定区</button> : null}
                {candidate.kind === "FORESHADOWING" ? <>
                  <label><span>正文证据</span><select aria-label={`选择${candidate.content}的正文证据`} value={reviewAnchorIds[candidate.id] ?? ""} onChange={(event) => setReviewAnchorIds((current) => ({ ...current, [candidate.id]: event.target.value }))}><option value="">选择证据锚点</option>{(anchors.data ?? []).map((anchor) => <option key={anchor.id} value={anchor.id}>{anchor.sourceVersion} · {anchor.blockId}</option>)}</select></label>
                  <button type="button" className="primary-action" onClick={() => void promoteForeshadowing(candidate)} disabled={busy || !reviewAnchorIds[candidate.id]}><CheckCircle2 size={12} />送入伏笔提取审核</button>
                </> : null}
                <button type="button" className="secondary-action destructive-action" onClick={() => void dismiss(candidate)} disabled={busy}><X size={12} />忽略</button>
              </div> : null}
            </article>)}
            {!candidates.data?.length ? <p className="plan-empty">从一条 AI 回复中保存笔记或候选内容。</p> : null}
          </div>
        </details> : null}
      </section>
      </WorkspacePanel>
      <section className="discussion-thread" aria-label="讨论消息">
        <section className="discussion-thread-heading">
          <div><MessageSquareText size={17} /><div><strong>{activeSession?.title ?? "正在准备讨论"}</strong><span>{activeSession ? `${discussionScopeLabel(activeSession.scopeKind)} · ${visibleMessages.length} 条消息` : "会话加载中"}</span></div></div>
          <button type="button" className="secondary-action discussion-icon-button" aria-label="刷新讨论" title="刷新讨论"
            onClick={() => void Promise.all([messages.refetch(), sections.refetch()])} disabled={!sessionId || busy || messages.isFetching}><RefreshCw size={15} /></button>
        </section>
        <details className="discussion-model-details">
          <summary><Cpu size={13} /><span>{profile?.hasSecret ? profile.modelId : "模型未就绪"}</span><span>模型与费用</span></summary>
          <AiModelNote taskLabel="共创讨论" taskKey="discussion" settingsScope={projectOverrides.data?.discussion ? "PROJECT" : "GLOBAL"} profile={profile} preference={preference} />
        </details>
        {notice && !showSessions ? <p className="project-notice" role="status">{notice}
          {planningDestination ? <a className="discussion-notice-link" href={planningDestination}><ArrowUpRight size={14} />打开待采用内容</a> : null}
          {writingDestination ? <a className="discussion-notice-link" href={writingDestination}><ArrowUpRight size={14} />打开本章写作</a> : null}</p> : null}
        {error && !showSessions ? <p className="project-error" role="alert">{error}</p> : null}
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
            <button type="button" className="secondary-action discussion-remember" title="收集当前消息或选中的片段" aria-expanded={collectingId === messageItem.id}
              disabled={busy || designPending} onClick={(event) => openCollector(messageItem, event.currentTarget)}>
              <BookmarkPlus size={12} />收集片段
            </button>
            {collectingId === messageItem.id ? (() => {
              const selectedKind = collectionTargets[messageItem.id] ?? "";
              const needsTarget = selectedKind === "PLANNING" || selectedKind === "SETTING";
              return <WorkspacePanel open title="收集片段" className="discussion-collector" onClose={() => void closeCollector(messageItem)}><section className="discussion-message-actions">
                <textarea rows={3} value={candidateDrafts[messageItem.id] ?? messageItem.content} onChange={(event) => {
                  const value = event.target.value;
                  setCandidateDrafts((current) => {
                    const next = { ...current };
                    if (value === messageItem.content) delete next[messageItem.id];
                    else next[messageItem.id] = value;
                    return next;
                  });
                }} disabled={creatingSession} aria-label="收集内容" />
                <div>
                  <label><span>收集到</span><select aria-label="收集到" value={selectedKind} disabled={busy} onChange={(event) => setCollectionTargets((current) => ({ ...current, [messageItem.id]: event.target.value }))}>
                    <option value="">选择去向</option>
                    <optgroup label="构思笔记"><option value="chosen">已选定内容</option><option value="alternatives">备选方向</option><option value="questions">未决问题</option></optgroup>
                    <optgroup label="用于创作"><option value="BOOK_PREFERENCES">记为本书偏好</option><option value="STORY_DIRECTION">记入故事方向</option><option value="CHAPTER_WRITING">用于本章</option></optgroup>
                    <optgroup label="高级候选"><option value="NOTE">{candidateKindLabels.NOTE}</option><option value="PLANNING">{candidateKindLabels.PLANNING}</option><option value="SETTING">{candidateKindLabels.SETTING}</option><option value="FORESHADOWING">{candidateKindLabels.FORESHADOWING}</option></optgroup></select></label>
                  {selectedKind === "CHAPTER_WRITING" ? <label><span>章节</span>
                    <select aria-label="片段目标章节" value={chosenChapterId} disabled={busy} onChange={(event) => setWritingChapterId(event.target.value)}>
                      {!writingChapters.length ? <option value="">尚无章节</option> : null}
                      {writingChapters.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
                    </select></label> : null}
                  {needsTarget ? <label><span>目标规划项</span><select aria-label="目标规划项" value={candidateTargetId} disabled={busy} onChange={(event) => setCandidateTargetId(event.target.value)}>{targetOptions.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select></label> : null}
                  <div className="discussion-collector-commands"><button type="button" className="primary-action" onClick={() => {
                    if (selectedKind === "chosen" || selectedKind === "alternatives" || selectedKind === "questions") void collectIntoDraft(messageItem, selectedKind);
                    else if (["BOOK_PREFERENCES", "STORY_DIRECTION", "CHAPTER_WRITING"].includes(selectedKind)) void useFragment(messageItem, selectedKind);
                    else if (selectedKind) void saveCandidate(messageItem, selectedKind as DiscussionCandidateKind);
                  }} disabled={busy || !selectedKind || !(candidateDrafts[messageItem.id] ?? messageItem.content).trim()
                    || selectedKind === "CHAPTER_WRITING" && !chosenChapterId
                    || designPending && ["chosen", "alternatives", "questions", "BOOK_PREFERENCES", "STORY_DIRECTION", "CHAPTER_WRITING"].includes(selectedKind)}><Save size={12} />确认收集</button>
                  <button type="button" className="secondary-action" disabled={busy} onClick={() => void closeCollector(messageItem)}>取消</button></div>
                </div>
              </section></WorkspacePanel>;
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
        {!profile?.hasSecret ? <p className="project-error" role="alert">请先在设置中配置可用的共创讨论模型。</p> : null}
      </section>
      <WorkspacePanel open={showDraft} docked={wide} title="构思草稿" onClose={() => {
        setShowDraft(false); requestAnimationFrame(() => draftReturnFocus.current?.focus());
      }} className="discussion-notebook">
      {sessionId ? <DiscussionDesignPanel key={sessionId} sessionId={sessionId} profile={designProfile}
        settingsScope={projectOverrides.data?.discussionDesign ? "PROJECT" : "GLOBAL"}
        preference={designPreference} conversationBusy={busy}
        draftFocus={draftFocus} onPendingChange={setDesignPending} /> : null}
      </WorkspacePanel>
    </div>
  </div>;
}
