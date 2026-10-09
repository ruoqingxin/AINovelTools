import { Bot, ChartNoAxesCombined, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AiUsageSettings } from "./ai-usage-settings";
import { AiTaskModelSettings } from "./ai-task-model-settings";
import { ModelProfileSettings } from "./model-profile-settings";
import { WritingAdmissionSettings } from "./writing-admission-settings";
import "./settings.css";
import { aiTaskSettingsFromHash } from "../lib/ai-task-preferences";

type SettingsSection = "MODEL_API" | "AI_TASKS" | "AI_USAGE" | "WRITING_ADMISSION";

const sections = [
  { key: "MODEL_API", label: "模型 API", hash: "#model-api", icon: Bot },
  { key: "AI_TASKS", label: "AI 任务模型", hash: "#ai-task-models", icon: Sparkles },
  { key: "WRITING_ADMISSION", label: "审核流程", hash: "#writing-admission", icon: ShieldCheck },
  { key: "AI_USAGE", label: "AI 用量与预算", hash: "#ai-usage", icon: ChartNoAxesCombined },
] as const;

function settingsSectionFromHash(hash = window.location.hash): SettingsSection {
  if (hash === "#ai-usage" || hash === "#ai-records") return "AI_USAGE";
  if (aiTaskSettingsFromHash(hash)) return "AI_TASKS";
  if (hash === "#writing-admission") return "WRITING_ADMISSION";
  return "MODEL_API";
}

export function SettingsView() {
  const viewRef = useRef<HTMLElement>(null);
  const acceptedHash = useRef(window.location.hash || "#model-api");
  const [activeSection, setActiveSection] = useState<SettingsSection>(settingsSectionFromHash);
  const [modelDirty, setModelDirty] = useState(false);
  const [aiTaskDirty, setAiTaskDirty] = useState(false);
  const [aiUsageDirty, setAiUsageDirty] = useState(false);
  const [writingAdmissionDirty, setWritingAdmissionDirty] = useState(false);

  function switchSection(next: SettingsSection) {
    if (next === activeSection) {
      acceptedHash.current = window.location.hash;
      return;
    }
    const dirty = activeSection === "MODEL_API"
      ? modelDirty
      : activeSection === "AI_TASKS"
        ? aiTaskDirty
        : activeSection === "AI_USAGE"
          ? aiUsageDirty
          : writingAdmissionDirty;
    if (dirty && !window.confirm("当前设置页有未保存修改，切换会丢失这些修改。确定切换吗？")) {
      window.history.replaceState(window.history.state, "", acceptedHash.current);
      return;
    }
    setActiveSection(next);
    const nextHash = next === "AI_TASKS" && aiTaskSettingsFromHash()
      ? window.location.hash
      : sections.find((section) => section.key === next)!.hash;
    window.history.replaceState(window.history.state, "", nextHash);
    acceptedHash.current = nextHash;
  }

  useEffect(() => {
    const syncSectionFromHash = () => switchSection(settingsSectionFromHash());
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, [activeSection, modelDirty, aiTaskDirty, aiUsageDirty, writingAdmissionDirty]);

  useEffect(() => {
    const workspace = viewRef.current?.closest(".workspace");
    if (workspace) workspace.scrollTop = 0;
  }, [activeSection]);

  return <section className="settings-view" ref={viewRef}>
    <div className="workspace-heading"><h1>设置</h1><p className="workspace-lede">模型连接、创作参数、审核策略与费用管理</p></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {sections.map(({ key, label, icon: Icon }) => <button key={key} type="button" className="settings-nav-item" aria-current={activeSection === key ? "page" : undefined} data-active={activeSection === key || undefined} onClick={() => switchSection(key)}><Icon size={18} /><span>{label}</span></button>)}
      </nav>
      {activeSection === "MODEL_API" ? <ModelProfileSettings onDirtyChange={setModelDirty} /> : activeSection === "AI_TASKS" ? <AiTaskModelSettings onDirtyChange={setAiTaskDirty} onSelectionChange={(hash) => { acceptedHash.current = hash; }} /> : activeSection === "WRITING_ADMISSION" ? <WritingAdmissionSettings onDirtyChange={setWritingAdmissionDirty} /> : <AiUsageSettings onDirtyChange={setAiUsageDirty} />}
    </div>
  </section>;
}
