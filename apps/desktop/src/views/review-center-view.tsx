import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, FileCheck2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { currentManuscript, getAuditFlowSettings, listPlanNodes, listPlanningSections } from "../lib/tauri-client";
import { AiWritingPanel } from "./ai-writing-panel";
import { KnowledgeReviewView } from "./knowledge-review-view";

type ReviewTab = "facts" | "admission" | "manuscript";

const reviewTabs = [
  { value: "admission", label: "创作准入", icon: ClipboardCheck },
  { value: "manuscript", label: "候选审核", icon: ShieldCheck },
  { value: "facts", label: "知识审核", icon: FileCheck2 },
] as const;

const candidateReviewTransferKey = "ainoveltools:candidate-review-transfer";

function nodePlanId(nodeId: string) {
  return `plan-node:${nodeId}`;
}

function initialReviewTab(): ReviewTab {
  const value = new URLSearchParams(window.location.search).get("tab");
  return value === "admission" || value === "manuscript" || value === "facts" ? value : "admission";
}

function candidateReviewDocument(chapterId: string) {
  try {
    const stored = window.sessionStorage.getItem(candidateReviewTransferKey);
    if (!stored) return "";
    const transfer = JSON.parse(stored) as { chapterId?: string; documentJson?: string };
    return transfer.chapterId === chapterId ? transfer.documentJson?.trim() ?? "" : "";
  } catch {
    return "";
  }
}

function initialChapterId() {
  return new URLSearchParams(window.location.search).get("chapterId") ?? "";
}

function syncReviewLocation(tab: ReviewTab, chapterId: string) {
  const params = new URLSearchParams(window.location.search);
  params.set("tab", tab);
  if (chapterId) params.set("chapterId", chapterId);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
}

export function ReviewCenterView() {
  const [tab, setTab] = useState<ReviewTab>(initialReviewTab);
  const [chapterId, setChapterId] = useState(initialChapterId);
  const [candidateDraft, setCandidateDraft] = useState("");
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const planningSections = useQuery({ queryKey: ["planning-sections"], queryFn: listPlanningSections });
  const auditFlow = useQuery({ queryKey: ["audit-flow-settings"], queryFn: getAuditFlowSettings });
  const enabledTabs = reviewTabs.filter(({ value }) => auditFlow.data?.[value === "facts" ? "knowledge" : value] !== false);
  useEffect(() => {
    if (!enabledTabs.some(({ value }) => value === tab)) setTab(enabledTabs[0]?.value ?? "admission");
  }, [enabledTabs, tab]);
  const chapterList = useMemo(() => (nodes.data ?? []).filter((node) => node.kind === "CHAPTER"), [nodes.data]);
  const selectedChapterId = chapterId || chapterList[0]?.id || "";
  const selectedChapter = chapterList.find((chapter) => chapter.id === selectedChapterId);
  const selectedVolume = selectedChapter
    ? (nodes.data ?? []).find((node) => node.id === selectedChapter.parentId && node.kind === "VOLUME")
    : undefined;
  const manuscript = useQuery({
    queryKey: ["manuscript", selectedChapterId],
    queryFn: () => currentManuscript(selectedChapterId),
    enabled: Boolean(selectedChapterId),
  });
  const chapterPlan = planningSections.data?.find((section) => section.id === nodePlanId(selectedChapterId))?.content ?? "";
  const volumePlan = selectedVolume
    ? planningSections.data?.find((section) => section.id === nodePlanId(selectedVolume.id))?.content ?? ""
    : "";

  useEffect(() => {
    setCandidateDraft(candidateReviewDocument(selectedChapterId));
  }, [selectedChapterId]);

  function selectTab(next: ReviewTab) {
    setTab(next);
    syncReviewLocation(next, selectedChapterId);
  }

  function selectChapter(nextChapterId: string) {
    setChapterId(nextChapterId);
    syncReviewLocation(tab, nextChapterId);
  }

  return <section className="review-center-view">
    <div className="workspace-heading">
      <p className="eyebrow">审核中心</p>
      <h1>审核</h1>
      <p className="workspace-lede">处理需要集中确认的事项：创作前确认准入，候选区内容集中审核，知识提取后确认事实。</p>
    </div>

    <ol className="review-flow" aria-label="审核流程">
      <li data-active={tab === "admission" || undefined}><strong>1. 创作准入</strong><span>生成正文前</span></li>
      <li data-active={tab === "manuscript" || undefined}><strong>2. 候选审核</strong><span>审核候选区快照</span></li>
      <li><strong>3. 知识提取</strong><span>从正式正文提取候选</span></li>
      <li data-active={tab === "facts" || undefined}><strong>4. 知识审核</strong><span>核对事实并定稿</span></li>
    </ol>
    <div className="review-center-tabs" role="tablist" aria-label="审核类型">
      {enabledTabs.map(({ value, label, icon: Icon }) => <button
        type="button"
        role="tab"
        aria-selected={tab === value}
        aria-controls={`review-panel-${value}`}
        id={`review-tab-${value}`}
        data-active={tab === value || undefined}
        key={value}
        onClick={() => selectTab(value)}
      >
        <Icon size={15} strokeWidth={1.8} />
        <span>{label}</span>
      </button>)}
    </div>

    <div className="review-center-context">
      <label>章节<select value={selectedChapterId} onChange={(event) => selectChapter(event.target.value)} disabled={!chapterList.length}>
        {!chapterList.length ? <option value="">暂无章节</option> : null}
        {chapterList.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
      </select></label>
      {selectedChapter ? <span>{selectedVolume ? `${selectedVolume.title} · ` : ""}{selectedChapter.title}</span> : null}
    </div>

    <div
      className="review-center-panel"
      id={`review-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`review-tab-${tab}`}
    >
      {tab === "admission" ? selectedChapter ? <AiWritingPanel
        key={`admission-${selectedChapter.id}`}
        mode="review"
        reviewPurpose="admission"
        chapterId={selectedChapter.id}
        chapterTitle={selectedChapter.title}
        chapterPlan={chapterPlan}
        volumeId={selectedVolume?.id ?? ""}
        volumePlan={volumePlan}
        draft={manuscript.data?.documentJson ?? ""}
        editor={null}
      /> : <div className="proposal-empty review-empty"><ClipboardCheck size={20} /><div><strong>暂无可审核章节</strong><span>建立章节后才能检查创作准入。</span></div></div> : null}
      {tab === "manuscript" ? selectedChapter && candidateDraft ? <AiWritingPanel
        key={`candidate-review-${selectedChapter.id}-${candidateDraft}`}
        mode="review"
        reviewPurpose="manuscript"
        chapterId={selectedChapter.id}
        chapterTitle={selectedChapter.title}
        chapterPlan={chapterPlan}
        volumeId={selectedVolume?.id ?? ""}
        volumePlan={volumePlan}
        draft={candidateDraft}
        editor={null}
      /> : <div className="proposal-empty review-empty"><ShieldCheck size={20} /><div><strong>暂无候选内容可审核</strong><span>请先在正文候选区编辑内容，再选择“审核当前候选”。</span></div></div> : null}
      {tab === "facts" ? <KnowledgeReviewView embedded chapterId={selectedChapterId} onChapterChange={selectChapter} /> : null}
    </div>
  </section>;
}
