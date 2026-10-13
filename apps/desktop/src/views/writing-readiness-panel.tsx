import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import { enqueuePlanningAiJob, errorMessage, listModelProfiles, type PlanningSection } from "../lib/tauri-client";
import { useJobs } from "../lib/jobs-query";
import { auditChapterPlan, type WritingReadiness } from "../lib/writing-readiness";

export function WritingReadinessPanel(props: {
  active?: boolean;
  chapterId: string;
  chapterTitle: string;
  volumeId: string;
  volumePlan: string;
  readiness: WritingReadiness;
  loading: boolean;
  sections: PlanningSection[];
  onOpenChapterPlan?: () => void;
}) {
  const client = useQueryClient();
  const active = props.active !== false;
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles, enabled: active });
  const jobs = useJobs({ enabled: active });
  const preferences = useAiTaskPreferences(active);
  const profile = resolveTaskChatProfile(profiles.data, preferences.data, "chapterPlan");
  const preference = resolveTaskPreference(preferences.data, "chapterPlan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sectionId = `plan-node:${props.chapterId}`;
  const chapterPlan = props.sections.find((section) => section.id === sectionId);
  const notices = auditChapterPlan({
    chapterPlan: chapterPlan?.content ?? "", volumePlan: props.volumePlan, sections: props.sections,
  });
  const job = jobs.data?.find((item) => {
    if (item.jobType !== "AI_PLANNING_GENERATE") return false;
    try { return JSON.parse(item.payload).sectionId === sectionId; } catch { return false; }
  });
  const running = busy || job?.status === "QUEUED" || job?.status === "RUNNING";

  useEffect(() => { setError(null); setNotice(null); }, [props.chapterId]);
  useEffect(() => {
    if (job?.status === "SUCCEEDED") void client.invalidateQueries({ queryKey: ["planning-sections"] });
  }, [client, job?.id, job?.status]);

  async function generatePlan() {
    if (!profile?.hasSecret || running) return;
    setBusy(true);
    setError(null);
    try {
      await enqueuePlanningAiJob({
        profileId: profile.id, mode: "GENERATE", sectionId, sectionTitle: `${props.chapterTitle}·本章计划`,
        sectionPrompt: "围绕本章已有灵感和作者选择整理近期写作方向。可以只有一个情境或事件，不强求目标、冲突、转折、钩子齐备；无需分卷规划，不补定全书结局。新想法只作候选，作者保留的内容不补写。",
        existingContext: props.sections.filter((section) => section.content.trim()
          && ["CONFIRMED", "LOCKED"].includes(section.storyState))
          .map((section) => `${section.id}: ${section.content}`).join("\n"),
        referenceContent: "", userGuidance: props.volumePlan.trim() ? `所属分卷参考：${props.volumePlan}` : "",
        allowRewrite: false, taskKey: "chapterPlan",
        temperature: preference.temperature ?? undefined, maxOutputTokens: preference.maxOutputTokens ?? undefined,
      });
      await client.invalidateQueries({ queryKey: ["jobs"] });
      setNotice("本章计划候选已加入后台任务。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="writing-readiness" aria-label="写作参考" data-state={notices.length ? "warning" : "ready"}>
    {props.loading ? <p role="status"><LoaderCircle size={14} className="spin" />正在读取写作参考…</p> : null}
    {notices.map((item) => <p key={item.id}><CircleAlert size={14} /><strong>{item.label}</strong> {item.detail}</p>)}
    {!props.loading && !notices.length ? <p>未发现明确的人称冲突。</p> : null}
    <details className="compact-ai-tool">
      <summary>本章计划（可选）</summary>
      <button type="button" className="secondary-action" disabled={props.loading || running || !profile?.hasSecret}
        onClick={() => void generatePlan()}><Sparkles size={14} />{running ? "生成中…" : "生成本章计划候选"}</button>
      {props.onOpenChapterPlan ? <button type="button" className="secondary-action" onClick={props.onOpenChapterPlan}>本章计划</button>
        : <a href={`/writing?assistant=plan#${encodeURIComponent(props.chapterId)}`}>本章计划</a>}
    </details>
    {notice ? <p role="status">{notice}</p> : null}
    {error || job?.status === "FAILED" ? <p className="project-error" role="alert">{error ?? job?.errorSummary}</p> : null}
  </section>;
}
