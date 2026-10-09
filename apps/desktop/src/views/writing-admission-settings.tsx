import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, BookOpenCheck, FileCheck2, FolderOpen, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  errorMessage,
  getAuditFlowSettings,
  getProjectAiTaskOverrides,
  getWritingReviewPolicy,
  saveWritingReviewPolicy,
  saveAuditFlowSettings,
  type AuditFlowSettings,
  type WritingReviewPolicy,
} from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

const POLICY_OPTIONS: Array<{
  value: WritingReviewPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "ADVISORY",
    label: "建议模式",
    description: "审核结论只作为创作提醒，不会阻止整章创作或续写。",
  },
  {
    value: "BALANCED",
    label: "平衡模式",
    description: "最新审核的阻断结论会停止生成；审核过期后只提示，不继续阻断。",
  },
  {
    value: "REQUIRED",
    label: "严格模式",
    description: "必须存在与当前内容一致且可解析的审核，过期或缺失时禁止生成。",
  },
];

const REVIEW_STEPS = [
  { key: "admission", title: "创作准入", when: "生成正文前", description: "核对章节执行卡、作品设定与已有草稿。", off: "不执行创作前检查，准入策略不生效。", icon: ShieldCheck },
  { key: "manuscript", title: "候选审核", when: "同步正文前", description: "核对人物、世界规则、时间线与章节目标。", off: "跳过候选一致性审核，仍需作者确认同步。", icon: BookOpenCheck },
  { key: "knowledge", title: "知识审核", when: "提取知识后", description: "核对事实证据、知识冲突与已定稿内容。", off: "跳过知识审核环节。", icon: FileCheck2 },
] as const;

export function WritingAdmissionSettings(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const client = useQueryClient();
  const project = useQuery({
    queryKey: ["project-ai-task-overrides"],
    queryFn: getProjectAiTaskOverrides,
  });
  const projectAvailable = project.data?.available === true;
  const policy = useQuery({
    queryKey: ["writing-review-policy"],
    queryFn: getWritingReviewPolicy,
    enabled: projectAvailable,
  });
  const auditFlow = useQuery({
    queryKey: ["audit-flow-settings"],
    queryFn: getAuditFlowSettings,
    enabled: projectAvailable,
  });
  const [draft, setDraft] = useState<WritingReviewPolicy>("BALANCED");
  const [flowDraft, setFlowDraft] = useState<AuditFlowSettings>({ admission: true, manuscript: true, knowledge: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (policy.data) setDraft(policy.data);
  }, [policy.data]);
  useEffect(() => {
    if (auditFlow.data) setFlowDraft(auditFlow.data);
  }, [auditFlow.data]);

  const dirty = Boolean(projectAvailable && policy.data && auditFlow.data && (policy.data !== draft || Object.keys(flowDraft).some((key) => flowDraft[key as keyof AuditFlowSettings] !== auditFlow.data[key as keyof AuditFlowSettings])));
  useUnsavedChangesGuard(dirty, "当前审核流程有未保存修改。");

  useEffect(() => {
    props.onDirtyChange?.(dirty);
    return () => props.onDirtyChange?.(false);
  }, [dirty, props.onDirtyChange]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const [saved, savedFlow] = await Promise.all([saveWritingReviewPolicy(draft), saveAuditFlowSettings(flowDraft)]);
      client.setQueryData(["writing-review-policy"], saved);
      client.setQueryData(["audit-flow-settings"], savedFlow);
      await client.invalidateQueries({ queryKey: ["ai-proposals"] });
      setNotice("审核流程已保存，后续创作会立即按新设置执行。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section className="settings-content">
    <div className="settings-content-heading">
      <div>
        <span className="settings-scope-label">当前作品 · 单独保存</span>
        <h2><ShieldCheck size={18} />审核流程</h2>
        <p>为正文创作、候选同步和知识入库设置审核边界。</p>
      </div>
      <a className="settings-text-link" href="/review">审核中心<ArrowUpRight size={14} /></a>
    </div>
    {project.isPending || (projectAvailable && (policy.isPending || auditFlow.isPending)) ? <p className="settings-empty-label">正在读取当前作品策略…</p> : project.isError ? <p className="project-error" role="alert">读取作品状态失败：{errorMessage(project.error)} <button className="settings-text-link" onClick={() => void project.refetch()}>重试</button></p> : !projectAvailable ? <div className="settings-empty-state"><FolderOpen size={30} /><h3>尚未打开作品</h3><p>请先打开或新建作品，审核流程按作品单独保存。</p><a href="/" className="secondary-action"><FolderOpen size={15} />选择作品</a></div> : policy.isError || auditFlow.isError ? <p className="project-error" role="alert">读取审核流程失败：{errorMessage(policy.error ?? auditFlow.error)} <button className="settings-text-link" onClick={() => { void policy.refetch(); void auditFlow.refetch(); }}>重试</button></p> : <>
      <div className="settings-section-heading"><h3>审核环节</h3><span className="settings-status">{Object.values(flowDraft).filter(Boolean).length} / 3 已开启</span></div>
      <fieldset className="settings-fields" disabled={saving}>
      <div className="audit-flow-options" aria-label="审核步骤">
        {REVIEW_STEPS.map(({ key, title, when, description, off, icon: Icon }, index) => <label key={key} className="settings-review-step" data-enabled={flowDraft[key] || undefined}>
          <span className="settings-step-icon"><Icon size={20} /></span>
          <span className="settings-review-copy"><strong>{index + 1}. {title}<em>{when}</em></strong><small>{flowDraft[key] ? description : off}</small></span>
          <span className="settings-switch-state">{flowDraft[key] ? "已开启" : "已关闭"}</span>
          <input className="settings-switch" type="checkbox" role="switch" aria-label={title} checked={flowDraft[key]} onChange={(event) => { setFlowDraft((value) => ({ ...value, [key]: event.target.checked })); setNotice(null); }} />
        </label>)}
      </div>
      {flowDraft.admission ? <section className="settings-policy-section"><div className="settings-section-heading"><h3>准入策略</h3><span className="settings-status">仅作用于创作准入</span></div><div className="writing-policy-options" role="radiogroup" aria-label="写作准入策略">
        {POLICY_OPTIONS.map((option) => <label className="settings-policy-option" data-active={draft === option.value || undefined} key={option.value}>
          <input type="radio" name="writing-admission-policy" checked={draft === option.value} aria-label={option.label} onChange={() => { setDraft(option.value); setNotice(null); }} />
          <span><strong>{option.label}{option.value === "BALANCED" ? <em>推荐</em> : null}</strong><small>{option.description}</small></span>
        </label>)}
      </div></section> : <p className="settings-field-warning">创作准入已关闭，准入策略暂不生效；已保存的策略会保留。</p>}
      </fieldset>
      <div className="settings-save-row">
        <button type="button" className="primary-action" onClick={() => void save()} disabled={!dirty || saving}><Save size={14} />{saving ? "保存中…" : "保存流程"}</button>
        {notice ? <span role="status">{notice}</span> : null}
        {dirty ? <button type="button" className="secondary-action" disabled={saving} onClick={() => { if (policy.data) setDraft(policy.data); if (auditFlow.data) setFlowDraft(auditFlow.data); setNotice(null); }}><RotateCcw size={14} />撤销修改</button> : null}
        <span className="settings-status" data-dirty={dirty || undefined}>{dirty ? "未保存修改" : "当前策略已生效"}</span>
      </div>
    </>}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
  </section>;
}
