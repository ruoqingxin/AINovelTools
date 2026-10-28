import { Bot, ChartNoAxesCombined, Database, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AiUsageSettings } from "./ai-usage-settings";
import { AiTaskModelSettings } from "./ai-task-model-settings";
import { ModelProfileSettings } from "./model-profile-settings";
import { WritingAdmissionSettings } from "./writing-admission-settings";
import "./settings.css";
import { aiTaskSettingsFromHash } from "../lib/ai-task-preferences";
import { DataManagementView } from "./data-management-view";
import { AiQualityReview } from "./ai-quality-review";
import { useConfirmAction } from "../shell/confirm-action-provider";
import { useActiveNavigation } from "./use-active-navigation";

type SettingsSection = "MODEL_API" | "AI_TASKS" | "AI_USAGE" | "WRITING_ADMISSION" | "DATA";

const sections = [
  { key: "MODEL_API", label: "模型 API", hash: "#model-api", icon: Bot },
  { key: "AI_TASKS", label: "AI 任务模型", hash: "#ai-task-models", icon: Sparkles },
  { key: "WRITING_ADMISSION", label: "审核流程", hash: "#writing-admission", icon: ShieldCheck },
  { key: "AI_USAGE", label: "AI 用量与预算", hash: "#ai-usage", icon: ChartNoAxesCombined },
  { key: "DATA", label: "数据管理", hash: "#data-management", icon: Database },
] as const;

function settingsSectionFromHash(hash = window.location.hash): SettingsSection {
  if (hash === "#ai-usage" || hash === "#ai-records" || hash === "#quality") return "AI_USAGE";
  if (hash === "#data-management") return "DATA";
  if (aiTaskSettingsFromHash(hash)) return "AI_TASKS";
  if (hash === "#writing-admission") return "WRITING_ADMISSION";
  return "MODEL_API";
}

export function SettingsView() {
  const confirmAction = useConfirmAction();
  const switching = useRef(false);
  const viewRef = useRef<HTMLElement>(null);
  const acceptedHash = useRef(window.location.hash || "#model-api");
  const [activeSection, setActiveSection] = useState<SettingsSection>(settingsSectionFromHash);
  const categoryNav = useActiveNavigation(activeSection);
  const [modelDirty, setModelDirty] = useState(false);
  const [aiTaskDirty, setAiTaskDirty] = useState(false);
  const [aiUsageDirty, setAiUsageDirty] = useState(false);
  const [writingAdmissionDirty, setWritingAdmissionDirty] = useState(false);
  const [dataDirty, setDataDirty] = useState(false);
  const [analysis, setAnalysis] = useState(() => window.location.hash === "#quality");
  const [switchError, setSwitchError] = useState<string | null>(null);
  const currentView = useRef({ activeSection, analysis });
  currentView.current = { activeSection, analysis };
  function formSnapshot() {
    return JSON.stringify(Array.from(viewRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select") ?? [])
      .map((field) => [field.name, field.value, field instanceof HTMLInputElement ? field.checked : null]));
  }

  async function switchSection(next: SettingsSection, requestedHash?: string) {
    if (switching.current) {
      window.history.replaceState(window.history.state, "", acceptedHash.current);
      return;
    }
    if (next === activeSection && requestedHash === undefined) return;
    const nextHash = requestedHash ?? sections.find((section) => section.key === next)!.hash;
    const nextAnalysis = next === "AI_USAGE" && nextHash === "#quality";
    const changingView = next !== activeSection || next === "AI_USAGE" && nextAnalysis !== analysis;
    const dirty = !changingView ? false : activeSection === "MODEL_API"
      ? modelDirty
      : activeSection === "AI_TASKS"
        ? aiTaskDirty
        : activeSection === "AI_USAGE"
          ? aiUsageDirty
          : activeSection === "DATA" ? dataDirty : writingAdmissionDirty;
    const expected = currentView.current, form = formSnapshot();
    const previousHash = acceptedHash.current;
    switching.current = true;
    if (dirty) {
      window.history.replaceState(window.history.state, "", acceptedHash.current);
    }
    try {
      if (dirty && !await confirmAction({
        message: next === activeSection && next === "AI_USAGE" ? "预算有未保存修改，确定切换吗？"
          : "当前设置页有未保存修改，切换会丢失这些修改。确定切换吗？",
        confirmLabel: "放弃修改并切换",
      })) return;
      if (!viewRef.current || currentView.current.activeSection !== expected.activeSection
        || currentView.current.analysis !== expected.analysis) return;
      if (dirty && formSnapshot() !== form) {
        setSwitchError("确认期间设置内容已变化，已保留当前修改。请重新确认。"); return;
      }
      setSwitchError(null);
      setActiveSection(next);
      window.history.replaceState(window.history.state, "", nextHash);
      acceptedHash.current = nextHash;
      if (next === "AI_USAGE") setAnalysis(nextAnalysis);
    } finally {
      switching.current = false;
      if (acceptedHash.current === previousHash) window.history.replaceState(window.history.state, "", previousHash);
    }
  }

  useEffect(() => {
    const syncSectionFromHash = () => { void switchSection(settingsSectionFromHash(), window.location.hash); };
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, [activeSection, modelDirty, aiTaskDirty, aiUsageDirty, writingAdmissionDirty, dataDirty, analysis]);

  useEffect(() => {
    const workspace = viewRef.current?.closest(".workspace");
    if (workspace) workspace.scrollTop = 0;
    const panel = viewRef.current?.querySelector(".settings-section-panel");
    if (panel) panel.scrollTop = 0;
  }, [activeSection, analysis]);

  return <section className="settings-view" ref={viewRef}>
    <div className="workspace-heading"><h1>设置</h1></div>
    <div className="settings-layout">
      <nav ref={categoryNav} className="settings-nav" aria-label="设置分类">
        {sections.map(({ key, label, icon: Icon }) => <button key={key} type="button" className="settings-nav-item" aria-current={activeSection === key ? "page" : undefined} data-active={activeSection === key || undefined} onClick={() => void switchSection(key)}><Icon size={18} /><span>{label}</span></button>)}
      </nav>
      {switchError ? <p className="project-error settings-switch-error" role="alert">{switchError}</p> : null}
      <div className="settings-section-panel">
      {activeSection === "MODEL_API" ? <ModelProfileSettings onDirtyChange={setModelDirty} /> : activeSection === "AI_TASKS" ? <AiTaskModelSettings onDirtyChange={setAiTaskDirty} onSelectionChange={(hash) => { acceptedHash.current = hash; }} /> : activeSection === "WRITING_ADMISSION" ? <WritingAdmissionSettings onDirtyChange={setWritingAdmissionDirty} /> : activeSection === "DATA" ? <DataManagementView onDirtyChange={setDataDirty} /> : <div className="settings-analysis-layout">
        <div className="settings-period-switch" role="group" aria-label="用量与效果视图">
          <button type="button" aria-pressed={!analysis} onClick={() => void switchSection("AI_USAGE", "#ai-usage")}>用量与预算</button>
          <button type="button" aria-pressed={analysis} onClick={() => void switchSection("AI_USAGE", "#quality")}>效果分析</button>
        </div>
        {analysis ? <AiQualityReview /> : <AiUsageSettings onDirtyChange={setAiUsageDirty} />}
      </div>}
      </div>
    </div>
  </section>;
}
