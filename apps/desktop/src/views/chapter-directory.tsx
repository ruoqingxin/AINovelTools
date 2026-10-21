import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import type { PlanNode } from "../lib/tauri-client";
import { SearchField } from "./search-field";

export function ChapterDirectory({ nodes, selectedId, onSelect, onCreate, showScenes = false }: {
  nodes: PlanNode[]; selectedId: string | null; onSelect: (node: PlanNode) => void; onCreate: () => void;
  showScenes?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const chapters = nodes.filter((node) => node.kind === "CHAPTER");
  const volumes = nodes.filter((node) => node.kind === "VOLUME");
  const matched = chapters.filter((node) => node.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  function chapterRow(node: PlanNode) {
    return <div key={node.id}><button type="button" className="directory-chapter" title={node.title}
      data-selected={selectedId === node.id} data-archived={node.archived}
      onClick={() => onSelect(node)}>{node.title}</button>
      {showScenes ? nodes.filter((item) => item.kind === "SCENE" && item.parentId === node.id).map((scene) => <button type="button" key={scene.id}
        className="directory-chapter directory-scene" data-selected={selectedId === scene.id} onClick={() => onSelect(scene)}>{scene.title}</button>) : null}</div>;
  }
  return <div className="chapter-directory">
    <div className="directory-toolbar">
      <SearchField label="搜索章节" value={search} onChange={setSearch} />
      <button type="button" className="icon-command" aria-label="新建章节" title="新建章节" onClick={onCreate}><Plus size={17} /></button>
    </div>
    {volumes.map((volume) => {
      const items = matched.filter((node) => node.parentId === volume.id);
      if (search && !items.length) return null;
      const expanded = Boolean(search) || !collapsed.has(volume.id);
      return <div className="directory-volume" key={volume.id}>
        <div><button type="button" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${volume.title}`}
          title={`${expanded ? "收起" : "展开"}${volume.title}`} className="directory-volume-toggle" onClick={() => setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(volume.id)) next.delete(volume.id); else next.add(volume.id);
          return next;
        })}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          <button type="button" className="directory-volume-name" data-selected={selectedId === volume.id}
            title={volume.title} onClick={() => onSelect(volume)}>{volume.title}</button><small>{items.length}</small></div>
        {expanded ? items.map(chapterRow) : null}
      </div>;
    })}
    {matched.filter((node) => !volumes.some((volume) => volume.id === node.parentId)).map(chapterRow)}
    {!matched.length ? <p className="plan-empty">{search ? "没有匹配章节" : "暂无章节"}</p> : null}
  </div>;
}
