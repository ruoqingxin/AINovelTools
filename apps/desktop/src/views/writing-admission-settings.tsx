import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ShieldCheck } from "lucide-react";
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
        <h2><ShieldCheck size={18} />审核流程</h2>
        <p>按创作顺序选择启用哪些审核；关闭的步骤不会在审核中心显示。</p>
      </div>
    </div>
    {project.isPending || (projectAvailable && (policy.isPending || auditFlow.isPending)) ? <p className="settings-empty-label">正在读取当前作品策略…</p> : project.isError ? <p className="project-error" role="alert">读取作品状态失败：{errorMessage(project.error)}</p> : !projectAvailable ? <p className="settings-empty-label">请先打开或新建作品，审核流程按作品单独保存。</p> : policy.isError || auditFlow.isError ? <p className="project-error" role="alert">读取审核流程失败：{errorMessage(policy.error ?? auditFlow.error)}</p> : <>
      <div className="audit-flow-options" aria-label="审核步骤">
        <label><input type="checkbox" checked={flowDraft.admission} onChange={(event) => { setFlowDraft((value) => ({ ...value, admission: event.target.checked })); setNotice(null); }} /><span><strong>1. 创作准入</strong><small>在生成正文前检查执行卡、设定与已有草稿。</small></span></label>
        <label><input type="checkbox" checked={flowDraft.manuscript} onChange={(event) => { setFlowDraft((value) => ({ ...value, manuscript: event.target.checked })); setNotice(null); }} /><span><strong>2. 正文审核</strong><small>正文完成后检查人物状态、规则、时间线和叙述。</small></span></label>
        <label><input type="checkbox" checked={flowDraft.knowledge} onChange={(event) => { setFlowDraft((value) => ({ ...value, knowledge: event.target.checked })); setNotice(null); }} /><span><strong>3. 知识审核</strong><small>知识提取后核对事实证据、冲突与定稿内容。</small></span></label>
      </div>
      {flowDraft.admission ? <div className="writing-policy-options" role="radiogroup" aria-label="写作准入策略">
        {POLICY_OPTIONS.map((option) => <button
          type="button"
          role="radio"
          aria-checked={draft === option.value}
          data-active={draft === option.value || undefined}
          key={option.value}
          onClick={() => { setDraft(option.value); setNotice(null); }}
        >
          <strong>{option.label}</strong>
          <span>{option.description}</span>
        </button>)}
      </div> : null}
      <div className="settings-save-row">
        <button type="button" className="primary-action" onClick={() => void save()} disabled={!dirty || saving}><Save size={14} />{saving ? "保存中…" : "保存流程"}</button>
        {notice ? <span role="status">{notice}</span> : null}
      </div>
    </>}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
  </section>;
}
