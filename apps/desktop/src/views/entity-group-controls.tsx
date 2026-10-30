import { Check, FolderInput, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { entityTypeLabels } from "../lib/content-taxonomy";
import { type EntityGroupState, type EntityType, type updateEntityGroups } from "../lib/tauri-client";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import { WorkspacePanel } from "./workspace-panel";

export type EntityGroupAction = Parameters<typeof updateEntityGroups>[0]["action"];
export type GroupMoveTarget = { id: string; expectedVersion: number; entityType: EntityType };

export function EntityGroupDestination({ state, targets, disabled, batch = false, onMove }: {
  state: EntityGroupState; targets: GroupMoveTarget[]; disabled: boolean; batch?: boolean;
  onMove: (groupId: string | null, targets: GroupMoveTarget[]) => void;
}) {
  const [destination, setDestination] = useState("");
  const types = new Set(targets.map((target) => target.entityType));
  const options = state.groups.filter((group) => types.size === 1 && types.has(group.entityType));
  const groupId = destination === "ungrouped" ? null : destination;
  const canMove = destination !== "" && targets.some((target) =>
    (state.memberships.find((member) => member.entityId === target.id)?.groupId ?? null) !== groupId);
  return <div className="entity-move-actions">
    <label>移动到分组<select aria-label={batch ? "批量移动目标分组" : "实体移动目标分组"}
      value={destination} disabled={disabled || !targets.length} onChange={(event) => setDestination(event.target.value)}>
      <option value="">选择分组</option>
      <option value="ungrouped">未分组</option>
      {options.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
    </select></label>
    <button type="button" className="secondary-action" disabled={disabled || !canMove}
      onClick={() => onMove(groupId, targets)}><FolderInput size={14} />{batch ? "移动所选到分组" : "移动到分组"}</button>
  </div>;
}

export function EntityGroupManager({ state, initialType, pending, error, onAction, onClose }: {
  state: EntityGroupState; initialType: EntityType; pending: boolean; error: string | null;
  onAction: (action: EntityGroupAction) => Promise<boolean>; onClose: () => void;
}) {
  const [type, setType] = useState(initialType);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const groups = state.groups.filter((group) => group.entityType === type);
  const dirty = name !== (state.groups.find((group) => group.id === editingId)?.name ?? "");
  useUnsavedChangesGuard(dirty || pending, "分组名称尚未保存或正在修改分组。");
  function close() {
    if (pending || dirty && !window.confirm("放弃尚未保存的分组名称吗？")) return;
    onClose();
  }
  function cancelEdit() { setEditingId(null); setName(""); }
  return <WorkspacePanel open title="管理二级分组" className="entity-group-manager" onClose={close}>
    {error ? <p role="alert" className="project-error">{error}</p> : null}
    <form className="library-form" onSubmit={(event) => {
      event.preventDefault();
      void onAction(editingId ? { kind: "RENAME", id: editingId, name: name.trim() }
        : { kind: "CREATE", entityType: type, name: name.trim() }).then((saved) => { if (saved) cancelEdit(); });
    }}>
      <label>实体类型<select aria-label="分组所属类型" value={type} disabled={pending || editingId !== null}
        onChange={(event) => setType(event.target.value as EntityType)}>
        {Object.entries(entityTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>分组名称<input autoFocus aria-label="二级分组名称" maxLength={64} value={name} disabled={pending}
        onChange={(event) => setName(event.target.value)} /></label>
      <div className="library-actions">
        <button type="submit" className="primary-action" disabled={pending || !name.trim() || !dirty}>
          {editingId ? <Check size={14} /> : <Plus size={14} />}{editingId ? "保存名称" : "新建分组"}</button>
        {editingId ? <button type="button" className="secondary-action" disabled={pending} onClick={cancelEdit}><X size={14} />取消重命名</button> : null}
      </div>
    </form>
    <div className="entity-group-management-list">
      {groups.length ? groups.map((group) => <div className="entity-group-management-row" key={group.id}>
        <strong>{group.name}</strong>
        <span className="library-meta">{state.memberships.filter((member) => member.groupId === group.id).length}</span>
        <button type="button" className="icon-command" disabled={pending || dirty}
          title={`重命名分组「${group.name}」`} aria-label={`重命名分组「${group.name}」`}
          onClick={() => { setEditingId(group.id); setName(group.name); }}><Pencil size={14} /></button>
        <button type="button" className="icon-command entity-delete-action" disabled={pending || editingId === group.id}
          title={`删除分组「${group.name}」`} aria-label={`删除分组「${group.name}」`}
          onClick={() => void onAction({ kind: "DELETE", id: group.id })}><Trash2 size={14} /></button>
      </div>) : <p className="library-meta">暂无自定义分组</p>}
    </div>
  </WorkspacePanel>;
}
