import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus } from "lucide-react";
import { useState } from "react";
import { createPlanNode, listPlanNodes, type PlanNodeKind } from "../lib/tauri-client";

const kindLabels: Record<PlanNodeKind, string> = {
  WORK_DESIGN: "作品设计",
  OUTLINE: "总纲",
  VOLUME: "分卷",
  CHAPTER: "章节",
  SCENE: "场景",
};

export function ProjectWorkspaceView() {
  const client = useQueryClient();
  const nodes = useQuery({ queryKey: ["plan-nodes"], queryFn: listPlanNodes });
  const [kind, setKind] = useState<PlanNodeKind>("CHAPTER");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function addNode() {
    if (!title.trim()) return;
    setError(null);
    try {
      await createPlanNode({ kind, title: title.trim() });
      setTitle("");
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="project-workspace">
      <div className="workspace-heading">
        <p className="eyebrow">规划工作区</p>
        <h1>开始搭建你的故事</h1>
        <p className="workspace-lede">先建立作品设计、分卷和章节结构，规划与正文会保持清晰分离。</p>
      </div>

      <div className="plan-create-row">
        <select value={kind} onChange={(event) => setKind(event.target.value as PlanNodeKind)} aria-label="节点类型">
          {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addNode(); }} placeholder="例如：第一卷·启程" aria-label="节点标题" />
        <button type="button" className="primary-action" onClick={() => void addNode()} disabled={!title.trim()}><Plus size={16} />新建节点</button>
      </div>
      {error ? <p className="project-error" role="alert">{error}</p> : null}

      <div className="plan-tree" aria-label="规划树">
        <div className="section-heading"><h2>规划树</h2><span>{nodes.data?.length ?? 0} 个节点</span></div>
        {nodes.isPending ? <p className="plan-empty">正在加载规划…</p> : null}
        {nodes.isError ? <p className="project-error" role="alert">无法加载规划：{String(nodes.error)}</p> : null}
        {nodes.data?.length === 0 ? <div className="plan-empty"><BookOpen size={20} /><p>还没有规划节点，从上方创建第一章吧。</p></div> : null}
        {nodes.data?.map((node) => <div className="plan-row" key={node.id}><span className="plan-kind">{kindLabels[node.kind]}</span><span>{node.title}</span></div>)}
      </div>
    </section>
  );
}
