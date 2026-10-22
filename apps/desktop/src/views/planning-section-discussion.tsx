import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, MessageSquareText, RefreshCw, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { planningDiscussionFocus, type PlanningDiscussionFocus } from "../lib/planning-discussion";
import {
  askProjectDiscussion, createDiscussionSession, DISCUSSION_LIMITS, errorMessage, getCurrentProject,
  getProjectAiTaskOverrides, listDiscussionMessages, listDiscussionSessions, listModelProfiles,
  type DiscussionMessage, type DiscussionSession,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { AiModelNote } from "./ai-model-note";
import "./planning-section-discussion.css";

type Props = {
  sectionId: string;
  title: string;
  question: string;
  draftContent: string;
  referenceContent?: string;
  disabled?: boolean;
  readOnly?: boolean;
  onUseDraft: (content: string) => void;
  onBusyChange?: (busy: boolean) => void;
};

export function PlanningSectionDiscussion(props: Props) {
  // A section change must never reuse another item's composer or in-flight operation.
  return <SectionDiscussion key={props.sectionId} {...props} />;
}

function SectionDiscussion(props: Props) {
  const { sectionId, title, question, disabled = false, readOnly = false, onBusyChange } = props;
  const client = useQueryClient();
  const confirm = useConfirmAction();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [older, setOlder] = useState<DiscussionMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const operation = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const thread = useRef<HTMLDivElement>(null);
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, enabled: open });
  const sessions = useQuery({ queryKey: ["discussion-sessions"], queryFn: listDiscussionSessions, enabled: open && Boolean(project.data), retry: false });
  const session = sessions.data?.find((entry) => entry.projectId === project.data?.projectId
    && planningDiscussionFocus(entry)?.sectionId === sectionId);
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles, enabled: open });
  const preferences = useAiTaskPreferences(open);
  const overrides = useQuery({ queryKey: ["project-ai-task-overrides"], queryFn: getProjectAiTaskOverrides, enabled: open });
  const effectivePreferences = preferences.data ? {
    ...preferences.data,
    discussion: overrides.data?.discussion ?? resolveTaskPreference(preferences.data, "discussion"),
  } : undefined;
  const profile = resolveTaskChatProfile(profiles.data, effectivePreferences, "discussion");
  const preference = resolveTaskPreference(effectivePreferences, "discussion");
  const messages = useQuery({
    queryKey: ["discussion-messages", session?.id],
    queryFn: () => listDiscussionMessages(session!.id),
    enabled: open && Boolean(session), retry: false,
  });
  const storageKey = project.data ? `planning-discussion-composer:${project.data.projectId}:${sectionId}` : null;
  const hydratedKey = useRef<string | null>(null);
  const visibleMessages = [...new Map([...older, ...(messages.data ?? [])].map((entry) => [entry.id, entry])).values()];
  const queryError = project.error ?? sessions.error ?? profiles.error ?? preferences.error ?? overrides.error ?? messages.error;
  const ready = project.isSuccess && Boolean(project.data) && sessions.isSuccess
    && profiles.isSuccess && overrides.isSuccess && preferences.data !== undefined && !preferences.isError
    && hydratedStorageKey === storageKey && (!session || messages.isSuccess);
  const canSend = ready && profile?.hasSecret && !busy && !disabled;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useUnsavedChangesGuard(busy || Boolean(input.trim()), "当前条目的讨论有未发送输入或正在处理的操作。");
  useEffect(() => {
    if (!storageKey || hydratedKey.current === storageKey) return;
    hydratedKey.current = storageKey;
    try { setInput(localStorage.getItem(storageKey) ?? ""); }
    catch { setError("无法读取本地讨论输入，已保存的讨论记录不受影响。"); }
    setHydratedStorageKey(storageKey);
  }, [storageKey]);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages.data?.length, busy, open]);

  function changeInput(value: string) {
    setInput(value);
    if (!storageKey) return;
    try {
      if (value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch { setError("无法保存本地讨论输入，请暂时不要离开当前条目。"); }
  }

  async function send(summarize = false) {
    if (operation.current || !canSend || !profile || (!summarize && !input.trim())) return;
    const text = summarize
      ? `请把我们关于“${title}”的讨论整理成一份可供作者确认的定稿草案。只整理作者已选择或明确认可的方向，排除已否定的方案；未决定的内容明确留为待定，不替作者拍板。只输出本项草案正文，不要输出对话说明，不展开其他设定，也不写小说正文。`
      : input.trim();
    if (Array.from(text).length > DISCUSSION_LIMITS.messageChars) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let current = session;
      if (!current) {
        const focus: PlanningDiscussionFocus = { kind: "planning-section", sectionId, title, question };
        current = await createDiscussionSession({
          title: Array.from(`${title} · 讨论`).slice(0, 200).join(""),
          scopeKind: "PROJECT", scopeId: null, scopeText: JSON.stringify(focus), topicKind: "FREE",
        });
        const created = current;
        client.setQueryData<DiscussionSession[]>(["discussion-sessions"], (entries) =>
          [...(entries ?? []).filter((entry) => entry.id !== created.id), created]);
      }
      const exchange = await askProjectDiscussion({
        sessionId: current.id, profileId: profile.id, message: text,
        planningDraft: latest.current.referenceContent ?? latest.current.draftContent,
        temperature: preference.temperature ?? undefined,
        maxOutputTokens: preference.maxOutputTokens ?? undefined,
      });
      await client.cancelQueries({ queryKey: ["discussion-messages", current.id] });
      client.setQueryData<DiscussionMessage[]>(["discussion-messages", current.id], (entries) =>
        [...new Map([...(entries ?? []), exchange.userMessage, exchange.assistantMessage].map((entry) => [entry.id, entry])).values()]);
      if (mounted.current) {
        if (!summarize) changeInput("");
        else setNotice("定稿草案已整理");
      }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function useDraft(content: string) {
    if (operation.current || disabled || readOnly) return;
    const expected = latest.current.draftContent;
    operation.current = true;
    try {
      if (expected.trim() && expected !== content
        && !await confirm({ message: "用这条讨论结果替换当前草稿？已确认的正式内容保留。", confirmLabel: "替换草稿" })) return;
      if (!mounted.current || latest.current.disabled || latest.current.readOnly) return;
      if (latest.current.draftContent !== expected) { setError("确认期间草稿已变化，已保留当前编辑。"); return; }
      latest.current.onUseDraft(content);
      setNotice("已载入草稿，尚未确认为正式内容");
    } finally { operation.current = false; }
  }

  async function loadEarlier() {
    const first = visibleMessages[0];
    if (operation.current || !session || !first) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await listDiscussionMessages(session.id, DISCUSSION_LIMITS.pageSize, first.id);
      if (mounted.current) { setOlder((entries) => [...page, ...entries]); setHasOlder(page.length === DISCUSSION_LIMITS.pageSize); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className="planning-section-discussion" aria-label={`${title}的讨论`}>
    <div className="planning-discussion-heading">
      <button type="button" className={open ? "secondary-action" : "primary-action"} aria-expanded={open}
        disabled={busy} onClick={() => setOpen((value) => !value)}>
        <MessageSquareText size={15} />{open ? "收起讨论" : "发起讨论"}{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open ? <strong>{title} · 讨论</strong> : null}
    </div>
    {open ? <div className="planning-discussion-body">
      {queryError ? <p className="project-error" role="alert">{errorMessage(queryError)}
        <button type="button" className="secondary-action" disabled={busy} onClick={() => void Promise.all([
          project.refetch(), sessions.refetch(), profiles.refetch(), preferences.refetch?.(), overrides.refetch(),
          ...(session ? [messages.refetch()] : []),
        ])}><RefreshCw size={14} />重试</button></p> : null}
      {!project.isPending && project.isSuccess && !project.data ? <p role="status">请先打开作品。</p> : null}
      <div className="planning-discussion-messages" ref={thread} role="log" aria-label={`${title}的讨论记录`} aria-busy={busy}>
        {(messages.data?.length === DISCUSSION_LIMITS.pageSize || older.length > 0) && hasOlder
          ? <button type="button" className="secondary-action" disabled={busy || disabled} onClick={() => void loadEarlier()}>更早讨论</button> : null}
        {!ready && !queryError ? <p role="status">正在读取讨论…</p> : null}
        {ready && !visibleMessages.length ? <p className="planning-discussion-question">{question}</p> : null}
        {visibleMessages.map((entry) => <article key={entry.id} data-role={entry.role.toLowerCase()}>
          <strong>{entry.role === "USER" ? "你" : "AI"}</strong>
          <div>{entry.content}</div>
          {entry.role === "ASSISTANT" ? <button type="button" className="secondary-action"
            disabled={busy || disabled || readOnly} onClick={() => void useDraft(entry.content)}>
            <Check size={13} />载入草稿</button> : null}
        </article>)}
        {busy ? <p role="status">正在处理讨论…</p> : null}
      </div>
      <label className="planning-discussion-composer">你的想法
        <textarea aria-label={`${title}的讨论输入`} rows={3} value={input}
          disabled={busy || disabled || !storageKey || hydratedStorageKey !== storageKey} placeholder="我有个想法……"
          onChange={(event) => changeInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); void send();
            }
          }} />
      </label>
      <div className="planning-discussion-commands">
        <span>{Array.from(input).length.toLocaleString()} / {DISCUSSION_LIMITS.messageChars.toLocaleString()}</span>
        <button type="button" className="secondary-action" disabled={!canSend || !visibleMessages.length || Boolean(input.trim())}
          onClick={() => void send(true)}><Sparkles size={14} />整理定稿草案</button>
        <button type="button" className="primary-action" disabled={!canSend || !input.trim() || Array.from(input).length > DISCUSSION_LIMITS.messageChars}
          onClick={() => void send()}><Send size={14} />发送</button>
      </div>
      {!profile?.hasSecret && profiles.isSuccess ? <a href="/settings#models">配置讨论模型</a> : null}
      <details className="planning-discussion-model"><summary>讨论模型</summary>
        <AiModelNote compact taskLabel="共创讨论" taskKey="discussion" profile={profile} preference={preference}
          settingsScope={overrides.data?.discussion ? "PROJECT" : "GLOBAL"} /></details>
      {notice ? <p role="status" className="project-notice">{notice}</p> : null}
      {error ? <p role="alert" className="project-error">{error}</p> : null}
    </div> : null}
  </section>;
}
