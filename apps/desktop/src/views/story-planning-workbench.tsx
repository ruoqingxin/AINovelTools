import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookMarked, Bot, Check, FileCheck2, FileText, FileUp, ListTree, Save, Search, Sparkles, UsersRound, PenLine } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  errorMessage,
  generateAiProposal,
  listPlanningSections,
  listModelProfiles,
  listEntities,
  listEntityRevisions,
  listSummaryMaterials,
  savePlanningSection,
  type SummaryMaterial,
  type PlanningSection,
} from "../lib/tauri-client";

type PlanningItem = { id: string; label: string; prompt: string };
type PlanningGroup = { id: string; label: string; children: PlanningItem[] };

const sectionGroups: PlanningGroup[] = [
  { id: "story-core", label: "故事核心", children: [{ id: "story-theme", label: "主题与题材", prompt: "这部小说想讨论什么" }, { id: "story-protagonist", label: "主角与欲望", prompt: "主角想得到什么" }, { id: "story-conflict", label: "核心冲突", prompt: "什么力量阻碍主角" }] },
  { id: "world-foundation", label: "世界基础", children: [{ id: "world-origin", label: "起源", prompt: "世界从何而来" }, { id: "world-rules", label: "规则", prompt: "世界如何运行" }, { id: "world-space", label: "空间", prompt: "故事发生在哪里" }, { id: "world-geography", label: "地理", prompt: "地点如何分布和连接" }, { id: "world-resources", label: "资源", prompt: "什么稀缺、谁掌握它" }] },
  { id: "civilization", label: "文明社会", children: [{ id: "society-species", label: "种族与群体", prompt: "谁生活在这个世界" }, { id: "society-power", label: "力量体系", prompt: "力量从哪里来" }, { id: "society-production", label: "生产方式", prompt: "社会如何生产和交换" }, { id: "society-economy", label: "经济", prompt: "财富如何流动" }, { id: "society-class", label: "阶级关系", prompt: "谁获得机会、谁被排除" }] },
  { id: "politics-culture", label: "政治文化", children: [{ id: "politics-factions", label: "势力", prompt: "谁在争夺决定权" }, { id: "politics-system", label: "制度", prompt: "权力如何被组织" }, { id: "politics-history", label: "历史", prompt: "过去留下了什么" }, { id: "politics-belief", label: "信仰", prompt: "人们相信什么" }, { id: "politics-custom", label: "习俗", prompt: "人们如何生活和表达" }] },
  { id: "story-engine", label: "故事发动机", children: [{ id: "engine-situation", label: "当前局势", prompt: "故事从什么失衡状态开始" }, { id: "engine-goal", label: "阶段目标", prompt: "主角下一步要完成什么" }, { id: "engine-antagonist", label: "反派与阻力", prompt: "谁会持续制造代价" }, { id: "engine-time", label: "时间压力", prompt: "为什么必须现在行动" }] },
] ;
const sections = sectionGroups.flatMap((group) => group.children);
const legacySectionByChild: Record<string, string> = {
  "story-theme": "story-core",
  "world-origin": "world-foundation",
  "society-species": "civilization",
  "politics-factions": "politics-culture",
  "engine-situation": "story-engine",
};
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
  const entities = useQuery({ queryKey: ["entities", true], queryFn: () => listEntities(true) });
  const entityRevisionQueries = useQueries({ queries: (entities.data ?? []).map((entity) => ({ queryKey: ["entity-revisions", entity.id], queryFn: () => listEntityRevisions(entity.id) })) });
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles });
  const [selectedId, setSelectedId] = useState<(typeof sections)[number]["id"]>("story-theme");
  const [form, setForm] = useState<PlanningSection>(emptySection("story-theme"));
  const [referencesText, setReferencesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [showFineTune, setShowFineTune] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiCandidate, setAiCandidate] = useState<Candidate | null>(null);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const selectedGroup = sectionGroups.find((group) => group.children.some((item) => item.id === selectedId));
  const completedCount = (storedSections.data ?? []).filter((section) => section.content.trim()).length;
  const chatProfile = profiles.data?.find((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const selectedMaterials = (materials.data ?? []).filter((item) => selectedMaterialIds.includes(item.id));
  const knowledgeRows = useMemo(() => (entities.data ?? []).map((entity, index) => ({ entity, revision: entityRevisionQueries[index]?.data?.find((item) => item.id === entity.currentRevisionId) ?? entityRevisionQueries[index]?.data?.[0] })).filter((item) => item.revision && item.entity.lifecycleStatus === "ACTIVE"), [entities.data, entityRevisionQueries]);
  const filteredKnowledge = knowledgeRows.filter(({ revision }) => { const query = knowledgeSearch.trim().toLocaleLowerCase(); return !query || revision!.name.toLocaleLowerCase().includes(query) || revision!.description.toLocaleLowerCase().includes(query); });
  const selectedKnowledge = knowledgeRows.filter(({ entity }) => selectedKnowledgeIds.includes(entity.id));
  const stored = storedSections.data?.find((section) => section.id === selectedId) ?? (legacySectionByChild[selectedId] ? storedSections.data?.find((section) => section.id === legacySectionByChild[selectedId]) : undefined);

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
    ...(starterCandidates[selectedId] ?? starterCandidates[selectedGroup?.id ?? ""] ?? []).map((item, index) => toCandidate(`starter-${selectedId}-${index}`, item)),
    ...materialCandidates(),
    ...(aiCandidate ? [aiCandidate] : []),
  ];

  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setReferencesText(next.references.join("\n"));
    setSelectedKnowledgeIds(next.references.map((item) => item.match(/^知识库：.+（[^，]+，([^）]+)）$/)?.[1]).filter((id): id is string => Boolean(id)));
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
      const knowledgeReferences = selectedKnowledge.map(({ entity, revision }) => `知识库：${revision!.name}（${entity.entityType}，${entity.id}）`);
      await savePlanningSection({
        ...form,
        id: selectedId,
        references: [...referencesText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).filter((item) => !item.startsWith("知识库：")), ...knowledgeReferences],
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

  function startWriting() {
    setSelectedCandidateId("manual");
    setForm({ id: selectedId, content: stored?.content ?? "", rationale: stored?.rationale ?? "", consequence: stored?.consequence ?? "", references: stored?.references ?? [], updatedAt: "" });
    setReferencesText((stored?.references ?? []).join("\n"));
    setShowFineTune(true);
    setNotice("已进入编写模式，可以直接记录你的想法");
  }

  async function importSectionFile(file: File) {
    try {
      const content = await file.text();
      setSelectedCandidateId("imported");
      setForm({ id: selectedId, content, rationale: "来自导入文件，请核对后保存。", consequence: "导入内容可继续补充为正式设定。", references: [file.name], updatedAt: "" });
      setReferencesText(file.name);
      setShowFineTune(true);
      setNotice(`已导入“${file.name}”，请确认后保存`);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function generateWithAi() {
    if (!chatProfile || !props.contextChapterId) return;
    setGenerating(true);
    setError(null);
    try {
      const existing = (storedSections.data ?? []).map((item) => `${item.id}: ${item.content}`).filter(Boolean).join("\n");
      const source = [...selectedMaterials.map((item) => item.content), ...selectedKnowledge.map(({ revision }) => `知识库实体：${revision!.name}\n${revision!.description}\n固定属性：${revision!.fixedAttributesJson}`)].join("\n");
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
          <h2>逐项建立小说要素</h2>
          <span className="story-planning-title-hint">每个细化节点都可以独立推导、编写或导入</span>
        </div>
        <span className="story-planning-progress">{completedCount} / {sections.length} 已完成</span>
      </div>
      <div className="story-planning-layout">
        <nav className="story-planning-sections" aria-label="设定模块">
          <div className="story-planning-sections-heading"><strong>小说要素</strong><span>逐项完善</span></div>
          {sectionGroups.map((group) => <div className="story-planning-group" key={group.id}><div className="story-planning-group-heading"><strong>{group.label}</strong><span>{group.children.filter((item) => storedSections.data?.find((storedItem) => storedItem.id === item.id)?.content.trim()).length}/{group.children.length}</span></div>{group.children.map((section) => { const completed = Boolean(storedSections.data?.find((item) => item.id === section.id)?.content.trim()); return <button key={section.id} type="button" data-active={selectedId === section.id || undefined} onClick={() => setSelectedId(section.id)}><span className="story-planning-section-index">{String(sections.findIndex((item) => item.id === section.id) + 1).padStart(2, "0")}</span><span className="story-planning-section-copy"><strong>{section.label}</strong><small>{section.prompt}</small></span><span className="story-planning-section-status" data-complete={completed || undefined}>{completed ? "完成" : "待填写"}</span></button>; })}</div>)}
        </nav>
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">{selectedGroup?.label} / 当前节点</span><h3>{selectedDefinition.label}</h3><p>{selectedDefinition.prompt}</p></div>
            <div className="story-planning-node-actions"><button type="button" className="secondary-action" onClick={() => void generateWithAi()} disabled={generating || !chatProfile || !props.contextChapterId}><Sparkles size={14} />{generating ? "推导中…" : "AI 推导"}</button><button type="button" className="secondary-action" onClick={startWriting}><PenLine size={14} />直接编写</button><label className="secondary-action story-planning-import"><FileUp size={14} />导入<input type="file" accept=".txt,.md,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSectionFile(file); event.currentTarget.value = ""; }} /></label></div>
          </div>
          <div className="story-planning-source-bar">
            <div><strong>先建立当前节点</strong><span>可以使用 AI 推导、直接编写，或从文件导入</span></div>
            <span className="story-planning-source-note">确认后再保存为正式设定</span>
          </div>
          {!chatProfile || !props.contextChapterId ? <p className="story-planning-ai-hint">配置聊天模型并创建章节后，可使用 AI 推导候选。</p> : null}
          <div className="story-planning-material-picker">
            <div className="story-planning-picker-heading"><strong>项目材料</strong><span>勾选后可从材料提炼</span></div>
            {materials.data?.length ? materials.data.map((item: SummaryMaterial) => <label key={item.id}><input type="checkbox" checked={selectedMaterialIds.includes(item.id)} onChange={(event) => setSelectedMaterialIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><span>{item.kind} · {item.precision}</span><small>{item.content.slice(0, 70)}{item.content.length > 70 ? "…" : ""}</small></label>) : <p>还没有可用材料，可先到资料库添加摘要。</p>}
          </div>
          <div className="story-planning-material-picker story-planning-knowledge-picker">
            <div className="story-planning-picker-heading"><strong>知识库</strong><span>把已积累的人物、地点和概念带入当前设定</span></div>
            <label className="knowledge-picker-search"><Search size={13} /><input value={knowledgeSearch} onChange={(event) => setKnowledgeSearch(event.target.value)} placeholder="搜索知识实体" aria-label="搜索知识实体" /></label>
            {filteredKnowledge.length ? filteredKnowledge.slice(0, 30).map(({ entity, revision }) => <label key={entity.id}><input type="checkbox" checked={selectedKnowledgeIds.includes(entity.id)} onChange={(event) => setSelectedKnowledgeIds((ids) => event.target.checked ? [...ids, entity.id] : ids.filter((id) => id !== entity.id))} /><span>{revision!.name}</span><small>{revision!.description || "暂无描述"}</small></label>) : <p>知识库还没有匹配实体，可先在知识页随时新增。</p>}
            {selectedKnowledge.length ? <div className="knowledge-picker-selected">已选 {selectedKnowledge.length} 项：{selectedKnowledge.map(({ revision }) => revision!.name).join("、")}</div> : null}
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
