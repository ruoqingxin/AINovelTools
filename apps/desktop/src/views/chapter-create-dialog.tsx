import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage, type PlanNode } from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { createChapter } from "./create-chapter";
import { WorkspacePanel } from "./workspace-panel";
import { useConfirmAction } from "../shell/confirm-action-provider";

export function ChapterCreateDialog({ projectId, nodes, volumeId, onClose, onCreated }: {
  projectId: string; nodes: PlanNode[]; volumeId?: string; onClose: () => void; onCreated: (node: PlanNode) => void;
}) {
  const client = useQueryClient();
  const confirmAction = useConfirmAction();
  const inFlight = useRef(false);
  const closing = useRef(false);
  const volumes = nodes.filter((node) => node.kind === "VOLUME" && !node.archived);
  const defaultTitle = `第${nodes.filter((node) => node.kind === "CHAPTER" && !node.archived).length + 1}章`;
  const [title, setTitle] = useState(defaultTitle);
  const defaultParent = volumeId ?? volumes[0]?.id ?? "";
  const [parent, setParent] = useState(defaultParent);
  const [volumeTitle, setVolumeTitle] = useState("第一卷");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = title !== defaultTitle || volumeTitle !== "第一卷" || parent !== defaultParent;
  const latest = useRef<{ title: string; parent: string; volumeTitle: string; projectId: string } | null>(null);
  latest.current = { title, parent, volumeTitle, projectId };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useUnsavedChangesGuard(busy || dirty, busy ? "章节正在创建。" : "章节信息尚未创建。");
  async function close() {
    if (inFlight.current || closing.current) return;
    const expected = latest.current;
    closing.current = true;
    try {
      if (dirty && !await confirmAction({ message: "放弃尚未创建的章节信息吗？", confirmLabel: "放弃章节信息" })) return;
      const current = latest.current;
      if (!mounted.current || !current || inFlight.current || current.projectId !== expected?.projectId) return;
      if (current.title !== expected.title || current.parent !== expected.parent || current.volumeTitle !== expected.volumeTitle) {
        setError("确认期间章节信息已变化，已保留当前输入。请重新确认。"); return;
      }
      onClose();
    } finally { closing.current = false; }
  }
  async function submit() {
    if (inFlight.current || closing.current || !title.trim() || !parent && !volumeTitle.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const node = await createChapter({ projectId, title, volumeId: parent || undefined, newVolumeTitle: volumeTitle });
      await client.invalidateQueries({ queryKey: ["plan-nodes"] });
      onCreated(node);
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
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
