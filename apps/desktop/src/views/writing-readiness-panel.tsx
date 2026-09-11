import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CircleAlert, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveTaskChatProfile, resolveTaskPreference, useAiTaskPreferences } from "../lib/ai-task-preferences";
import {
  enqueuePlanningAiJob,
  errorMessage,
  listJobs,
  listModelProfiles,
  retryJob,
  type Job,
  type PlanningSection,
} from "../lib/tauri-client";
import {
  buildWritingReadinessItems,
  type WritingReadiness,
  type WritingReadinessItem,
} from "../lib/writing-readiness";
import { planningSectionGroups } from "./story-planning-workbench";

const planningItems = planningSectionGroups.flatMap((group) => group.children);

function planningSectionId(job: Job) {
  if (job.jobType !== "AI_PLANNING_GENERATE") return null;
  try {
    const payload = JSON.parse(job.payload) as { sectionId?: string };
    return payload.sectionId ?? null;
  } catch {
    return null;
  }
}

function latestJobForSection(jobs: Job[], sectionId: string) {
  return jobs
    .filter((job) => planningSectionId(job) === sectionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function WritingReadinessPanel(props: {
  chapterId: string;
  readiness: WritingReadiness;
  loading: boolean;
  sections: PlanningSection[];
}) {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 1200 });
  const aiPreferences = useAiTaskPreferences();
  const [generatingSectionId, setGeneratingSectionId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completedJobIds = useRef(new Set<string>());
  const completionBaselineReady = useRef(false);
  const planningProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "workDesign");
  const planningReady = Boolean(planningProfile?.hasSecret);
  const planningPreference = resolveTaskPreference(aiPreferences.data, "workDesign");
  const items = buildWritingReadinessItems(props.readiness, props.chapterId);
  const blockingItems = items.filter((item) => item.severity === "blocking");
  const warningItems = items.filter((item) => item.severity === "warning");
  const completedRequired = props.readiness.blockingCompletedCount
    + Number(!props.readiness.missingCharacterCard)
    + Number(!props.readiness.missingChapterPlan)
    + Number(!props.readiness.missingNarrativePerspective);
  const requiredTotal = props.readiness.blockingTotalCount + 3;
  const progress = Math.round((completedRequired / requiredTotal) * 100);

  useEffect(() => {
    setNotice(null);
    setError(null);
  }, [props.chapterId]);

  useEffect(() => {
    const completed = (jobs.data ?? []).filter(
      (job) => job.jobType === "AI_PLANNING_GENERATE" && job.status === "SUCCEEDED",
    );
    if (!completionBaselineReady.current) {
      completed.forEach((job) => completedJobIds.current.add(job.id));
      completionBaselineReady.current = true;
      return;
    }
    const newlyCompleted = completed.filter((job) => !completedJobIds.current.has(job.id));
    if (!newlyCompleted.length) return;
    newlyCompleted.forEach((job) => completedJobIds.current.add(job.id));
    setNotice("AI 候选已生成，确认后会立即更新创作准备度。");
    void client.invalidateQueries({ queryKey: ["planning-sections"] });
  }, [client, jobs.data]);

  async function generateSection(item: WritingReadinessItem) {
    const definition = planningItems.find((section) => section.id === item.id);
    if (!definition) return;
    if (!planningProfile || !planningReady) {
      setError("请先配置作品设定任务可用的聊天模型。");
      return;
    }
    setGeneratingSectionId(item.id);
    setError(null);
    setNotice(null);
    try {
      const existingContext = props.sections
        .filter((section) => section.content.trim() && section.id !== item.id)
        .map((section) => `${section.id}: ${section.content}`)
        .join("\n");
      await enqueuePlanningAiJob({
        profileId: planningProfile.id,
        mode: "GENERATE",
        sectionId: item.id,
        sectionTitle: definition.label,
        sectionPrompt: `当前节点“${definition.label}”：${definition.prompt}。填写参考：${definition.guidance}`,
        existingContext,
        referenceContent: "",
        userGuidance: `这是正文创作准备中的“${item.label}”。请生成可直接审核的候选内容，优先解决该项缺口，不要改写其他正式设定。`,
        allowRewrite: false,
        taskKey: "workDesign",
        temperature: planningPreference.temperature ?? undefined,
        maxOutputTokens: planningPreference.maxOutputTokens ?? undefined,
      });
      setNotice(`已提交“${item.label}”的 AI 推导任务，完成后会进入待定区。`);
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setGeneratingSectionId(null);
    }
  }

  async function retryReadinessJob(job: Job) {
    setRetryingJobId(job.id);
    setError(null);
    setNotice(null);
    try {
      await retryJob(job.id);
      setNotice("失败任务已重新进入队列，将沿用原提示词继续生成。");
      await client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRetryingJobId(null);
    }
  }

  function renderItem(item: WritingReadinessItem) {
    const section = item.kind === "section"
      ? props.sections.find((candidate) => candidate.id === item.id)
      : undefined;
    const job = item.kind === "section" && jobs.data
      ? latestJobForSection(jobs.data, item.id)
      : undefined;
    const running = generatingSectionId === item.id
      || job?.status === "QUEUED"
      || job?.status === "RUNNING";
    const pending = Boolean(section?.pendingContent.trim());
    const failed = !running && !pending && job?.status === "FAILED";
    return <article className="writing-readiness-item" data-severity={item.severity} key={`${item.severity}:${item.kind}:${item.id}`}>
      <div><strong>{item.label}</strong><span>{item.description}</span></div>
      <div className="writing-readiness-item-actions">
        {item.kind !== "section" ? <a className="primary-action" href={item.href}>去处理<ArrowRight size={12} /></a> : running ? <span className="writing-readiness-job"><LoaderCircle size={12} className="spin" />生成中</span> : pending ? <a className="primary-action" href={`/planning#${item.id}`}>确认候选<ArrowRight size={12} /></a> : failed && job ? <button type="button" className="secondary-action" onClick={() => void retryReadinessJob(job)} disabled={retryingJobId !== null}><RotateCcw size={12} />{retryingJobId === job.id ? "提交中…" : "重新生成"}</button> : planningReady ? <button type="button" className="primary-action" onClick={() => void generateSection(item)} disabled={generatingSectionId !== null}><Sparkles size={12} />AI 补这项</button> : <a className="primary-action" href="/settings#ai-task-models">配置规划模型<ArrowRight size={12} /></a>}
        {item.kind === "section" ? <a className="secondary-action" href={`/planning#${item.id}`}>手动填写</a> : null}
      </div>
    </article>;
  }

  const state = props.loading
    ? "loading"
    : props.readiness.canGenerate
      ? props.readiness.warningMissingSections.length
        ? "warning"
        : "ready"
      : "blocked";
  const message = props.loading
    ? "正在核对正式设定、人物卡和章节执行卡。"
    : props.readiness.canGenerate
      ? props.readiness.warningMissingSections.length
        ? `${completedRequired}/${requiredTotal} 项创作依据已就绪；另有 ${props.readiness.warningMissingSections.length} 项建议补充。`
        : "关键设定、人物卡、章节执行卡和叙述人称均已确认，可以进入正文创作。"
      : `${completedRequired}/${requiredTotal} 项创作依据已就绪；补齐必须项后即可开始创作。`;

  return <section className="writing-readiness" id="writing-readiness" data-state={state} aria-label="创作准备">
    <div className="writing-readiness-heading">
      {props.loading ? <LoaderCircle size={16} className="spin" /> : props.readiness.canGenerate ? <Check size={16} /> : <CircleAlert size={16} />}
      <div><strong>创作准备</strong><span>{message}</span></div>
      <small>{props.loading ? "检查中" : props.readiness.canGenerate ? props.readiness.warningMissingSections.length ? "可写·有建议" : "可写" : "待补齐"}</small>
    </div>
    {!props.loading && items.length ? <div className="writing-readiness-body">
      <div className="writing-readiness-progress" aria-label={`创作准备度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
        <small>{progress}%</small>
      </div>
      <div className="writing-readiness-list">
        {blockingItems.length ? <div className="writing-readiness-group"><div className="writing-readiness-group-heading"><strong>必须补齐</strong><small>{blockingItems.length} 项</small></div>{blockingItems.map(renderItem)}</div> : null}
        {warningItems.length ? <div className="writing-readiness-group"><div className="writing-readiness-group-heading"><strong>建议补充</strong><small>{warningItems.length} 项</small></div>{warningItems.map(renderItem)}</div> : null}
      </div>
      {notice ? <p className="writing-readiness-notice" role="status">{notice}</p> : null}
      {error ? <p className="project-error writing-readiness-notice" role="alert">{error}</p> : null}
    </div> : null}
  </section>;
}
