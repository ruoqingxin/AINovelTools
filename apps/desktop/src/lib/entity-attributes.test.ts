import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributeKind, deleteAttributeCard, mergeAttributeCard, parseAttributes, readAttributeCards, saveAttributeCard,
  type AttributeCard,
} from "./entity-attributes";

const card: AttributeCard = {
  id: "character", name: "修士", entityType: "CHARACTER",
  fields: [{ name: "境界", kind: "text" }, { name: "年龄", kind: "number" }, { name: "可逆转时间", kind: "boolean" }],
};
describe("entity attributes", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("validates objects and preserves nested values and scalar types", () => {
    const raw = '{"境界":"化神","年龄":18,"可逆转时间":false,"能力":["回溯"],"限制":{"次数":2},"未知":null}';
    expect(parseAttributes(raw)).toEqual({
      境界: "化神", 年龄: 18, 可逆转时间: false, 能力: ["回溯"], 限制: { 次数: 2 }, 未知: null,
    });
    for (const invalid of ["", "{", "[]", "null", '"text"', "1", "true"]) {
      expect(() => parseAttributes(invalid)).toThrow();
    }
    expect(attributeKind("多行\n文本")).toBe("multiline");
    expect(attributeKind({ value: 1 })).toBe("json");
  });

  it("only adds missing card fields and never overwrites false, zero, null or existing values", () => {
    const raw = '{"境界":"化神","年龄":0,"可逆转时间":false,"未知":null,"嵌套":{"列表":[1,2]}}';
    expect(mergeAttributeCard(raw, card.fields)).toBe(raw);
    const merged = parseAttributes(mergeAttributeCard(raw, [...card.fields, { name: "寿元", kind: "number" }, { name: "隐身", kind: "boolean" }]));
    expect(merged).toEqual({ ...parseAttributes(raw), 寿元: null, 隐身: null });
    expect(parseAttributes(mergeAttributeCard("{}", card.fields))).toEqual({ 境界: "", 年龄: null, 可逆转时间: null });
  });

  it("treats prototype-like names as ordinary JSON keys", () => {
    const merged = parseAttributes(mergeAttributeCard('{"__proto__":{"safe":true}}',
      [{ name: "constructor", kind: "text" }, { name: "__proto__", kind: "text" }]));
    expect(Object.keys(merged)).toEqual(["__proto__", "constructor"]);
    expect(merged["__proto__"]).toEqual({ safe: true });
    expect(merged.constructor).toBe("");
    expect({}).not.toHaveProperty("safe");
  });

  it("persists, updates and deletes typed cards without saving entity values", () => {
    saveAttributeCard(card);
    expect(readAttributeCards()).toEqual([card]);
    expect(() => saveAttributeCard({ ...card, id: "duplicate" })).toThrow("同名");
    saveAttributeCard({ ...card, name: "高阶修士" });
    expect(readAttributeCards()).toEqual([{ ...card, name: "高阶修士" }]);
    saveAttributeCard({ ...card, id: "location", entityType: "LOCATION" });
    expect(readAttributeCards()).toHaveLength(2);
    expect(deleteAttributeCard(card.id)).toEqual([{ ...card, id: "location", entityType: "LOCATION" }]);
  });

  it("does not overwrite corrupt or unavailable storage", () => {
    localStorage.setItem("ainoveltools:attribute-cards:v1", '{"broken":true}');
    expect(() => saveAttributeCard(card)).toThrow("损坏");
    expect(localStorage.getItem("ainoveltools:attribute-cards:v1")).toBe('{"broken":true}');
    localStorage.clear();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveAttributeCard(card)).toThrow("quota");
    set.mockRestore();
    expect(readAttributeCards()).toEqual([]);
  });
});
