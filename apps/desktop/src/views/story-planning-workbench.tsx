import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileUp, Save, Search, Sparkles, PenLine } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  errorMessage,
  generatePlanningContent,
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

export const planningSectionGroups: PlanningGroup[] = [
  { id: "story-core", label: "故事核心", children: [{ id: "story-theme", label: "主题与题材", prompt: "这部小说想讨论什么" }, { id: "story-protagonist", label: "主角与欲望", prompt: "主角想得到什么" }, { id: "story-conflict", label: "核心冲突", prompt: "什么力量阻碍主角" }] },
  { id: "world-foundation", label: "世界基础", children: [{ id: "world-origin", label: "起源", prompt: "世界从何而来" }, { id: "world-rules", label: "规则", prompt: "世界如何运行" }, { id: "world-space", label: "空间", prompt: "故事发生在哪里" }, { id: "world-geography", label: "地理", prompt: "地点如何分布和连接" }, { id: "world-resources", label: "资源", prompt: "什么稀缺、谁掌握它" }] },
  { id: "civilization", label: "文明社会", children: [{ id: "society-species", label: "种族与群体", prompt: "谁生活在这个世界" }, { id: "society-power", label: "力量体系", prompt: "力量从哪里来" }, { id: "society-production", label: "生产方式", prompt: "社会如何生产和交换" }, { id: "society-economy", label: "经济", prompt: "财富如何流动" }, { id: "society-class", label: "阶级关系", prompt: "谁获得机会、谁被排除" }] },
  { id: "politics-culture", label: "政治文化", children: [{ id: "politics-factions", label: "势力", prompt: "谁在争夺决定权" }, { id: "politics-system", label: "制度", prompt: "权力如何被组织" }, { id: "politics-history", label: "历史", prompt: "过去留下了什么" }, { id: "politics-belief", label: "信仰", prompt: "人们相信什么" }, { id: "politics-custom", label: "习俗", prompt: "人们如何生活和表达" }] },
  { id: "story-engine", label: "故事发动机", children: [{ id: "engine-situation", label: "当前局势", prompt: "故事从什么失衡状态开始" }, { id: "engine-goal", label: "阶段目标", prompt: "主角下一步要完成什么" }, { id: "engine-antagonist", label: "反派与阻力", prompt: "谁会持续制造代价" }, { id: "engine-time", label: "时间压力", prompt: "为什么必须现在行动" }] },
] ;
const sections = planningSectionGroups.flatMap((group) => group.children);
const legacySectionByChild: Record<string, string> = {
  "story-theme": "story-core",
  "world-origin": "world-foundation",
  "society-species": "civilization",
  "politics-factions": "politics-culture",
  "engine-situation": "story-engine",
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
  selectedSectionId?: string;
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
  const selectedId = props.selectedSectionId ?? "story-theme";
  const [form, setForm] = useState<PlanningSection>(emptySection(selectedId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const [showReferences, setShowReferences] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const selectedDefinition = sections.find((section) => section.id === selectedId) ?? sections[0];
  const selectedGroup = planningSectionGroups.find((group) => group.children.some((item) => item.id === selectedId));
  const completedCount = (storedSections.data ?? []).filter((section) => section.content.trim()).length;
  const chatProfile = profiles.data?.find((profile) => profile.capability === "CHAT" && profile.hasSecret);
  const selectedMaterials = (materials.data ?? []).filter((item) => selectedMaterialIds.includes(item.id));
  const knowledgeRows = useMemo(() => (entities.data ?? []).map((entity, index) => ({ entity, revision: entityRevisionQueries[index]?.data?.find((item) => item.id === entity.currentRevisionId) ?? entityRevisionQueries[index]?.data?.[0] })).filter((item) => item.revision && item.entity.lifecycleStatus === "ACTIVE"), [entities.data, entityRevisionQueries]);
  const filteredKnowledge = knowledgeRows.filter(({ revision }) => { const query = knowledgeSearch.trim().toLocaleLowerCase(); return !query || revision!.name.toLocaleLowerCase().includes(query) || revision!.description.toLocaleLowerCase().includes(query); });
  const selectedKnowledge = knowledgeRows.filter(({ entity }) => selectedKnowledgeIds.includes(entity.id));
  const stored = storedSections.data?.find((section) => section.id === selectedId) ?? (legacySectionByChild[selectedId] ? storedSections.data?.find((section) => section.id === legacySectionByChild[selectedId]) : undefined);

  useEffect(() => {
    const stored = storedSections.data?.find((section) => section.id === selectedId) ?? (legacySectionByChild[selectedId] ? storedSections.data?.find((section) => section.id === legacySectionByChild[selectedId]) : undefined);
    const next = stored ?? emptySection(selectedId);
    setForm(next);
    setSelectedKnowledgeIds(next.references.map((item) => item.match(/^知识库：.+（[^，]+，([^）]+)）$/)?.[1]).filter((id): id is string => Boolean(id)));
    setError(null);
    setNotice(null);
    setShowEditor(Boolean(next.content.trim()));
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
        references: [...form.references.filter((item) => !item.startsWith("知识库：")), ...knowledgeReferences],
      });
      await client.invalidateQueries({ queryKey: ["planning-sections"] });
      setNotice("设定已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function startWriting() {
    setForm({ id: selectedId, content: stored?.content ?? "", rationale: stored?.rationale ?? "", consequence: stored?.consequence ?? "", references: stored?.references ?? [], updatedAt: "" });
    setShowEditor(true);
    setNotice("已进入编写模式，可以直接记录你的想法");
  }

  async function importSectionFile(file: File) {
    if (!chatProfile) { setError("请先在设置中配置一个可用的聊天模型"); return; }
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const content = await file.text();
      const extracted = await generatePlanningContent({ profileId: chatProfile.id, mode: "EXTRACT", sectionTitle: selectedDefinition.label, sectionPrompt: selectedDefinition.prompt, existingContext: "", referenceContent: content });
      setForm({ id: selectedId, content: extracted, rationale: "", consequence: "", references: [file.name], updatedAt: "" });
      setShowEditor(true);
      setNotice(`已从“${file.name}”提取与“${selectedDefinition.label}”相关的内容，请确认后保存`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setImporting(false); }
  }

  async function generateWithAi() {
    if (!chatProfile) return;
    setGenerating(true);
    setError(null);
    try {
      const existing = (storedSections.data ?? []).map((item) => `${item.id}: ${item.content}`).filter(Boolean).join("\n");
      const source = [...selectedMaterials.map((item) => item.content), ...selectedKnowledge.map(({ revision }) => `知识库实体：${revision!.name}\n${revision!.description}\n固定属性：${revision!.fixedAttributesJson}`)].join("\n");
      const output = await generatePlanningContent({
        profileId: chatProfile.id,
        mode: "GENERATE",
        sectionTitle: selectedDefinition.label,
        sectionPrompt: selectedDefinition.prompt,
        existingContext: existing,
        referenceContent: source,
      });
      setForm({ id: selectedId, content: output, rationale: "", consequence: "", references: selectedMaterials.map((item) => item.sourceVersion ?? "项目材料"), updatedAt: "" });
      setShowEditor(true);
      setNotice("AI 内容已生成，可以直接修改并保存");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setGenerating(false); }
  }

  return (
    <section className="story-planning-workbench" aria-label="作品设定工作台">
      <div className="story-planning-titlebar">
        <div>
          <p className="eyebrow">作品设计</p>
          <h2>逐项建立小说要素</h2>
          <span className="story-planning-title-hint">每个细化节点都可以独立推导、编写或导入</span>
        </div>
        <span className="story-planning-progress">{completedCount} / {sections.length} 已完成</span>
      </div>
      <div className="story-planning-layout story-planning-layout-editor-only">
        <div className="story-planning-editor">
          <div className="story-planning-editor-heading">
            <div><span className="story-planning-current-label">{selectedGroup?.label} / 当前节点</span><h3>{selectedDefinition.label}</h3><p>{selectedDefinition.prompt}</p></div>
          </div>
          <div className="story-planning-action-panel">
            <div className="story-planning-action-heading"><div><strong>建立当前节点</strong><span>选择一种开始方式</span></div><small>内容确认后再保存</small></div>
            <div className="story-planning-action-choices">
              <button type="button" className="story-planning-action-choice action-choice-primary" onClick={startWriting}><PenLine size={17} /><span><strong>直接编写</strong><small>从自己的想法开始</small></span></button>
              <button type="button" className="story-planning-action-choice" onClick={() => void generateWithAi()} disabled={generating || !chatProfile}><Sparkles size={17} /><span><strong>{generating ? "正在推导" : "AI 推导"}</strong><small>结合已有设定生成内容</small></span></button>
              <label className="story-planning-action-choice story-planning-import" data-disabled={importing || !chatProfile || undefined}><FileUp size={17} /><span><strong>{importing ? "正在提取" : "AI 提取文件"}</strong><small>仅保留符合当前节点的内容</small></span><input type="file" accept=".txt,.md,.json" disabled={importing || !chatProfile} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSectionFile(file); event.currentTarget.value = ""; }} /></label>
            </div>
          </div>
          {!chatProfile ? <p className="story-planning-ai-hint">请先在设置中配置一个可用的聊天模型。</p> : null}
          <div className="story-planning-references">
            <button type="button" className="story-planning-references-toggle" aria-expanded={showReferences} onClick={() => setShowReferences((value) => !value)}>{showReferences ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span><strong>参考内容</strong><small>选择项目材料和知识库内容，供 AI 推导或编写时参考</small></span><em>{selectedMaterialIds.length + selectedKnowledgeIds.length ? `已选 ${selectedMaterialIds.length + selectedKnowledgeIds.length} 项` : "可选"}</em></button>
            {showReferences ? <div className="story-planning-reference-content"><div className="story-planning-material-picker"><div className="story-planning-picker-heading"><strong>项目材料</strong><span>勾选后可从材料提炼</span></div>{materials.data?.length ? materials.data.map((item: SummaryMaterial) => <label key={item.id}><input type="checkbox" checked={selectedMaterialIds.includes(item.id)} onChange={(event) => setSelectedMaterialIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><span>{item.kind} · {item.precision}</span><small>{item.content.slice(0, 70)}{item.content.length > 70 ? "…" : ""}</small></label>) : <p>还没有可用材料，可先到资料库添加摘要。</p>}</div><div className="story-planning-material-picker story-planning-knowledge-picker"><div className="story-planning-picker-heading"><strong>知识库</strong><span>选择人物、地点和概念</span></div><label className="knowledge-picker-search"><Search size={13} /><input value={knowledgeSearch} onChange={(event) => setKnowledgeSearch(event.target.value)} placeholder="搜索知识实体" aria-label="搜索知识实体" /></label>{filteredKnowledge.length ? filteredKnowledge.slice(0, 30).map(({ entity, revision }) => <label key={entity.id}><input type="checkbox" checked={selectedKnowledgeIds.includes(entity.id)} onChange={(event) => setSelectedKnowledgeIds((ids) => event.target.checked ? [...ids, entity.id] : ids.filter((id) => id !== entity.id))} /><span>{revision!.name}</span><small>{revision!.description || "暂无描述"}</small></label>) : <p>知识库还没有匹配实体。</p>}{selectedKnowledge.length ? <div className="knowledge-picker-selected">已选：{selectedKnowledge.map(({ revision }) => revision!.name).join("、")}</div> : null}</div></div> : null}
          </div>
          {showEditor ? <div className="story-planning-content-editor"><label><span>设定内容</span><small>把当前要素写清楚即可，之后随时可以继续修改</small><textarea rows={12} autoFocus value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} placeholder={`填写${selectedDefinition.label}…`} /></label><div className="story-planning-actions"><button type="button" className="primary-action" onClick={() => void save()} disabled={saving || !form.content.trim()}><Save size={15} />{saving ? "保存中…" : "保存设定"}</button>{notice ? <span className="project-notice">{notice}</span> : null}{error ? <span className="project-error" role="alert">{error}</span> : null}</div></div> : null}
        </div>
      </div>
    </section>
  );
}
