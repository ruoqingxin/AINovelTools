import { Bot, ChartNoAxesCombined, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { AiUsageSettings } from "./ai-usage-settings";
import { AiTaskModelSettings } from "./ai-task-model-settings";
import { ModelProfileSettings } from "./model-profile-settings";
import { WritingAdmissionSettings } from "./writing-admission-settings";

type SettingsSection = "MODEL_API" | "AI_TASKS" | "AI_USAGE" | "WRITING_ADMISSION";

function settingsSectionFromHash(): SettingsSection {
  if (window.location.hash === "#ai-usage" || window.location.hash === "#ai-records") return "AI_USAGE";
  if (window.location.hash === "#ai-task-models") return "AI_TASKS";
  if (window.location.hash === "#writing-admission") return "WRITING_ADMISSION";
  return "MODEL_API";
}

export function SettingsView() {
  const [activeSection, setActiveSection] = useState<SettingsSection>(settingsSectionFromHash);
  const [modelDirty, setModelDirty] = useState(false);
  const [aiTaskDirty, setAiTaskDirty] = useState(false);
  const [aiUsageDirty, setAiUsageDirty] = useState(false);
  const [writingAdmissionDirty, setWritingAdmissionDirty] = useState(false);

  function switchSection(next: SettingsSection) {
    if (next === activeSection) return;
    const dirty = activeSection === "MODEL_API"
      ? modelDirty
      : activeSection === "AI_TASKS"
        ? aiTaskDirty
        : activeSection === "AI_USAGE"
          ? aiUsageDirty
          : writingAdmissionDirty;
    if (dirty && !window.confirm("当前设置页有未保存修改，确定切换吗？")) return;
    setActiveSection(next);
  }

  useEffect(() => {
    const syncSectionFromHash = () => setActiveSection(settingsSectionFromHash());
    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  return <section className="settings-view">
    <div className="workspace-heading"><p className="eyebrow">应用设置</p><h1>设置</h1><p className="workspace-lede">管理应用偏好、模型连接和当前作品的审核流程。</p></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className="settings-nav-item" data-active={activeSection === "MODEL_API" || undefined} onClick={() => switchSection("MODEL_API")}><Bot size={16} />模型 API</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "AI_TASKS" || undefined} onClick={() => switchSection("AI_TASKS")}><Sparkles size={16} />AI 任务模型</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "WRITING_ADMISSION" || undefined} onClick={() => switchSection("WRITING_ADMISSION")}><ShieldCheck size={16} />审核流程</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "AI_USAGE" || undefined} onClick={() => switchSection("AI_USAGE")}><ChartNoAxesCombined size={16} />AI 用量与预算</button>
      </nav>
      {activeSection === "MODEL_API" ? <ModelProfileSettings onDirtyChange={setModelDirty} /> : activeSection === "AI_TASKS" ? <AiTaskModelSettings onDirtyChange={setAiTaskDirty} /> : activeSection === "WRITING_ADMISSION" ? <WritingAdmissionSettings onDirtyChange={setWritingAdmissionDirty} /> : <AiUsageSettings onDirtyChange={setAiUsageDirty} />}
    </div>
  </section>;
}
