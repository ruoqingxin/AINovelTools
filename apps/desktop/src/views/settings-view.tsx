import { Bot, ChartNoAxesCombined, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { AiUsageSettings } from "./ai-usage-settings";
import { AiTaskModelSettings } from "./ai-task-model-settings";
import { ModelProfileSettings } from "./model-profile-settings";
import { WritingAdmissionSettings } from "./writing-admission-settings";

export function SettingsView() {
  const [activeSection, setActiveSection] = useState<"MODEL_API" | "AI_TASKS" | "AI_RECORDS" | "WRITING_ADMISSION">(
    () => window.location.hash === "#ai-records" ? "AI_RECORDS" : window.location.hash === "#ai-task-models" ? "AI_TASKS" : window.location.hash === "#writing-admission" ? "WRITING_ADMISSION" : "MODEL_API",
  );
  const [modelDirty, setModelDirty] = useState(false);
  const [aiTaskDirty, setAiTaskDirty] = useState(false);
  const [aiRecordsDirty, setAiRecordsDirty] = useState(false);
  const [writingAdmissionDirty, setWritingAdmissionDirty] = useState(false);

  function switchSection(next: "MODEL_API" | "AI_TASKS" | "AI_RECORDS" | "WRITING_ADMISSION") {
    if (next === activeSection) return;
    const dirty = activeSection === "MODEL_API"
      ? modelDirty
      : activeSection === "AI_TASKS"
        ? aiTaskDirty
        : activeSection === "AI_RECORDS"
          ? aiRecordsDirty
          : writingAdmissionDirty;
    if (dirty && !window.confirm("当前设置页有未保存修改，确定切换吗？")) return;
    setActiveSection(next);
  }

  useEffect(() => {
    const syncSectionFromHash = () => {
      if (window.location.hash === "#ai-task-models") setActiveSection("AI_TASKS");
      if (window.location.hash === "#ai-records") setActiveSection("AI_RECORDS");
      if (window.location.hash === "#writing-admission") setActiveSection("WRITING_ADMISSION");
    };
    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  return <section className="settings-view">
    <div className="workspace-heading"><p className="eyebrow">应用设置</p><h1>设置</h1><p className="workspace-lede">管理应用偏好、模型连接和当前作品的写作准入。</p></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className="settings-nav-item" data-active={activeSection === "MODEL_API" || undefined} onClick={() => switchSection("MODEL_API")}><Bot size={16} />模型 API</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "AI_TASKS" || undefined} onClick={() => switchSection("AI_TASKS")}><Sparkles size={16} />AI 任务模型</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "WRITING_ADMISSION" || undefined} onClick={() => switchSection("WRITING_ADMISSION")}><ShieldCheck size={16} />写作准入</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "AI_RECORDS" || undefined} onClick={() => switchSection("AI_RECORDS")}><ChartNoAxesCombined size={16} />预算与记录</button>
      </nav>
      {activeSection === "MODEL_API" ? <ModelProfileSettings onDirtyChange={setModelDirty} /> : activeSection === "AI_TASKS" ? <AiTaskModelSettings onDirtyChange={setAiTaskDirty} /> : activeSection === "WRITING_ADMISSION" ? <WritingAdmissionSettings onDirtyChange={setWritingAdmissionDirty} /> : <AiUsageSettings onDirtyChange={setAiRecordsDirty} />}
    </div>
  </section>;
}
