import { Download, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  attributeKind, attributeKindLabels, deleteAttributeCard, emptyAttribute, mergeAttributeCard,
  parseAttributes, readAttributeCards, saveAttributeCard,
  type AttributeCard, type AttributeField, type AttributeKind,
} from "../lib/entity-attributes";
import type { EntityType } from "../lib/tauri-client";
import "./entity-attributes.css";

function loadCards() {
  try { return { cards: readAttributeCards(), error: null }; }
  catch (cause) { return { cards: [] as AttributeCard[], error: `无法读取本机属性卡：${String(cause)}` }; }
}

export function EntityAttributesEditor({ value, entityType, onChange }: {
  value: string;
  entityType: EntityType;
  onChange: (value: string) => void;
}) {
  const [stored, setStored] = useState(loadCards);
  const [selectedCard, setSelectedCard] = useState("");
  const [cardName, setCardName] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldKind, setFieldKind] = useState<AttributeKind>("text");
  const [kinds, setKinds] = useState<Record<string, AttributeKind>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  let attributes: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try { attributes = parseAttributes(value); }
  catch (cause) { parseError = (cause as Error).message; }
  const cards = stored.cards.filter((card) => card.entityType === entityType);
  const activeCard = cards.find((card) => card.id === selectedCard);
  const fields: AttributeField[] = Object.entries(attributes ?? {}).map(([name, current]) => {
    const savedKinds = new Set(cards.flatMap((card) => card.fields.filter((field) => field.name === name).map((field) => field.kind)));
    const preferred = Object.prototype.hasOwnProperty.call(kinds, name) ? kinds[name]
      : activeCard?.fields.find((field) => field.name === name)?.kind ?? (savedKinds.size === 1 ? [...savedKinds][0] : undefined);
    return {
      name,
      kind: preferred && (current === null || attributeKind(current) === preferred
        || typeof current === "string" && preferred === "multiline") ? preferred : current === null ? "text" : attributeKind(current),
    };
  });

  function update(name: string, next: unknown) {
    if (attributes) onChange(JSON.stringify({ ...attributes, [name]: next }, null, 2));
  }

  function addField() {
    if (!attributes || !fieldName.trim()) return;
    const name = fieldName.trim();
    setNotice(null);
    if (Object.prototype.hasOwnProperty.call(attributes, name)) { setError("已有同名属性，未覆盖原值。"); return; }
    setError(null);
    setKinds((current) => ({ ...current, [name]: fieldKind }));
    update(name, emptyAttribute(fieldKind));
    setFieldName("");
  }

  function applyCard() {
    if (!activeCard || !attributes) return;
    onChange(mergeAttributeCard(value, activeCard.fields));
    setKinds((current) => ({ ...Object.fromEntries(activeCard.fields.map((field) => [field.name, field.kind])), ...current }));
    setError(null);
    setNotice(`已加载「${activeCard.name}」，保留已有属性值。`);
  }

  function persistCard(replace: boolean) {
    if (!attributes || !cardName.trim() || !fields.length || replace && !activeCard) return;
    if (replace && !window.confirm(`更新本机属性卡「${activeCard!.name}」？已保存的实体属性不会改变。`)) return;
    setNotice(null);
    try {
      const card: AttributeCard = {
        id: replace ? activeCard!.id : crypto.randomUUID(),
        name: cardName.trim(), entityType, fields,
      };
      const next = saveAttributeCard(card);
      setStored({ cards: next, error: null });
      setSelectedCard(card.id);
      setCardName(card.name);
      setError(null);
      setNotice(`属性卡「${card.name}」已保存到本机。`);
    } catch (cause) { setError(`属性卡未保存：${String(cause)}`); }
  }

  function removeCard() {
    if (!activeCard || !window.confirm(`删除本机属性卡「${activeCard.name}」？实体已填写的属性不会删除。`)) return;
    setNotice(null);
    try {
      setStored({ cards: deleteAttributeCard(activeCard.id), error: null });
      setSelectedCard("");
      setCardName("");
      setError(null);
      setNotice("已删除本机属性卡，实体属性保持不变。");
    } catch (cause) { setError(`属性卡未删除：${String(cause)}`); }
  }

  return <section className="entity-attributes entity-form-wide" aria-label="固定属性">
    <div className="section-heading"><h3>固定属性</h3></div>
    <div className="attribute-card-toolbar">
      <label>本机属性卡<select aria-label="本机属性卡" value={selectedCard} onChange={(event) => {
        setSelectedCard(event.target.value);
        setCardName(cards.find((card) => card.id === event.target.value)?.name ?? "");
        setNotice(null);
      }}>
        <option value="">{cards.length ? "选择属性卡" : "暂无属性卡"}</option>
        {cards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}
      </select></label>
      <button type="button" className="secondary-action" disabled={!activeCard || !attributes} onClick={applyCard}><Download size={14} />加载属性卡</button>
    </div>
    {parseError ? <p className="project-error" role="alert">{parseError}</p> : null}
    <div className="attribute-fields">
      {fields.map(({ name, kind }) => <div className="attribute-field" key={name}>
        <label>{name}
          {kind === "boolean" ? <span className="attribute-boolean">
            <input type="checkbox" aria-label={name} checked={attributes![name] === true}
              ref={(element) => { if (element) element.indeterminate = attributes![name] === null; }}
              onChange={(event) => update(name, event.target.checked)} />
            <span>{attributes![name] === null ? "未设置" : attributes![name] ? "是" : "否"}</span>
          </span> : kind === "json" ? <pre>{attributes![name] === null ? "未设置" : JSON.stringify(attributes![name], null, 2)}</pre>
            : kind === "multiline" ? <textarea aria-label={name} rows={3} value={String(attributes![name] ?? "")}
              onChange={(event) => update(name, event.target.value)} />
              : <input aria-label={name} type={kind === "number" ? "number" : "text"} step={kind === "number" ? "any" : undefined}
                value={attributes![name] === null ? "" : String(attributes![name])}
                onChange={(event) => {
                  const next = event.target.value;
                  if (kind !== "number") update(name, next);
                  else if (next === "") update(name, null);
                  else if (Number.isFinite(Number(next))) update(name, Number(next));
                }} />}
        </label>
        <button type="button" className="attribute-icon" aria-label={`删除属性：${name}`} title={`删除属性：${name}`} onClick={() => {
          if (attributes![name] !== "" && attributes![name] !== null && !window.confirm(`删除属性「${name}」及其值？保存实体后生效。`)) return;
          onChange(JSON.stringify(Object.fromEntries(Object.entries(attributes!).filter(([key]) => key !== name)), null, 2));
        }}><Trash2 size={15} /></button>
      </div>)}
    </div>
    <div className="attribute-add-row">
      <label>属性名<input value={fieldName} onChange={(event) => setFieldName(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addField(); }
      }} /></label>
      <label>输入类型<select aria-label="输入类型" value={fieldKind} onChange={(event) => setFieldKind(event.target.value as AttributeKind)}>
        {Object.entries(attributeKindLabels).filter(([kind]) => kind !== "json").map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select></label>
      <button type="button" className="attribute-icon" disabled={!attributes || !fieldName.trim()} title="添加属性" aria-label="添加属性" onClick={addField}><Plus size={16} /></button>
    </div>
    <details className="attribute-card-settings"><summary>属性卡设置</summary>
      <div className="attribute-card-toolbar">
        <label>属性卡名称<input value={cardName} onChange={(event) => setCardName(event.target.value)} /></label>
        <button type="button" className="secondary-action" disabled={!attributes || !cardName.trim() || !fields.length} onClick={() => persistCard(false)}><Save size={14} />另存属性卡</button>
        {activeCard ? <>
          <button type="button" className="secondary-action" disabled={!attributes || !cardName.trim() || !fields.length} onClick={() => persistCard(true)}><Save size={14} />更新属性卡</button>
          <button type="button" className="attribute-icon" title="删除属性卡" aria-label="删除属性卡" onClick={removeCard}><Trash2 size={15} /></button>
        </> : null}
      </div>
    </details>
    {stored.error || error ? <p className="project-error" role="alert">{error ?? stored.error}</p> : null}
    {notice ? <p className="library-meta" role="status">{notice}</p> : null}
    <details className="attribute-json" open={jsonOpen || Boolean(parseError)} onToggle={(event) => setJsonOpen(event.currentTarget.open)}><summary>高级 JSON</summary>
      <label>固定属性 JSON<textarea aria-label="固定属性 JSON" value={value} rows={5} spellCheck={false} onChange={(event) => {
        setKinds({});
        onChange(event.target.value);
      }} /></label>
    </details>
  </section>;
}

export function EntityAttributesDisplay({ value }: { value: string }) {
  try {
    const entries = Object.entries(parseAttributes(value));
    if (!entries.length) return null;
    return <dl className="entity-attribute-values">{entries.map(([name, current]) => <div key={name}>
      <dt>{name}</dt><dd>{current === null ? "未设置" : typeof current === "boolean" ? current ? "是" : "否"
        : typeof current === "object" ? JSON.stringify(current, null, 2) : String(current) || "未填写"}</dd>
    </div>)}</dl>;
  } catch { return <pre>{value}</pre>; }
}
