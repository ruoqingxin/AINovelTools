import { Check, Save } from "lucide-react";
import type { usePlanningDraft } from "./use-planning-draft";
import type { PlanningStoryState } from "../lib/tauri-client";
import { useEffect, useRef, useState } from "react";
import { useConfirmAction } from "../shell/confirm-action-provider";

export function FreePlanningEditor(props: {
  draft: ReturnType<typeof usePlanningDraft>;
  label: string;
  placeholder: string;
  rows?: number;
  stateLabels: Record<PlanningStoryState, string>;
  onSave: () => void;
  onAdopt: () => void;
}) {
  const { draft } = props;
  const confirmAction = useConfirmAction();
  const latest = useRef<typeof draft | null>(draft);
  latest.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const adopting = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function adopt() {
    if (adopting.current || !draft.ready || draft.saving || !draft.form.pendingContent.trim()) return;
    const expected = draft.form;
    adopting.current = true;
    try {
      if (draft.form.content.trim() && !await confirmAction({ message: "用候选替换当前笔记？当前笔记有未保存修改时也会被替换。",
        confirmLabel: "采用为笔记" })) return;
      const current = latest.current;
      if (!mounted.current || !current?.ready || current.saving || current.form.id !== expected.id) return;
      if (current.form !== expected) { setNotice("确认期间笔记或候选已变化，已保留当前内容。请重新确认。"); return; }
      setNotice(null);
      props.onAdopt();
    } finally { adopting.current = false; }
  }
  return <div className="free-planning-editor">
    <label>{props.label}
      <textarea aria-label={props.label} rows={props.rows ?? 12} value={draft.form.content}
        disabled={!draft.ready || draft.saving} placeholder={props.placeholder}
        onChange={(event) => draft.setForm((current) => ({ ...current, content: event.target.value }))} />
    </label>
    <div className="compact-plan-savebar">
      <span>{draft.saving ? "保存中…" : draft.dirty ? "未保存" : "已保存"}</span>
      <button type="button" className="primary-action" onClick={props.onSave}
        disabled={!draft.ready || draft.saving || !draft.dirty}><Save size={14} />保存笔记</button>
    </div>
    <details className="compact-plan-more"><summary>笔记选项</summary>
      <label>内容状态<select aria-label="笔记状态" value={draft.form.storyState} disabled={!draft.ready || draft.saving}
        onChange={(event) => draft.setForm((current) => ({
          ...current, storyState: event.target.value as PlanningStoryState,
        }))}>{Object.entries(props.stateLabels).map(([state, label]) => <option key={state} value={state}
          disabled={(state === "CONFIRMED" || state === "LOCKED") && !draft.form.content.trim()
            || state === "AI_SUGGESTED" && !draft.form.pendingContent.trim()}>{label}</option>)}</select></label>
    </details>
    {draft.form.pendingContent.trim() ? <details className="free-planning-candidate" open>
      <summary>待采用内容</summary>
      <textarea aria-label="笔记候选" rows={8} disabled={!draft.ready || draft.saving}
        value={draft.form.pendingContent}
        onChange={(event) => draft.setForm((current) => ({ ...current, pendingContent: event.target.value }))} />
      <button type="button" className="secondary-action" disabled={!draft.ready || draft.saving || !draft.form.pendingContent.trim()}
        onClick={() => void adopt()}><Check size={14} />采用为笔记</button>
    </details> : null}
    {notice ? <p className="project-error" role="alert">{notice}</p> : null}
  </div>;
}
