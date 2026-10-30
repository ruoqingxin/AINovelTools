import type { EntityType } from "./tauri-client";

export type AttributeKind = "text" | "multiline" | "number" | "boolean" | "json";
export type AttributeField = { name: string; kind: AttributeKind };
export type AttributeCard = { id: string; name: string; entityType: EntityType; fields: AttributeField[] };

export const attributeKindLabels: Record<AttributeKind, string> = {
  text: "文字", multiline: "长文本", number: "数字", boolean: "开关", json: "复杂属性",
};
const storageKey = "ainoveltools:attribute-cards:v1";
const entityTypes: EntityType[] = ["CHARACTER", "LOCATION", "FACTION", "ITEM", "CONCEPT"];

export function parseAttributes(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("属性 JSON 格式无效，请修正后保存。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("属性 JSON 必须是对象，不能是数组或单个值。");
  }
  return value as Record<string, unknown>;
}

export function attributeKind(value: unknown): AttributeKind {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return value.includes("\n") ? "multiline" : "text";
  return "json";
}

export function emptyAttribute(kind: AttributeKind): unknown {
  return kind === "text" || kind === "multiline" ? "" : null;
}

export function mergeAttributeCard(raw: string, fields: AttributeField[]): string {
  const attributes = parseAttributes(raw);
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(attributes, field.name));
  if (!missing.length) return raw;
  return JSON.stringify({
    ...attributes,
    ...Object.fromEntries(missing.map((field) => [field.name, emptyAttribute(field.kind)])),
  }, null, 2);
}

export function readAttributeCards(): AttributeCard[] {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return [];
  const cards: unknown = JSON.parse(raw);
  if (!Array.isArray(cards) || !cards.every((card) => card && typeof card === "object"
    && typeof card.id === "string" && card.id && typeof card.name === "string" && card.name.trim()
    && entityTypes.includes(card.entityType) && Array.isArray(card.fields)
    && card.fields.every((field: AttributeField) => field && typeof field.name === "string" && field.name.trim()
      && Object.prototype.hasOwnProperty.call(attributeKindLabels, field.kind))
    && new Set(card.fields.map((field: AttributeField) => field.name)).size === card.fields.length)
    || new Set(cards.map((card: AttributeCard) => card.id)).size !== cards.length) {
    throw new Error("本机属性卡数据损坏，未覆盖已有配置。");
  }
  return cards as AttributeCard[];
}

export function saveAttributeCard(card: AttributeCard): AttributeCard[] {
  const cards = readAttributeCards();
  if (cards.some((item) => item.id !== card.id && item.entityType === card.entityType && item.name === card.name)) {
    throw new Error("该类型已有同名属性卡，请更换名称。");
  }
  const next = [...cards.filter((item) => item.id !== card.id), card];
  localStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}

export function deleteAttributeCard(id: string): AttributeCard[] {
  const next = readAttributeCards().filter((card) => card.id !== id);
  localStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}
