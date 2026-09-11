import { Cpu } from "lucide-react";
import type { ModelProfile } from "../lib/tauri-client";

export function AiModelNote(props: { taskLabel: string; profile: ModelProfile | undefined }) {
  const modelState = !props.profile
    ? "missing"
    : props.profile.hasSecret
      ? "ready"
      : "missing-key";
  return <div className="ai-model-note" data-state={modelState}>
    <Cpu size={14} />
    <span>
      <small>{props.taskLabel}模型</small>
      <strong>{props.profile ? `${props.profile.name} · ${props.profile.modelId}` : "未配置可用聊天模型"}</strong>
    </span>
    <a href="/settings#ai-task-models">调整</a>
  </div>;
}
