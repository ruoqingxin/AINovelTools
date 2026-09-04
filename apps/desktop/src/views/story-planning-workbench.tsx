import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookMarked, Bot, Check, FileCheck2, FileText, ListTree, Save, Sparkles, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import {
  errorMessage,
  generateAiProposal,
  listPlanningSections,
  listModelProfiles,
  listSummaryMaterials,
  savePlanningSection,
  type SummaryMaterial,
  type PlanningSection,
} from "../lib/tauri-client";

const sections = [
  { id: "story-core", label: "故事核心", prompt: "题材、主题与核心矛盾" },
  { id: "world-foundation", label: "世界基础", prompt: "起源、规则、空间、地理与资源" },
  { id: "civilization", label: "文明社会", prompt: "种族、力量、生产、经济与阶级" },
  { id: "politics-culture", label: "政治文化", prompt: "势力、制度、历史、信仰与习俗" },
  { id: "story-engine", label: "故事发动机", prompt: "当前局势、主角、目标与反派" },
] as const;

type Candidate = { id: string; title: string; content: string; rationale: string; consequence: string; references: string[]; source: string };

const starterCandidates: Record<string, Array<Omit<Candidate, "id">>> = {
  "story-core": [
    { title: "先明确主角想要什么", content: "围绕主角最强烈的欲望建立故事，并让核心矛盾持续阻碍这个目标。", rationale: "读者先通过人物目标理解故事方向。", consequence: "后续情节都可以围绕目标、阻力和选择展开。", references: [], source: "常用创作方向" },
    { title: "先明确主题冲突", content: "故事核心由一个无法轻易调和的价值冲突推动。", rationale: "主题冲突能让事件不只是连续发生，而是产生立场和代价。", consequence: "人物选择会自然形成主线、转折和结局压力。", references: [], source: "常用创作方向" },
  ],
  "world-foundation": [
    { title: "先确定世界运行规则", content: "这个世界有一套稳定的规则，人物必须在规则允许的范围内行动。", rationale: "明确限制比堆叠背景名词更能支撑故事可信度。", consequence: "能力、资源和冲突都能从规则中推导出来。", references: [], source: "常用创作方向" },
  ],
  civilization: [
    { title: "先确定资源如何分配", content: "社会关系围绕稀缺资源、力量差异和生产方式形成。", rationale: "资源分配会直接影响阶级、职业和人物关系。", consequence: "社会矛盾可以转化为具体事件和角色选择。", references: [], source: "常用创作方向" },
  ],
  "politics-culture": [
    { title: "先确定谁拥有决定权", content: "不同势力围绕制度、信仰或历史解释权展开竞争。", rationale: "权力来源明确后，政治和文化才不会只是名词列表。", consequence: "人物站队、联盟和背叛都有可追溯的原因。", references: [], source: "常用创作方向" },
  ],
  "story-engine": [
    { title: "先确定当前局势", content: "故事从一个已经失衡的局势开始，主角必须在有限时间内做出选择。", rationale: "局势压力能把设定转化为正在发生的故事。", consequence: "主线目标、反派阻力和第一阶段行动会更容易生成。", references: [], source: "常用创作方向" },
  ],
};

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
  contextChapterId?: string;
}) {
  const client = useQueryClient();
  const storedSections = useQuery({
    queryKey: ["planning-sections"],
    queryFn: listPlanningSections,
  });
  const materials = useQuery({ queryKey: ["summary-materials"], queryFn: listSummaryMaterials });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const [selectedId, setSelectedId] = useState<(typeof sections)[number]["id"]>("story-core");
  const [form, setForm] = useState<PlanningSection>(emptySection("story-core"));
  const [referencesText, setReferencesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [showFineTune, setShowFineTune] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiCandidate, setAiCandidate] = useState<Candidate | null>(null);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const completedCount = (storedSections.data ?? []).filter((section) => section.content.trim()).length;
  const chatProfile = profiles.data?.find((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const selectedMaterials = (materials.data ?? []).filter((item) => selectedMaterialIds.includes(item.id));
  const stored = storedSections.data?.find((section) => section.id === selectedId);

  function toCandidate(id: string, item: Omit<Candidate, "id">): Candidate {
    return { ...item, id };
  }

  function materialCandidates(): Candidate[] {
    return selectedMaterials.map((item) => toCandidate(`material-${item.id}`, {
      title: `从材料提炼：${selectedDefinition.label}`,
      content: item.content.trim(),
      rationale: "来自已选择的项目材料，采用前请核对是否适合当前设定。",
      consequence: "采用后可继续由用户补充它对人物、冲突或情节的影响。",
      references: [item.sourceVersion ?? "项目摘要材料"],
      source: "已选材料",
    }));
  }

  const candidates = [
    ...(stored?.content.trim() ? [toCandidate("stored", { title: "继续使用当前设定", content: stored.content, rationale: stored.rationale, consequence: stored.consequence, references: stored.references, source: "已保存设定" })] : []),
    ...(starterCandidates[selectedId] ?? []).map((item, index) => toCandidate(`starter-${selectedId}-${index}`, item)),
    ...materialCandidates(),
    ...(aiCandidate ? [aiCandidate] : []),
  ];

  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setReferencesText(next.references.join("\n"));
    setError(null);
    setNotice(null);
    setSelectedCandidateId(null);
    setShowFineTune(false);
    setAiCandidate(null);
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

  function chooseCandidate(candidate: Candidate) {
    setSelectedCandidateId(candidate.id);
    setForm({ id: selectedId, content: candidate.content, rationale: candidate.rationale, consequence: candidate.consequence, references: candidate.references, updatedAt: "" });
    setReferencesText(candidate.references.join("\n"));
    setShowFineTune(true);
    setNotice("已选中候选，可以继续细修");
  }

  async function generateWithAi() {
    if (!chatProfile || !props.contextChapterId) return;
    setGenerating(true);
    setError(null);
    try {
      const existing = (storedSections.data ?? []).map((item) => `${item.id}: ${item.content}`).filter(Boolean).join("\n");
      const source = selectedMaterials.map((item) => item.content).join("\n");
      const proposal = await generateAiProposal({
        profileId: chatProfile.id,
        chapterId: props.contextChapterId,
        action: "SUMMARIZE",
        chapterTitle: selectedDefinition.label,
        chapterPlan: existing || "暂无已保存设定",
        documentJson: JSON.stringify({ type: "doc", content: [] }),
        instruction: `请为“${selectedDefinition.label}”生成一个可供用户选择的设定候选。只能根据已有设定和材料工作，不要编造已确认事实。输出四段：设定内容、形成原因、产生结果、来源依据。已有材料：${source || "暂无，主要依据已有设定"}`,
        stream: true,
      });
      const aiCandidate = toCandidate(`ai-${proposal.id}`, { title: "AI 推导候选", content: proposal.outputText, rationale: "AI 根据当前已有设定和所选材料生成，请人工核对。", consequence: "采用后可以继续细修并保存为正式设定。", references: selectedMaterials.map((item) => item.sourceVersion ?? "项目材料"), source: "AI 候选" });
      setAiCandidate(aiCandidate);
      setSelectedCandidateId(aiCandidate.id);
      setForm({ id: selectedId, content: aiCandidate.content, rationale: aiCandidate.rationale, consequence: aiCandidate.consequence, references: aiCandidate.references, updatedAt: "" });
      setReferencesText(aiCandidate.references.join("\n"));
      setShowFineTune(true);
      setNotice("AI 候选已生成，请确认后再保存");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGenerating(false); }
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
          <div className="story-planning-source-bar">
            <div><strong>先选择一个候选</strong><span>系统会把材料和已有设定整理成可采用的方案</span></div>
            <button type="button" className="secondary-action" onClick={() => void generateWithAi()} disabled={generating || !chatProfile || !props.contextChapterId}><Sparkles size={14} />{generating ? "AI 推导中…" : "AI 根据已有设定推导"}</button>
          </div>
          {!chatProfile || !props.contextChapterId ? <p className="story-planning-ai-hint">配置聊天模型并创建章节后，可使用 AI 推导候选。</p> : null}
          <div className="story-planning-material-picker">
            <div className="story-planning-picker-heading"><strong>项目材料</strong><span>勾选后可从材料提炼</span></div>
            {materials.data?.length ? materials.data.map((item: SummaryMaterial) => <label key={item.id}><input type="checkbox" checked={selectedMaterialIds.includes(item.id)} onChange={(event) => setSelectedMaterialIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><span>{item.kind} · {item.precision}</span><small>{item.content.slice(0, 70)}{item.content.length > 70 ? "…" : ""}</small></label>) : <p>还没有可用材料，可先到资料库添加摘要。</p>}
          </div>
          <div className="story-planning-candidates">
            {candidates.map((candidate) => <button type="button" className="story-planning-candidate" data-selected={selectedCandidateId === candidate.id || undefined} key={candidate.id} onClick={() => chooseCandidate(candidate)}><span className="story-planning-candidate-meta"><strong>{candidate.title}</strong><small>{candidate.source}</small></span><span>{candidate.content.slice(0, 130)}{candidate.content.length > 130 ? "…" : ""}</span><Check size={16} className="story-planning-candidate-check" /></button>)}
            {!candidates.length ? <div className="story-planning-no-candidates"><FileText size={18} /><span>暂无候选，请先选择材料或配置 AI。</span></div> : null}
          </div>
          <div className="story-planning-fine-tune" data-open={showFineTune || undefined}>
            <button type="button" className="story-planning-fine-tune-toggle" onClick={() => setShowFineTune((value) => !value)} disabled={!selectedCandidateId}>{showFineTune ? "收起细修" : "进入细修"}<span>{selectedCandidateId ? "已选择候选" : "请先选择候选"}</span></button>
            {showFineTune ? <div className="story-planning-fine-tune-fields"><div className="story-planning-primary-field"><label><span>设定内容</span><small>确认候选后，再修改成你的最终表达</small><textarea rows={7} value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} /></label></div><div className="story-planning-secondary-fields"><label><span>形成原因</span><textarea rows={4} value={form.rationale} onChange={(event) => setForm((current) => ({ ...current, rationale: event.target.value }))} /></label><label><span>产生结果</span><textarea rows={4} value={form.consequence} onChange={(event) => setForm((current) => ({ ...current, consequence: event.target.value }))} /></label></div><div className="story-planning-reference-field"><label><span>来源引用</span><textarea rows={3} value={referencesText} onChange={(event) => setReferencesText(event.target.value)} placeholder="每行一条来源版本、资料摘录或证据标记" /></label></div></div> : null}
          </div>
          <div className="story-planning-actions">
            <button type="button" className="primary-action" onClick={() => void save()} disabled={saving || !selectedCandidateId || !form.content.trim()}><Save size={15} />{saving ? "保存中…" : "保存设定"}</button>
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
