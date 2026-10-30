import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { ImportCandidate } from "../lib/entity-import-review";
import type { EntityCard } from "../lib/tauri-client";
import { SearchField } from "./search-field";

export function EntityImportDestination({ index, item, matches, cards, onChange }: {
  index: number;
  item: ImportCandidate;
  matches: EntityCard[];
  cards: EntityCard[];
  onChange: (value: Pick<ImportCandidate, "selected" | "mergeTarget">) => void;
}) {
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const target = cards.find((card) => card.entity.id === item.mergeTarget?.id);
  const targetAvailable = target?.entity.entityType === item.entityType && target.entity.lifecycleStatus === "ACTIVE";
  const stale = item.selected && item.mergeTarget && target && (
    target.entity.version !== item.mergeTarget.expectedVersion || target.revision.id !== item.mergeTarget.expectedRevisionId);
  const query = search.normalize("NFKC").trim().toLocaleLowerCase();
  const matchIds = new Set(matches.map((card) => card.entity.id));
  const results = searchOpen && query ? cards.filter((card) =>
    card.entity.entityType === item.entityType && card.entity.lifecycleStatus === "ACTIVE"
    && !matchIds.has(card.entity.id)
    && [card.revision.name, ...card.revision.aliases].some((name) =>
      name.normalize("NFKC").toLocaleLowerCase().includes(query))) : [];
  const shownResults = results.slice(0, 20);

  function choose(card: EntityCard) {
    onChange({ selected: true, mergeTarget: {
      id: card.entity.id, expectedVersion: card.entity.version, expectedRevisionId: card.revision.id,
    } });
  }

  function destination(card: EntityCard) {
    const stopped = card.entity.lifecycleStatus !== "ACTIVE";
    const wrongType = card.entity.entityType !== item.entityType;
    return <label className="import-entity-match" key={card.entity.id} data-selected={item.selected && item.mergeTarget?.id === card.entity.id}>
      <input type="radio" name={`import-destination-${index}`} value={card.entity.id}
        aria-label={`第 ${index + 1} 条候选合并到「${card.revision.name}」（${card.entity.id}）`}
        checked={item.selected && item.mergeTarget?.id === card.entity.id} disabled={stopped || wrongType}
        onChange={() => choose(card)} />
      <span className="import-entity-match-content">
        <span className="import-entity-match-heading"><strong>{card.revision.name}</strong>
          <small>{stopped ? "已停用" : wrongType ? "类型已变化" : `v${card.entity.version}`}</small></span>
        <small>来源：{card.revision.sourceVersion || "未标注来源"}</small>
        <span className="import-entity-match-description" title={card.revision.description}>{card.revision.description || "暂无描述"}</span>
      </span>
    </label>;
  }

  return <div className="import-candidate-destination">
    <label className="import-candidate-disposition">写入方式<select aria-label={`第 ${index + 1} 条候选写入方式`}
      value={!item.selected ? "skip" : item.mergeTarget?.id ?? "create"}
      onChange={(event) => {
        const value = event.target.value;
        if (value === "skip" || value === "create") onChange({ selected: value !== "skip", mergeTarget: undefined });
        else if (targetAvailable && target) choose(target);
      }}>
      <option value="skip">跳过本条</option>
      <option value="create">{matches.length ? "仍新建实体" : "新建实体"}</option>
      {item.mergeTarget ? <option value={item.mergeTarget.id}>
        {targetAvailable ? `合并到「${target.revision.name}」` : "原合并目标已不可用"}
      </option> : null}
    </select></label>
    {matches.length ? <div className="import-matched-entities">
      <div className="import-match-heading">库中同名或同别名 <span>{matches.length} 个</span></div>
      <div className="import-entity-match-list" role="group" aria-label={`第 ${index + 1} 条候选匹配实体`}>
        {matches.map(destination)}
      </div>
    </div> : null}
    {item.selected && item.mergeTarget && !matchIds.has(item.mergeTarget.id) && target
      && !shownResults.some((card) => card.entity.id === target.entity.id)
      ? <div className="import-chosen-entity" role="group" aria-label={`第 ${index + 1} 条候选已选目标`}>{destination(target)}</div> : null}
    {item.selected && item.mergeTarget && !targetAvailable
      ? <p className="project-error">合并目标已不可用，请重新选择或改为新建。</p> : null}
    {stale ? <div className="import-target-stale">
      <span className="project-error">目标已变化，请重新选择目标后预览。</span>
      <button type="button" className="secondary-action" aria-label={`更新第 ${index + 1} 条合并目标`}
        disabled={!targetAvailable} onClick={() => choose(target)}>
        <RotateCcw size={14} />重新选择最新目标
      </button>
    </div> : null}
    <details className="import-other-entities" open={searchOpen} onToggle={(event) => setSearchOpen(event.currentTarget.open)}>
      <summary>查找其他实体</summary>
      {searchOpen ? <>
        <SearchField label={`第 ${index + 1} 条候选查找其他实体`} value={search} onChange={setSearch} placeholder="搜索名称或别名" />
        {query ? <><small className="library-meta">{results.length > 20 ? `找到 ${results.length} 个，显示前 20 个` : `找到 ${results.length} 个其他实体`}</small>
          {results.length ? <div className="import-entity-match-list" role="group" aria-label={`第 ${index + 1} 条候选搜索结果`}>
            {shownResults.map(destination)}
          </div> : null}</> : null}
      </> : null}
    </details>
  </div>;
}
