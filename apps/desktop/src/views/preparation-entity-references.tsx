import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Link2, X } from "lucide-react";
import { entityHref } from "../lib/entity-navigation";
import { entityTypeLabels } from "../lib/content-taxonomy";
import { errorMessage, getCurrentProject, listEntityCards, type EntityType } from "../lib/tauri-client";
import { WorkspaceLink } from "./workspace-link";

const prefix = "preparation-entity:v1:";

export function usePreparationEntityReferences(types: EntityType[] | undefined, references: string[]) {
  const enabled = Boolean(types?.length);
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject, enabled });
  const cards = useQuery({ queryKey: ["entity-cards", true], queryFn: () => listEntityCards(true), enabled, retry: false });
  const ids = [...new Set(references.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)))];
  const current = (cards.data ?? []).filter((card) => card.entity.projectId === project.data?.projectId);
  const linked = ids.map((id) => ({ id, card: current.find((card) => card.entity.id === id) }));
  const available = current.filter((card) => card.entity.lifecycleStatus === "ACTIVE"
    && types?.includes(card.entity.entityType) && !ids.includes(card.entity.id));
  const context = linked.filter(({ card }) => card?.entity.lifecycleStatus === "ACTIVE").map(({ card }) =>
    `关联设定（当前版本 ${card!.revision.revision}）：${card!.revision.name}\n${card!.revision.description}\n固定属性：${card!.revision.fixedAttributesJson}`).join("\n\n");
  const ready = ids.length === 0 || cards.isSuccess && project.isSuccess
    && linked.every(({ card }) => card?.entity.lifecycleStatus === "ACTIVE");
  return { cards, project, ids, linked, available, context, ready };
}

export function PreparationEntityReferences({ model, references, disabled, readOnly, onChange }: {
  model: ReturnType<typeof usePreparationEntityReferences>;
  references: string[]; disabled: boolean; readOnly: boolean; onChange?: (references: string[]) => void;
}) {
  const { cards, project, linked, available } = model;
  return <section className="preparation-entity-references" aria-label="关联资料">
    <div className="preparation-reference-heading"><span><Link2 size={14} />关联资料</span>
      {project.data ? <WorkspaceLink href={`/knowledge?targetProject=${encodeURIComponent(project.data.projectId)}`}>
        设定资料<ArrowUpRight size={13} /></WorkspaceLink> : null}
    </div>
    {cards.isError || project.isError ? <p role="alert">无法读取关联资料：{errorMessage(cards.error ?? project.error)}
      <button type="button" onClick={() => void Promise.all([cards.refetch(), project.refetch()])}>重试</button></p>
      : cards.isPending || project.isPending ? <p role="status">正在读取关联资料…</p>
      : <>
        {linked.map(({ id, card }) => <div className="preparation-reference-row" key={id}>
          {card && project.data ? <details>
            <summary>{card.revision.name}<small>{entityTypeLabels[card.entity.entityType]} · v{card.revision.revision}
              {card.entity.lifecycleStatus === "ARCHIVED" ? " · 已停用" : ""}</small></summary>
            <p>{card.revision.description}</p>
            <WorkspaceLink href={entityHref(id, project.data.projectId)}>查看资料<ArrowUpRight size={12} /></WorkspaceLink>
          </details> : <span>关联资料已不可用</span>}
          {!readOnly ? <button type="button" title="取消关联" aria-label={`取消关联${card?.revision.name ?? "不可用资料"}`}
            disabled={disabled} onClick={() => onChange?.(references.filter((entry) => entry !== prefix + id))}><X size={14} /></button> : null}
        </div>)}
        {!readOnly ? <select aria-label="添加关联资料" value="" disabled={disabled || !available.length}
          onChange={(event) => { if (event.target.value) onChange?.([...references, prefix + event.target.value]); }}>
          <option value="">{available.length ? "选择已有资料…" : "暂无可关联资料"}</option>
          {available.map((card) => <option key={card.entity.id} value={card.entity.id}>
            {card.revision.name} · {entityTypeLabels[card.entity.entityType]}
          </option>)}
        </select> : null}
      </>}
  </section>;
}
