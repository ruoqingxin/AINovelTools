import { Bot, Settings2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { AiTaskModelSettings } from "./ai-task-model-settings";
import { ModelProfileSettings } from "./model-profile-settings";

export function SettingsView() {
  const [activeSection, setActiveSection] = useState<"MODEL_API" | "AI_TASKS">(
    () => window.location.hash === "#ai-task-models" ? "AI_TASKS" : "MODEL_API",
  );

  useEffect(() => {
    const syncSectionFromHash = () => {
      if (window.location.hash === "#ai-task-models") setActiveSection("AI_TASKS");
    };
    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  return <section className="settings-view">
    <div className="workspace-heading"><p className="eyebrow">应用设置</p><h1>设置</h1><p className="workspace-lede">管理应用偏好与本机连接配置。</p></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className="settings-nav-item" data-active={activeSection === "MODEL_API" || undefined} onClick={() => setActiveSection("MODEL_API")}><Bot size={16} />模型 API</button>
        <button type="button" className="settings-nav-item" data-active={activeSection === "AI_TASKS" || undefined} onClick={() => setActiveSection("AI_TASKS")}><Sparkles size={16} />AI 任务模型</button>
        <button type="button" className="settings-nav-item" disabled><Settings2 size={16} />项目偏好</button>
      </nav>
      {activeSection === "MODEL_API" ? <ModelProfileSettings /> : <AiTaskModelSettings />}
    </div>
  </section>;
}
