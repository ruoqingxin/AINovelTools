import { Cpu } from "lucide-react";
import type { AiTaskPreference, ModelProfile } from "../lib/tauri-client";

export function AiModelNote(props: { taskLabel: string; profile: ModelProfile | undefined; preference?: AiTaskPreference }) {
  const modelState = !props.profile
    ? "missing"
    : props.profile.hasSecret
      ? "ready"
      : "missing-key";
  const tuning = [
    props.preference?.temperature !== null && props.preference?.temperature !== undefined ? `温度 ${props.preference.temperature}` : "",
    props.preference?.maxOutputTokens !== null && props.preference?.maxOutputTokens !== undefined ? `最大 ${props.preference.maxOutputTokens} tokens` : "",
  ].filter(Boolean);
  return <div className="ai-model-note" data-state={modelState}>
    <Cpu size={14} />
    <span>
      <small>{props.taskLabel}模型{tuning.length ? ` · ${tuning.join(" · ")}` : ""}</small>
      <strong>{props.profile ? `${props.profile.name} · ${props.profile.modelId}` : "未配置可用聊天模型"}</strong>
    </span>
    <a href="/settings#ai-task-models">调整</a>
  </div>;
}
