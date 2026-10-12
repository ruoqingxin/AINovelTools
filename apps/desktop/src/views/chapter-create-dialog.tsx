import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, type PlanNode } from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { createChapter } from "./create-chapter";
import { WorkspacePanel } from "./workspace-panel";

export function ChapterCreateDialog({ projectId, nodes, volumeId, onClose, onCreated }: {
  projectId: string; nodes: PlanNode[]; volumeId?: string; onClose: () => void; onCreated: (node: PlanNode) => void;
}) {
  const client = useQueryClient();
  const volumes = nodes.filter((node) => node.kind === "VOLUME" && !node.archived);
  const defaultTitle = `第${nodes.filter((node) => node.kind === "CHAPTER" && !node.archived).length + 1}章`;
  const [title, setTitle] = useState(defaultTitle);
  const defaultParent = volumeId ?? volumes[0]?.id ?? "";
  const [parent, setParent] = useState(defaultParent);
  const [volumeTitle, setVolumeTitle] = useState("第一卷");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = title !== defaultTitle || volumeTitle !== "第一卷" || parent !== defaultParent;
  useUnsavedChangesGuard(busy || dirty, busy ? "章节正在创建。" : "章节信息尚未创建。");
  function close() {
    if (busy) return;
    if (dirty && !window.confirm("放弃尚未创建的章节信息吗？")) return;
    onClose();
  }
  async function submit() {
    if (busy || !title.trim() || !parent && !volumeTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const node = await createChapter({ projectId, title, volumeId: parent || undefined, newVolumeTitle: volumeTitle });
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
      onCreated(node);
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <WorkspacePanel open title="新建章节" onClose={close} className="chapter-create-dialog">
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="chapter-create-form">
      <label>章节名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
      <label>所属分卷<select value={parent} onChange={(event) => setParent(event.target.value)} disabled={busy}>
        {volumes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}<option value="">新建分卷</option>
      </select></label>
      {!parent ? <label>分卷名称<input value={volumeTitle} onChange={(event) => setVolumeTitle(event.target.value)} disabled={busy} /></label> : null}
      {error ? <p role="alert" className="project-error">{error}</p> : null}
      <div className="inspector-actions"><button type="submit" className="primary-action" disabled={busy || !title.trim() || !parent && !volumeTitle.trim()}>
        <Plus size={15} />{busy ? "创建中…" : "创建章节"}</button><button type="button" className="secondary-action" disabled={busy} onClick={close}>取消</button></div>
    </form>
  </WorkspacePanel>;
}
