import { ArrowLeft, Download, Pencil, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  attributeKind, attributeKindLabels, deleteAttributeCard, emptyAttribute, mergeAttributeCard,
  parseAttributes, readAttributeCards, saveAttributeCard,
  type AttributeCard, type AttributeField, type AttributeKind,
} from "../lib/entity-attributes";
import type { EntityType } from "../lib/tauri-client";
import { WorkspacePanel } from "./workspace-panel";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";
import "./entity-attributes.css";

type CardDraft = { id?: string; name: string; fields: AttributeField[] };

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
  const [cardDraft, setCardDraft] = useState<CardDraft | null>(null);
  const [cardBaseline, setCardBaseline] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldKind, setFieldKind] = useState<AttributeKind>("text");
  const [kinds, setKinds] = useState<Record<string, AttributeKind>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const cardDirty = cardDraft !== null && JSON.stringify(cardDraft) !== cardBaseline;
  const cardFieldNames = cardDraft?.fields.map((field) => field.name.trim()) ?? [];
  const duplicateCardFields = new Set(cardFieldNames.filter(Boolean)).size !== cardFieldNames.filter(Boolean).length;
  const canSaveCard = Boolean(cardDraft?.name.trim() && cardFieldNames.length && cardFieldNames.every(Boolean) && !duplicateCardFields);
  useUnsavedChangesGuard(cardDirty, "属性卡有未保存修改。");
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
    setPanelOpen(false);
  }

  function startCard(draft: CardDraft) {
    setCardDraft(draft);
    setCardBaseline(JSON.stringify(draft));
    setError(null);
    setNotice(null);
  }

  function discardCard() {
    if (cardDirty && !window.confirm("放弃尚未保存的属性卡修改吗？")) return false;
    setCardDraft(null);
    setError(null);
    return true;
  }

  function closePanel() {
    if (cardDraft && !discardCard()) return;
    setPanelOpen(false);
  }

  function persistCard() {
    if (!cardDraft || !canSaveCard) return;
    if (cardDraft.id && !window.confirm(`更新本机属性卡「${activeCard?.name ?? cardDraft.name}」？已保存的实体属性不会改变。`)) return;
    setNotice(null);
    try {
      const card: AttributeCard = {
        id: cardDraft.id ?? crypto.randomUUID(),
        name: cardDraft.name.trim(), entityType,
        fields: cardDraft.fields.map((field) => ({ ...field, name: field.name.trim() })),
      };
      const next = saveAttributeCard(card);
      setStored({ cards: next, error: null });
      setSelectedCard(card.id);
      setCardDraft(null);
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
      setError(null);
      setNotice("已删除本机属性卡，实体属性保持不变。");
    } catch (cause) { setError(`属性卡未删除：${String(cause)}`); }
  }

  function removeField(name: string) {
    if (!attributes) return;
    if (attributes[name] !== "" && attributes[name] !== null && !window.confirm(`删除属性「${name}」及其值？保存实体后生效。`)) return;
    onChange(JSON.stringify(Object.fromEntries(Object.entries(attributes).filter(([key]) => key !== name)), null, 2));
  }

  return <section className="entity-attributes entity-form-wide" aria-label="固定属性" onKeyDown={(event) => {
    if (panelOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
    }
  }}>
    <div className="section-heading attribute-heading"><h3>固定属性</h3>
      <button type="button" className="secondary-action" title="管理属性与属性卡" onClick={() => setPanelOpen(true)}><SlidersHorizontal size={14} />属性设置</button>
    </div>
    {parseError ? <p className="project-error" role="alert">{parseError}</p> : null}
    {attributes && !fields.length ? <p className="library-meta attribute-empty">暂无固定属性</p> : null}
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
      </div>)}
    </div>
    {!panelOpen && notice ? <p className="library-meta" role="status">{notice}</p> : null}
    <details className="attribute-json" open={jsonOpen || Boolean(parseError)} onToggle={(event) => setJsonOpen(event.currentTarget.open)}><summary>高级 JSON</summary>
      <label>固定属性 JSON<textarea aria-label="固定属性 JSON" value={value} rows={5} spellCheck={false} onChange={(event) => {
        setKinds({});
        onChange(event.target.value);
      }} /></label>
    </details>
    <WorkspacePanel open={panelOpen} title="属性与属性卡" onClose={closePanel} className="attribute-settings-panel">
      {cardDraft ? <section className="attribute-card-editor" aria-label={cardDraft.id ? "编辑属性卡" : "创建属性卡"}>
        <div className="attribute-heading">
          <button type="button" className="secondary-action" onClick={discardCard}><ArrowLeft size={14} />返回属性卡</button>
          <span className="library-meta">{cardDraft.id ? "编辑属性卡" : "创建属性卡"}</span>
        </div>
        <label className="attribute-card-name">属性卡名称<input autoFocus value={cardDraft.name}
          onChange={(event) => setCardDraft({ ...cardDraft, name: event.target.value })} /></label>
        <div className="attribute-card-fields">
          {cardDraft.fields.map((field, index) => <div className="attribute-card-field" key={index}>
            <label>字段名<input aria-label={`第 ${index + 1} 个卡片字段名`} value={field.name} onChange={(event) => setCardDraft({
              ...cardDraft, fields: cardDraft.fields.map((current, position) => position === index ? { ...current, name: event.target.value } : current),
            })} /></label>
            <label>输入类型<select aria-label={`第 ${index + 1} 个卡片输入类型`} value={field.kind} onChange={(event) => setCardDraft({
              ...cardDraft, fields: cardDraft.fields.map((current, position) => position === index ? { ...current, kind: event.target.value as AttributeKind } : current),
            })}>
              {Object.entries(attributeKindLabels).filter(([kind]) => kind !== "json" || field.kind === "json").map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
            </select></label>
            <button type="button" className="attribute-icon" title={`删除第 ${index + 1} 个卡片字段`} aria-label={`删除第 ${index + 1} 个卡片字段`}
              onClick={() => setCardDraft({ ...cardDraft, fields: cardDraft.fields.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
          </div>)}
        </div>
        {duplicateCardFields ? <p className="project-error" role="alert">卡片字段名不能重复。</p> : null}
        <div className="attribute-card-toolbar">
          <button type="button" className="secondary-action" onClick={() => setCardDraft({
            ...cardDraft, fields: [...cardDraft.fields, { name: "", kind: "text" }],
          })}><Plus size={14} />添加卡片字段</button>
        </div>
        <div className="attribute-card-editor-actions">
          <button type="button" className="primary-action" disabled={!canSaveCard} onClick={persistCard}><Save size={14} />{cardDraft.id ? "更新属性卡" : "保存属性卡"}</button>
          <button type="button" className="secondary-action" onClick={discardCard}>取消</button>
        </div>
      </section> : <div>
        <section className="attribute-settings-section" aria-label="加载属性卡">
          <div className="attribute-heading"><h3>本机属性卡</h3>
            <button type="button" className="primary-action" onClick={() => startCard({ name: "", fields: [{ name: "", kind: "text" }] })}><Plus size={14} />创建属性卡</button>
          </div>
          <div className="attribute-card-toolbar">
            <label>本机属性卡<select aria-label="本机属性卡" value={selectedCard} onChange={(event) => {
              setSelectedCard(event.target.value);
              setNotice(null);
            }}>
              <option value="">{cards.length ? "选择属性卡" : "暂无属性卡"}</option>
              {cards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}
            </select></label>
            <button type="button" className="secondary-action" disabled={!activeCard || !attributes} onClick={applyCard}><Download size={14} />加载属性卡</button>
          </div>
          {activeCard ? <div className="attribute-card-toolbar">
            <button type="button" className="secondary-action" onClick={() => startCard({
              id: activeCard.id, name: activeCard.name, fields: activeCard.fields.map((field) => ({ ...field })),
            })}><Pencil size={14} />编辑属性卡</button>
            <button type="button" className="attribute-icon" title="删除属性卡" aria-label="删除属性卡" onClick={removeCard}><Trash2 size={15} /></button>
          </div> : null}
        </section>
        <section className="attribute-settings-section" aria-label="当前实体字段">
          <h3>当前实体字段</h3>
          {fields.length ? <ul className="attribute-definition-list">
            {fields.map(({ name, kind }) => <li key={name}>
              <span>{name}</span><small>{attributeKindLabels[kind]}</small>
              <button type="button" className="attribute-icon" aria-label={`删除属性：${name}`} title={`删除属性：${name}`}
                onClick={() => removeField(name)}><Trash2 size={15} /></button>
            </li>)}
          </ul> : <p className="library-meta">暂无字段</p>}
          <div className="attribute-add-row">
            <label>属性名<input value={fieldName} onChange={(event) => setFieldName(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addField(); }
            }} /></label>
            <label>输入类型<select aria-label="输入类型" value={fieldKind} onChange={(event) => setFieldKind(event.target.value as AttributeKind)}>
              {Object.entries(attributeKindLabels).filter(([kind]) => kind !== "json").map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
            </select></label>
            <button type="button" className="attribute-icon" disabled={!attributes || !fieldName.trim()} title="添加属性" aria-label="添加属性" onClick={addField}><Plus size={16} /></button>
          </div>
        </section>
        {fields.length ? <div className="attribute-card-toolbar">
          <button type="button" className="secondary-action" disabled={!attributes} onClick={() => startCard({
            name: "", fields: fields.map((field) => ({ ...field })),
          })}><Plus size={14} />从当前字段创建属性卡</button>
        </div> : null}
      </div>}
      {stored.error || error ? <p className="project-error" role="alert">{error ?? stored.error}</p> : null}
      {notice ? <p className="library-meta" role="status">{notice}</p> : null}
    </WorkspacePanel>
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
