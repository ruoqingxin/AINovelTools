import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  errorMessage,
  getProjectAiTaskOverrides,
  getWritingReviewPolicy,
  saveWritingReviewPolicy,
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
  const [draft, setDraft] = useState<WritingReviewPolicy>("BALANCED");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (policy.data) setDraft(policy.data);
  }, [policy.data]);

  const dirty = Boolean(projectAvailable && policy.data && policy.data !== draft);
  useUnsavedChangesGuard(dirty, "当前写作准入策略有未保存修改。");

  useEffect(() => {
    props.onDirtyChange?.(dirty);
    return () => props.onDirtyChange?.(false);
  }, [dirty, props.onDirtyChange]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveWritingReviewPolicy(draft);
      client.setQueryData(["writing-review-policy"], saved);
      await client.invalidateQueries({ queryKey: ["ai-proposals"] });
      setNotice("写作准入策略已保存，后续生成会立即按新策略判断。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section className="settings-content">
    <div className="settings-content-heading">
      <div>
        <h2><ShieldCheck size={18} />写作准入</h2>
        <p>控制一致性审核对当前作品正文生成的影响范围。</p>
      </div>
    </div>
    {project.isPending || (projectAvailable && policy.isPending) ? <p className="settings-empty-label">正在读取当前作品策略…</p> : project.isError ? <p className="project-error" role="alert">读取作品状态失败：{errorMessage(project.error)}</p> : !projectAvailable ? <p className="settings-empty-label">请先打开或新建作品，写作准入策略按作品单独保存。</p> : policy.isError ? <p className="project-error" role="alert">读取写作准入策略失败：{errorMessage(policy.error)}</p> : <>
      <div className="writing-policy-options" role="radiogroup" aria-label="写作准入策略">
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
      </div>
      <div className="settings-save-row">
        <button type="button" className="primary-action" onClick={() => void save()} disabled={!dirty || saving}><Save size={14} />{saving ? "保存中…" : "保存策略"}</button>
        {notice ? <span role="status">{notice}</span> : null}
      </div>
    </>}
    {error ? <p className="project-error" role="alert">{error}</p> : null}
  </section>;
}
