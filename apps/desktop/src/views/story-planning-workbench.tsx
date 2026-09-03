import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookMarked, Bot, FileCheck2, ListTree, Save, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import {
  errorMessage,
  listPlanningSections,
  savePlanningSection,
  type PlanningSection,
} from "../lib/tauri-client";

const sections = [
  { id: "story-core", label: "故事核心", prompt: "题材、主题与核心矛盾" },
  { id: "world-foundation", label: "世界基础", prompt: "起源、规则、空间、地理与资源" },
  { id: "civilization", label: "文明社会", prompt: "种族、力量、生产、经济与阶级" },
  { id: "politics-culture", label: "政治文化", prompt: "势力、制度、历史、信仰与习俗" },
  { id: "story-engine", label: "故事发动机", prompt: "当前局势、主角、目标与反派" },
] as const;

function emptySection(id: string): PlanningSection {
  return {
    id,
    content: "",
    rationale: "",
    consequence: "",
    references: [],
    updatedAt: "",
  };
}

export function StoryPlanningWorkbench(props: {
  onCreateOutline: () => void;
  onCreateChapter: () => void;
}) {
  const client = useQueryClient();
  const storedSections = useQuery({
    queryKey: ["planning-sections"],
    queryFn: listPlanningSections,
  });
  const [selectedId, setSelectedId] = useState<(typeof sections)[number]["id"]>("story-core");
  const [form, setForm] = useState<PlanningSection>(emptySection("story-core"));
  const [referencesText, setReferencesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const completedCount = (storedSections.data ?? []).filter((section) => section.content.trim()).length;

  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setReferencesText(next.references.join("\n"));
    setError(null);
    setNotice(null);
  }, [selectedId, storedSections.data]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await savePlanningSection({
        ...form,
        id: selectedId,
        references: referencesText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      });
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice("设定已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="story-planning-workbench" aria-label="作品设定工作台">
      <div className="story-planning-titlebar">
        <div>
          <p className="eyebrow">作品设定</p>
          <h2>把故事的基础设定整理清楚</h2>
        </div>
        <span className="story-planning-progress">{completedCount} / {sections.length} 已完成</span>
      </div>
      <div className="story-planning-layout">
        <nav className="story-planning-sections" aria-label="设定模块">
          <div className="story-planning-sections-heading"><strong>设定目录</strong><span>逐项完善</span></div>
          {sections.map((section) => {
            const completed = Boolean(storedSections.data?.find((item) => item.id === section.id)?.content.trim());
            return (
              <button
                key={section.id}
                type="button"
                data-active={selectedId === section.id || undefined}
                onClick={() => setSelectedId(section.id)}
              >
                <span className="story-planning-section-index">{String(sections.findIndex((item) => item.id === section.id) + 1).padStart(2, "0")}</span>
                <span className="story-planning-section-copy"><strong>{section.label}</strong><small>{section.prompt}</small></span>
                <span className="story-planning-section-status" data-complete={completed || undefined}>{completed ? "完成" : "待填写"}</span>
              </button>
            );
          })}
        </nav>
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">当前设定</span><h3>{selectedDefinition.label}</h3><p>{selectedDefinition.prompt}</p></div>
          </div>
          <div className="story-planning-primary-field">
            <label><span>设定内容</span><small>先写下已经确认的事实、规则或方向</small><textarea rows={7} value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} placeholder="写下当前确认的设定" /></label>
          </div>
          <div className="story-planning-secondary-fields">
            <label><span>形成原因</span><small>为什么会形成这样的设定？</small><textarea rows={5} value={form.rationale} onChange={(event) => setForm((current) => ({ ...current, rationale: event.target.value }))} placeholder="它为什么会形成？" /></label>
            <label><span>产生结果</span><small>它会如何影响人物或后续情节？</small><textarea rows={5} value={form.consequence} onChange={(event) => setForm((current) => ({ ...current, consequence: event.target.value }))} placeholder="它会造成什么结果？" /></label>
          </div>
          <div className="story-planning-reference-field">
            <label><span>来源引用</span><small>每行一条来源版本、资料摘录或证据标记</small><textarea rows={4} value={referencesText} onChange={(event) => setReferencesText(event.target.value)} placeholder="例如：资料卡片 · 时代背景摘录" /></label>
          </div>
          <div className="story-planning-actions">
            <button type="button" className="primary-action" onClick={() => void save()} disabled={saving}><Save size={15} />{saving ? "保存中…" : "保存设定"}</button>
            {notice ? <span className="project-notice">{notice}</span> : null}
            {error ? <span className="project-error" role="alert">{error}</span> : null}
          </div>
        </div>
      </div>
      <div className="story-planning-next">
        <div className="story-planning-next-heading"><strong>下一步</strong><span>设定完成后继续推进创作</span></div>
        <div><UsersRound size={16} /><span>人物、地点和势力等具体对象在知识库中维护。</span><Link to="/knowledge">进入知识库</Link></div>
        <div><ListTree size={16} /><span>设定确定后，用故事大纲拆分分卷、章节与场景。</span><button type="button" onClick={props.onCreateOutline}>建立故事大纲</button></div>
        <div><Bot size={16} /><span>AI 只生成候选；先配置模型，再在章节中续写、改写或总结。</span><Link to="/settings">配置模型</Link></div>
        <div><BookMarked size={16} /><span>外部资料先整理为摘要或写作卡片，来源会保留在设定引用中。</span><Link to="/knowledge/materials">整理资料</Link></div>
        <div><FileCheck2 size={16} /><span>章节事实需在审核页核对证据后，才会写入知识库。</span><Link to="/knowledge/review">进入审核</Link></div>
        <button type="button" className="secondary-action story-planning-chapter" onClick={props.onCreateChapter}>创建第一章</button>
      </div>
    </section>
  );
}
