import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageSquareText, Plus, RefreshCw, Save, Send, X } from "lucide-react";
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
  listModelProfiles,
  listPlanNodes,
  listPlanningSections,
  promoteDiscussionCandidate,
  type DiscussionCandidate,
  type DiscussionCandidateKind,
  type DiscussionMessage,
  type DiscussionScopeKind,
} from "../lib/tauri-client";
import { AiModelNote } from "./ai-model-note";
import { planningSectionGroups } from "./story-planning-workbench";

const planningOptions = planningSectionGroups.flatMap((group) => group.children);

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
  const aiPreferences = useAiTaskPreferences();
  const profile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "workDesign");
  const preference = resolveTaskPreference(aiPreferences.data, "workDesign");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scopeKind, setScopeKind] = useState<DiscussionScopeKind>("PROJECT");
  const [scopeId, setScopeId] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [sessionTitle, setSessionTitle] = useState("作品共创讨论");
  const [message, setMessage] = useState("");
  const [candidateTargetId, setCandidateTargetId] = useState("seed-premise");
  const [candidateKinds, setCandidateKinds] = useState<Record<string, DiscussionCandidateKind>>({});
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingDefault = useRef(false);
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

  useEffect(() => {
    if (!sessions.isSuccess || sessions.data.length || creatingDefault.current) return;
    creatingDefault.current = true;
    void createDiscussionSession({
      title: "作品共创讨论",
      scopeKind: "PROJECT",
      scopeId: null,
      scopeText: null,
    }).then(async (session) => {
      setSessionId(session.id);
      await client.invalidateQueries({ queryKey: ["discussion-sessions"] });
    }).catch((cause) => {
      setError(errorMessage(cause));
    }).finally(() => {
      creatingDefault.current = false;
    });
  }, [client, sessions.data, sessions.isSuccess]);

  useEffect(() => {
    if (!sessionId && sessions.data?.length) setSessionId(sessions.data[0].id);
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
      });
      setSessionId(session.id);
      await client.invalidateQueries({ queryKey: ["discussion-sessions"] });
      setNotice("已建立新的讨论会话。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!sessionId || !profile || !message.trim()) return;
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

  return <div className="discussion-workspace">
    <div className="workspace-heading">
      <p className="eyebrow">作品共创</p>
      <h1>讨论剧情，不直接改正史</h1>
      <p className="workspace-lede">讨论会保留会话和上下文版本；AI 回复只是建议，只有作者确认后才会进入候选或规划待定区。</p>
    </div>
    <div className="discussion-layout">
      <aside className="discussion-sidebar">
        <section>
          <div className="section-heading"><h2>讨论会话</h2><span>{sessions.data?.length ?? 0} 个</span></div>
          <select value={sessionId ?? ""} onChange={(event) => setSessionId(event.target.value || null)} aria-label="选择讨论会话">
            {(sessions.data ?? []).map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
          </select>
        </section>
        <section className="discussion-session-create">
          <div className="section-heading"><h2><Plus size={14} />新建会话</h2><span>可选范围</span></div>
          <label><span>标题</span><input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} /></label>
          <label><span>范围</span><select value={scopeKind} onChange={(event) => { setScopeKind(event.target.value as DiscussionScopeKind); setScopeId(""); setScopeText(""); }}><option value="PROJECT">全书</option><option value="VOLUME">当前卷</option><option value="CHAPTER">当前章节</option><option value="SCENE">当前场景</option><option value="SELECTION">当前选区</option></select></label>
          {scopeKind !== "PROJECT" ? <label><span>{scopeKind === "VOLUME" ? "分卷" : scopeKind === "SCENE" ? "场景" : "章节"}</span><select value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="" disabled>请选择</option>{scopeNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label> : null}
          {scopeKind === "SELECTION" ? <label><span>选区内容</span><textarea rows={3} value={scopeText} onChange={(event) => setScopeText(event.target.value)} placeholder="粘贴当前选中的正文片段…" /></label> : null}
          <button type="button" className="secondary-action" onClick={() => void createSession()} disabled={busy || scopeKind !== "PROJECT" && (!scopeId || scopeKind === "SELECTION" && !scopeText.trim())}><Plus size={13} />建立会话</button>
        </section>
        <section>
          <div className="section-heading"><h2>候选内容</h2><span>{candidates.data?.length ?? 0} 条</span></div>
          <div className="discussion-candidate-list">
            {(candidates.data ?? []).map((candidate) => <article className="discussion-candidate" data-status={candidate.status.toLowerCase()} key={candidate.id}>
              <div><strong>{candidateKindLabels[candidate.kind]}</strong><small>{candidateTarget(candidate)}</small></div>
              <p>{candidate.content}</p>
              {candidate.status === "PENDING" ? <div className="discussion-candidate-actions">
                {candidate.kind === "PLANNING" || candidate.kind === "SETTING" ? <button type="button" className="primary-action" onClick={() => void promote(candidate)} disabled={busy}><CheckCircle2 size={12} />写入规划待定区</button> : null}
                <button type="button" className="secondary-action destructive-action" onClick={() => void dismiss(candidate)} disabled={busy}><X size={12} />忽略</button>
              </div> : null}
            </article>)}
            {!candidates.data?.length ? <p className="plan-empty">从一条 AI 回复中保存笔记或候选内容。</p> : null}
          </div>
        </section>
      </aside>
      <main className="discussion-thread">
        <section className="discussion-thread-heading">
          <div><MessageSquareText size={17} /><div><strong>{activeSession?.title ?? "正在准备讨论"}</strong><span>{activeSession ? `${discussionScopeLabel(activeSession.scopeKind)} · 最近消息与候选会持续保留` : "会话加载中"}</span></div></div>
          <button type="button" className="secondary-action" onClick={() => void Promise.all([messages.refetch(), sections.refetch()])} disabled={messages.isFetching}><RefreshCw size={13} />刷新</button>
        </section>
        <AiModelNote taskLabel="共创讨论（当前使用作品设定模型）" taskKey="workDesign" profile={profile} preference={preference} />
        {notice ? <p className="project-notice" role="status">{notice}</p> : null}
        {error ? <p className="project-error" role="alert">{error}</p> : null}
        <div className="discussion-messages">
          {messages.isPending && sessionId ? <p className="plan-empty">正在加载讨论…</p> : messages.data?.map((messageItem) => <article className="discussion-message" data-role={messageItem.role.toLowerCase()} key={messageItem.id}>
            <header><strong>{messageLabel(messageItem)}</strong><small>{messageItem.contextVersion ? `上下文 ${messageItem.contextVersion.slice(0, 8)}` : "未绑定生成上下文"}</small></header>
            <div className="discussion-message-content">{messageItem.content}</div>
            {messageItem.role === "ASSISTANT" ? (() => {
              const selectedKind = candidateKinds[messageItem.id] ?? "SETTING";
              const needsTarget = selectedKind === "PLANNING" || selectedKind === "SETTING";
              return <div className="discussion-message-actions">
                <textarea rows={3} value={candidateDrafts[messageItem.id] ?? messageItem.content} onChange={(event) => setCandidateDrafts((current) => ({ ...current, [messageItem.id]: event.target.value }))} aria-label="转为候选时使用的内容" />
                <div>
                  <label><span>保存类型</span><select value={selectedKind} onChange={(event) => setCandidateKinds((current) => ({ ...current, [messageItem.id]: event.target.value as DiscussionCandidateKind }))}><option value="NOTE">{candidateKindLabels.NOTE}</option><option value="PLANNING">{candidateKindLabels.PLANNING}</option><option value="SETTING">{candidateKindLabels.SETTING}</option><option value="FORESHADOWING">{candidateKindLabels.FORESHADOWING}</option></select></label>
                  {needsTarget ? <label><span>目标规划项</span><select value={candidateTargetId} onChange={(event) => setCandidateTargetId(event.target.value)}>{planningOptions.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select></label> : null}
                  <button type="button" className="primary-action" onClick={() => void saveCandidate(messageItem, selectedKind)} disabled={busy}><Save size={12} />保存候选</button>
                </div>
              </div>;
            })() : null}
          </article>)}
          {!messages.isPending && !messages.data?.length ? <p className="plan-empty">从剧情方向、方案比较或影响分析开始讨论。</p> : null}
        </div>
        <section className="discussion-composer">
          <textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：如果主角在第二卷提前知道真相，会影响哪些伏笔和角色关系？请比较三种处理方式。" disabled={!sessionId || busy} />
          <div><span>讨论不会直接写入正式正文、规划、实体或知识。</span><button type="button" className="primary-action" onClick={() => void send()} disabled={!profile?.hasSecret || !message.trim() || busy}><Send size={14} />{busy ? "处理中…" : "发送讨论"}</button></div>
        </section>
        {!profile?.hasSecret ? <p className="project-error" role="alert">请先在设置中配置可用的作品设定模型。</p> : null}
      </main>
    </div>
  </div>;
}
