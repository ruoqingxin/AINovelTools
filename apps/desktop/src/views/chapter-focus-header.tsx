import { ArchiveRestore, Check, ChevronLeft, ChevronRight, Plus, Settings2, Trash2 } from "lucide-react";
import type { PlanNode } from "../lib/tauri-client";
import { kindLabels } from "./project-workspace-utils";
import { useInAiWorkspace } from "./content-identity";

type ChapterFocusHeaderProps = {
  canMoveToRoot: boolean;
  chapterNodes: PlanNode[];
  editTitle: string;
  moveCandidates: PlanNode[];
  moveParentId: string;
  nextChapter: PlanNode | null;
  onDelete: () => Promise<void>;
  onEditTitleChange: (value: string) => void;
  onMove: () => Promise<void>;
  onMoveParentChange: (value: string) => void;
  onCreateScene: (chapterId: string) => Promise<void>;
  onSave: () => Promise<void>;
  onSelectNode: (node: PlanNode) => boolean | void;
  onToggleArchived: (node: PlanNode) => Promise<void>;
  previousChapter: PlanNode | null;
  selected: PlanNode;
  selectedChapterIndex: number;
  selectedVolume: PlanNode | undefined;
  workspaceMode: "planning" | "chapters" | "writing";
};

export function ChapterFocusHeader(props: ChapterFocusHeaderProps) {
  const aiWorkspace = useInAiWorkspace();
  return <div className="chapter-focus-header">
    <div className="chapter-focus-copy">
      <span>{props.selectedVolume ? `${props.selectedVolume.title} · ` : ""}第 {props.selectedChapterIndex + 1} / {props.chapterNodes.length} 章</span>
      <div><h2>{props.selected.title}</h2></div>
    </div>
    <div className="chapter-focus-actions">
      <button type="button" className="icon-command" onClick={() => props.previousChapter && props.onSelectNode(props.previousChapter)} disabled={!props.previousChapter} aria-label="上一章" title="上一章"><ChevronLeft size={16} /></button>
      <button type="button" className="icon-command" onClick={() => props.nextChapter && props.onSelectNode(props.nextChapter)} disabled={!props.nextChapter} aria-label="下一章" title="下一章"><ChevronRight size={16} /></button>
      {aiWorkspace && props.workspaceMode !== "planning" ? <>{props.workspaceMode === "chapters" ? <button type="button" className="secondary-action" onClick={() => void props.onCreateScene(props.selected.id)}><Plus size={14} />拆分场景</button> : null}<details className="chapter-settings-menu"><summary aria-label="章节设置" title="章节设置"><Settings2 size={15} /><span>章节设置</span></summary><div className="chapter-settings-panel">
        <label>章节名称<input value={props.editTitle} onChange={(event) => props.onEditTitleChange(event.target.value)} aria-label="编辑节点标题" /></label>
        <label>所属分卷<select value={props.moveParentId} onChange={(event) => props.onMoveParentChange(event.target.value)} aria-label="移动到父节点"><option value="" disabled={!props.canMoveToRoot}>{props.canMoveToRoot ? "顶层" : "选择父节点"}</option>{props.moveCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select></label>
        <div><button type="button" className="primary-action" onClick={() => void props.onSave()} disabled={!props.editTitle.trim()}><Check size={14} />保存名称</button><button type="button" className="secondary-action" onClick={() => void props.onMove()} disabled={!props.canMoveToRoot && !props.moveParentId}>移动章节</button>{props.selected.archived ? <button type="button" className="secondary-action" onClick={() => void props.onToggleArchived(props.selected)}><ArchiveRestore size={14} />恢复</button> : <button type="button" className="secondary-action destructive-action" onClick={() => void props.onDelete()}><Trash2 size={14} />删除</button>}</div>
      </div></details></> : null}
    </div>
  </div>;
}
