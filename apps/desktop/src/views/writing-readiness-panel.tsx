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
  auditChapterPlan,
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
  chapterTitle: string;
  volumeId: string;
  volumePlan: string;
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
  const chapterPlanProfile = resolveTaskChatProfile(profiles.data, aiPreferences.data, "chapterPlan");
  const chapterPlanReady = Boolean(chapterPlanProfile?.hasSecret);
  const chapterPlanPreference = resolveTaskPreference(aiPreferences.data, "chapterPlan");
  const items = buildWritingReadinessItems(props.readiness, props.chapterId);
  const blockingItems = items.filter((item) => item.severity === "blocking");
  const warningItems = items.filter((item) => item.severity === "warning");
  const chapterPlanPrerequisite = blockingItems.find((item) => item.kind !== "chapter-plan")
    ?? (props.volumeId && !props.volumePlan.trim()
      ? { label: "分卷规划", href: `/planning#${props.volumeId}` }
      : undefined);
  const completedRequired = props.readiness.blockingCompletedCount
    + Number(!props.readiness.missingCharacterCard)
    + Number(!props.readiness.missingChapterPlan)
    + Number(!props.readiness.missingNarrativePerspective);
  const requiredTotal = props.readiness.blockingTotalCount + 3;
  const progress = Math.round((completedRequired / requiredTotal) * 100);
  const chapterPlanSection = props.sections.find(
    (section) => section.id === `plan-node:${props.chapterId}`,
  );
  const activeChapterPlan = chapterPlanSection?.pendingContent.trim()
    || chapterPlanSection?.content.trim()
    || "";
  const chapterPlanNeedsInput = activeChapterPlan.startsWith("[上下文不足]");
  const preflightNotices = chapterPlanNeedsInput
    ? [{
        id: "chapter-plan-needs-input",
        label: "AI 要求先补资料",
        detail: activeChapterPlan.replace(/^\[上下文不足\]\s*/, ""),
      }]
    : auditChapterPlan({
        chapterPlan: activeChapterPlan,
        volumePlan: props.volumePlan,
        sections: props.sections,
      });

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
    const definition = item.kind === "chapter-plan"
      ? {
          label: "章节执行卡",
          prompt: "写清本章的目标、冲突、关键行动、情感变化和结尾钩子，作为正文写作执行卡。",
          guidance: "必须承接所属分卷目标，明确本章开始状态、核心事件、人物变化、结尾钩子和下一章接口。只写本章，不展开后续章节。",
        }
      : planningItems.find((section) => section.id === item.id);
    if (!definition) return;
    const profile = item.kind === "chapter-plan" ? chapterPlanProfile : planningProfile;
    const profileReady = item.kind === "chapter-plan" ? chapterPlanReady : planningReady;
    const preference = item.kind === "chapter-plan" ? chapterPlanPreference : planningPreference;
    if (!profile || !profileReady) {
      setError(item.kind === "chapter-plan"
        ? "请先配置章节规划任务可用的聊天模型。"
        : "请先配置作品设定任务可用的聊天模型。");
      return;
    }
    if (item.kind === "chapter-plan" && chapterPlanPrerequisite) {
      setError(`请先补齐“${chapterPlanPrerequisite.label}”，再生成章节执行卡。`);
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
      const sectionId = item.kind === "chapter-plan" ? `plan-node:${props.chapterId}` : item.id;
      const taskKey = item.kind === "chapter-plan" ? "chapterPlan" : "workDesign";
      const volumeGuidance = item.kind === "chapter-plan" && props.volumePlan.trim()
        ? `所属分卷规划：${props.volumePlan.trim()}`
        : "";
      const prerequisiteGuard = item.kind === "chapter-plan"
        ? "如果已有正式设定无法支持本章人物、能力、世界规则或后果，只输出 [上下文不足] 和缺少项，不得自行补造关键设定。"
        : "";
      await enqueuePlanningAiJob({
        profileId: profile.id,
        mode: "GENERATE",
        sectionId,
        sectionTitle: item.kind === "chapter-plan" ? `${props.chapterTitle}·章节执行卡` : definition.label,
        sectionPrompt: item.kind === "chapter-plan"
          ? `当前章节“${props.chapterTitle}”：${definition.prompt}。填写参考：${definition.guidance}${prerequisiteGuard}`
          : `当前节点“${definition.label}”：${definition.prompt}。填写参考：${definition.guidance}`,
        existingContext,
        referenceContent: "",
        userGuidance: [
          `这是正文创作准备中的“${item.label}”。请生成可直接审核的候选内容，优先解决该项缺口，不要改写其他正式设定。`,
          volumeGuidance,
        ].filter(Boolean).join("\n"),
        allowRewrite: false,
        taskKey,
        temperature: preference.temperature ?? undefined,
        maxOutputTokens: preference.maxOutputTokens ?? undefined,
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
    const sectionId = item.kind === "chapter-plan" ? `plan-node:${props.chapterId}` : item.id;
    const section = item.kind === "section" || item.kind === "chapter-plan"
      ? props.sections.find((candidate) => candidate.id === sectionId)
      : undefined;
    const job = (item.kind === "section" || item.kind === "chapter-plan") && jobs.data
      ? latestJobForSection(jobs.data, sectionId)
      : undefined;
    const running = generatingSectionId === item.id
      || job?.status === "QUEUED"
      || job?.status === "RUNNING";
    const pending = Boolean(section?.pendingContent.trim());
    const failed = !running && !pending && job?.status === "FAILED";
    const itemProfileReady = item.kind === "chapter-plan" ? chapterPlanReady : planningReady;
    const manualHref = item.kind === "chapter-plan" ? `/planning#${props.chapterId}` : `/planning#${item.id}`;
    return <article className="writing-readiness-item" data-severity={item.severity} key={`${item.severity}:${item.kind}:${item.id}`}>
      <div><strong>{item.label}</strong><span>{item.description}</span></div>
      <div className="writing-readiness-item-actions">
        {item.kind === "character-card"
          ? <a className="primary-action" href={item.href}>去处理<ArrowRight size={12} /></a>
          : running
            ? <span className="writing-readiness-job"><LoaderCircle size={12} className="spin" />生成中</span>
            : pending
              ? <a className="primary-action" href={manualHref}>{item.kind === "chapter-plan" && chapterPlanNeedsInput ? "查看缺项" : "确认候选"}<ArrowRight size={12} /></a>
              : failed && job
                ? <button type="button" className="secondary-action" onClick={() => void retryReadinessJob(job)} disabled={retryingJobId !== null}><RotateCcw size={12} />{retryingJobId === job.id ? "提交中…" : "重新生成"}</button>
                : item.kind === "chapter-plan" && chapterPlanPrerequisite
                  ? <a className="primary-action" href={chapterPlanPrerequisite.href}>先补{chapterPlanPrerequisite.label}<ArrowRight size={12} /></a>
                  : itemProfileReady
                    ? <button type="button" className="primary-action" onClick={() => void generateSection(item)} disabled={generatingSectionId !== null}><Sparkles size={12} />{item.kind === "chapter-plan" ? "AI 生成执行卡" : "AI 补这项"}</button>
                    : <a className="primary-action" href="/settings#ai-task-models">配置{item.kind === "chapter-plan" ? "章节规划" : "规划"}模型<ArrowRight size={12} /></a>}
        {item.kind === "section" || item.kind === "chapter-plan" ? <a className="secondary-action" href={manualHref}>手动填写</a> : null}
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
      {activeChapterPlan ? <div className="writing-readiness-audit" data-state={preflightNotices.length ? "warning" : "ready"}>
        <div className="writing-readiness-group-heading"><strong>执行卡结构自检</strong><small>{preflightNotices.length ? `${preflightNotices.length} 项待确认` : "未发现明确缺口"}</small></div>
        {preflightNotices.length ? <div className="writing-readiness-audit-list">{preflightNotices.map((notice) => <div key={notice.id}><strong>{notice.label}</strong><span>{notice.detail}</span></div>)}</div> : <p>已识别章节目标、冲突、关键转折和结尾钩子；请在正文生成前做最终人工确认。</p>}
      </div> : null}
      {notice ? <p className="writing-readiness-notice" role="status">{notice}</p> : null}
      {error ? <p className="project-error writing-readiness-notice" role="alert">{error}</p> : null}
    </div> : null}
  </section>;
}
