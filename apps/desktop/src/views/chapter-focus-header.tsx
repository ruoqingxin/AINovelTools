import { ArchiveRestore, BookOpen, Check, ChevronLeft, ChevronRight, Plus, Search, Settings2, Trash2 } from "lucide-react";
import type { PlanNode } from "../lib/tauri-client";
import { kindLabels } from "./project-workspace-utils";

type ChapterFocusHeaderProps = {
  canMoveToRoot: boolean;
  chapterDirty: boolean;
  chapterJumpOptions: PlanNode[];
  chapterNodes: PlanNode[];
  chapterSearch: string;
  editTitle: string;
  manuscriptReady: boolean;
  moveCandidates: PlanNode[];
  moveParentId: string;
  nextChapter: PlanNode | null;
  onDelete: () => Promise<void>;
  onEditTitleChange: (value: string) => void;
  onMove: () => Promise<void>;
  onMoveParentChange: (value: string) => void;
  onCreateScene: (chapterId: string) => Promise<void>;
  onSave: () => Promise<void>;
  onSearchChange: (value: string) => void;
  onSelectNode: (node: PlanNode) => boolean | void;
  onToggleArchived: (node: PlanNode) => Promise<void>;
  previousChapter: PlanNode | null;
  savingDraft: boolean;
  selected: PlanNode;
  selectedChapterIndex: number;
  selectedVolume: PlanNode | undefined;
  workspaceMode: "planning" | "chapters" | "writing";
};

export function ChapterFocusHeader(props: ChapterFocusHeaderProps) {
  const copyButtonLabel = props.savingDraft ? "同步中…" : props.chapterDirty ? props.workspaceMode === "writing" ? "候选待同步" : "候选有修改" : props.manuscriptReady ? "正文已保存" : "正文尚未生成";
  return <div className="chapter-focus-header">
    <div className="chapter-focus-copy">
      <span>{props.selectedVolume ? `${props.selectedVolume.title} · ` : ""}第 {props.selectedChapterIndex + 1} / {props.chapterNodes.length} 章</span>
      <div><h2>{props.selected.title}</h2><span className="save-state" data-state={props.savingDraft ? "saving" : props.chapterDirty ? "dirty" : props.manuscriptReady ? "saved" : "empty"}>{copyButtonLabel}</span></div>
    </div>
    <div className="chapter-focus-actions">
      <button type="button" className="icon-command" onClick={() => props.previousChapter && props.onSelectNode(props.previousChapter)} disabled={!props.previousChapter} aria-label="上一章" title="上一章"><ChevronLeft size={16} /></button>
      {props.workspaceMode === "writing" ? <details className="chapter-jump-menu"><summary><Search size={14} />查找章节</summary><div className="chapter-jump-panel">
        <label><Search size={14} /><input value={props.chapterSearch} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="输入章节名称" aria-label="搜索章节" /></label>
        <div>{props.chapterJumpOptions.length ? props.chapterJumpOptions.map((chapter) => <button type="button" data-selected={chapter.id === props.selected.id || undefined} key={chapter.id} onClick={(event) => { if (props.onSelectNode(chapter)) { props.onSearchChange(""); event.currentTarget.closest("details")?.removeAttribute("open"); } }}><span>第 {props.chapterNodes.findIndex((item) => item.id === chapter.id) + 1} 章</span><strong>{chapter.title}</strong></button>) : <p>没有找到匹配章节</p>}</div>
      </div></details> : null}
      <button type="button" className="icon-command" onClick={() => props.nextChapter && props.onSelectNode(props.nextChapter)} disabled={!props.nextChapter} aria-label="下一章" title="下一章"><ChevronRight size={16} /></button>
      {props.workspaceMode === "chapters" ? <><a className="secondary-action" href={`/writing#${props.selected.id}`}><BookOpen size={14} />写正文</a><button type="button" className="secondary-action" onClick={() => void props.onCreateScene(props.selected.id)}><Plus size={14} />拆分场景</button><details className="chapter-settings-menu"><summary><Settings2 size={15} />章节设置</summary><div className="chapter-settings-panel">
        <label>章节名称<input value={props.editTitle} onChange={(event) => props.onEditTitleChange(event.target.value)} aria-label="编辑节点标题" /></label>
        <label>所属分卷<select value={props.moveParentId} onChange={(event) => props.onMoveParentChange(event.target.value)} aria-label="移动到父节点"><option value="" disabled={!props.canMoveToRoot}>{props.canMoveToRoot ? "顶层" : "选择父节点"}</option>{props.moveCandidates.map((node) => <option key={node.id} value={node.id}>{kindLabels[node.kind]} · {node.title}</option>)}</select></label>
        <div><button type="button" className="primary-action" onClick={() => void props.onSave()} disabled={!props.editTitle.trim()}><Check size={14} />保存名称</button><button type="button" className="secondary-action" onClick={() => void props.onMove()} disabled={!props.canMoveToRoot && !props.moveParentId}>移动章节</button>{props.selected.archived ? <button type="button" className="secondary-action" onClick={() => void props.onToggleArchived(props.selected)}><ArchiveRestore size={14} />恢复</button> : <button type="button" className="secondary-action destructive-action" onClick={() => void props.onDelete()}><Trash2 size={14} />删除</button>}</div>
      </div></details></> : null}
    </div>
  </div>;
}
