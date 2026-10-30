import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttributeCards, saveAttributeCard } from "../lib/entity-attributes";
import type { EntityType } from "../lib/tauri-client";
import { EntityAttributesDisplay, EntityAttributesEditor } from "./entity-attributes-editor";

function Editor({ initial = "{}", entityType = "CHARACTER" }: { initial?: string; entityType?: EntityType }) {
  const [value, setValue] = useState(initial);
  return <><EntityAttributesEditor value={value} onChange={setValue} entityType={entityType} /><div data-testid="json">{value}</div></>;
}
function json() { return JSON.parse(screen.getByTestId("json").textContent!); }
function add(name: string, kind = "text") {
  openSettings();
  fireEvent.change(screen.getByLabelText("属性名"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("输入类型"), { target: { value: kind } });
  fireEvent.click(screen.getByRole("button", { name: "添加属性" }));
  if (!screen.queryByRole("alert")) closeSettings();
}
function openSettings() {
  if (!screen.queryByRole("dialog", { name: "属性与属性卡" })) fireEvent.click(screen.getByRole("button", { name: "属性设置" }));
}
function closeSettings() { fireEvent.click(screen.getByRole("button", { name: "关闭属性与属性卡" })); }
function createFromCurrent() {
  openSettings();
  fireEvent.click(screen.getByRole("button", { name: "从当前字段创建属性卡" }));
}
function setCardField(index: number, name: string, kind = "text") {
  fireEvent.change(screen.getByLabelText(`第 ${index} 个卡片字段名`), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(`第 ${index} 个卡片输入类型`), { target: { value: kind } });
}

describe("entity attribute editor", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("keeps card and field operations in a separate panel and restores focus without changing JSON", () => {
    render(<Editor initial='{"境界":"化神"}' />);
    const trigger = screen.getByRole("button", { name: "属性设置" });
    expect(screen.getByRole("textbox", { name: "境界" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "本机属性卡" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "属性名" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除属性：境界" })).not.toBeInTheDocument();
    trigger.focus();
    openSettings();
    expect(screen.getByRole("dialog", { name: "属性与属性卡" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "本机属性卡" })).toBeVisible();
    expect(screen.getByRole("button", { name: "删除属性：境界" })).toBeVisible();
    closeSettings();
    expect(trigger).toHaveFocus();
    expect(json()).toEqual({ 境界: "化神" });
    expect(screen.getByTestId("json")).toHaveTextContent('{"境界":"化神"}');
  });

  it("closes on cancel without discarding field drafts or allowing the entity save shortcut to escape", () => {
    const shortcut = vi.fn();
    render(<div onKeyDown={shortcut}><Editor /></div>);
    openSettings();
    fireEvent.change(screen.getByLabelText("属性名"), { target: { value: "境界" } });
    fireEvent.click(screen.getByRole("button", { name: "添加属性" }));
    fireEvent.keyDown(screen.getByLabelText("属性名"), { key: "s", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "关闭属性与属性卡" }), { key: "s", metaKey: true });
    expect(shortcut).not.toHaveBeenCalled();
    fireEvent(screen.getByRole("dialog", { name: "属性与属性卡" }), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "境界" })).toHaveValue("");
    expect(json()).toEqual({ 境界: "" });
  });

  it("edits text, numbers, booleans and multiline values as the original JSON types", () => {
    render(<Editor initial='{"嵌套":{"列表":[1,false,null]}}' />);
    add("境界");
    fireEvent.change(screen.getByLabelText("境界"), { target: { value: "十位至强" } });
    add("寿元", "number");
    expect(json().寿元).toBeNull();
    fireEvent.change(screen.getByLabelText("寿元"), { target: { value: "1200.5" } });
    add("可逆转时间", "boolean");
    expect(screen.getByLabelText("可逆转时间")).toBePartiallyChecked();
    expect(json().可逆转时间).toBeNull();
    fireEvent.click(screen.getByLabelText("可逆转时间"));
    add("能力限制", "multiline");
    fireEvent.change(screen.getByLabelText("能力限制"), { target: { value: "消耗寿元\n不能连续施展" } });
    expect(json()).toEqual({ 嵌套: { 列表: [1, false, null] }, 境界: "十位至强", 寿元: 1200.5, 可逆转时间: true, 能力限制: "消耗寿元\n不能连续施展" });
    fireEvent.change(screen.getByLabelText("寿元"), { target: { value: "" } });
    expect(json().寿元).toBeNull();
  });

  it("blocks duplicate fields and confirms removing populated fields", () => {
    render(<Editor initial='{"境界":"化神"}' />);
    add(" 境界 ");
    expect(screen.getByRole("alert")).toHaveTextContent("已有同名");
    expect(json().境界).toBe("化神");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "删除属性：境界" }));
    expect(json().境界).toBe("化神");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除属性：境界" }));
    expect(json()).toEqual({});
  });

  it("saves card definitions without values and reloads them for a different entity", () => {
    const first = render(<Editor initial='{"境界":"化神","寿元":800,"可逆转时间":true}' />);
    createFromCurrent();
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: "修士" } });
    fireEvent.click(screen.getByRole("button", { name: "保存属性卡" }));
    expect(screen.getByRole("status")).toHaveTextContent("已保存到本机");
    first.unmount();
    render(<Editor initial='{"境界":"金丹","额外":{"保留":true}}' />);
    openSettings();
    fireEvent.change(screen.getByLabelText("本机属性卡"), { target: { value: JSON.parse(localStorage.getItem("ainoveltools:attribute-cards:v1")!)[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "加载属性卡" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(json()).toEqual({ 境界: "金丹", 额外: { 保留: true }, 寿元: null, 可逆转时间: null });
    expect(screen.getByLabelText("寿元")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("可逆转时间")).toBePartiallyChecked();
  });

  it("restores empty typed fields from saved cards on reopening and filters cards by entity type", () => {
    saveAttributeCard({ id: "person", name: "修士", entityType: "CHARACTER", fields: [{ name: "年龄", kind: "number" }, { name: "隐身", kind: "boolean" }] });
    saveAttributeCard({ id: "place", name: "地域", entityType: "LOCATION", fields: [{ name: "面积", kind: "number" }] });
    render(<Editor initial='{"年龄":null,"隐身":null,"未知":null}' />);
    expect(screen.getByLabelText("年龄")).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("隐身")).toBePartiallyChecked();
    expect(screen.getByLabelText("未知")).toHaveValue("");
    openSettings();
    expect(screen.getByRole("option", { name: "修士" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "地域" })).not.toBeInTheDocument();
  });

  it("updates or deletes a card without mutating entity attributes", () => {
    saveAttributeCard({ id: "person", name: "修士", entityType: "CHARACTER", fields: [{ name: "境界", kind: "text" }] });
    render(<Editor initial='{"境界":"化神","年龄":200}' />);
    openSettings();
    fireEvent.change(screen.getByLabelText("本机属性卡"), { target: { value: "person" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑属性卡" }));
    expect(screen.getByLabelText("第 1 个卡片字段名")).toHaveValue("境界");
    expect(screen.queryByLabelText("第 2 个卡片字段名")).not.toBeInTheDocument();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: "高阶修士" } });
    fireEvent.click(screen.getByRole("button", { name: "更新属性卡" }));
    expect(screen.getByRole("option", { name: "高阶修士" })).toBeInTheDocument();
    expect(readAttributeCards()[0].fields).toEqual([{ name: "境界", kind: "text" }]);
    expect(json()).toEqual({ 境界: "化神", 年龄: 200 });
    fireEvent.click(screen.getByRole("button", { name: "删除属性卡" }));
    expect(screen.queryByRole("option", { name: "高阶修士" })).not.toBeInTheDocument();
    expect(json()).toEqual({ 境界: "化神", 年龄: 200 });
  });

  it("keeps malformed JSON for correction and recovers form inputs after correction", () => {
    render(<Editor initial='{"境界":"化神"}' />);
    fireEvent.click(screen.getByText("高级 JSON"));
    fireEvent.change(screen.getByLabelText("固定属性 JSON"), { target: { value: '{"境界":' } });
    expect(screen.getByRole("alert")).toHaveTextContent("格式无效");
    expect(screen.getByLabelText("固定属性 JSON")).toHaveValue('{"境界":');
    openSettings();
    expect(screen.getByRole("button", { name: "添加属性" })).toBeDisabled();
    closeSettings();
    fireEvent.change(screen.getByLabelText("固定属性 JSON"), { target: { value: '{"境界":"金丹","能力":[1,2]}' } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("境界")).toHaveValue("金丹");
    fireEvent.change(screen.getByLabelText("境界"), { target: { value: "元婴" } });
    expect(json()).toEqual({ 境界: "元婴", 能力: [1, 2] });
  });

  it("reports storage failures without claiming the card was saved", () => {
    render(<Editor initial='{"境界":"化神"}' />);
    createFromCurrent();
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: "修士" } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "保存属性卡" }));
    expect(screen.getByRole("alert")).toHaveTextContent("未保存");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("creates a card from scratch without touching the empty entity until explicitly loaded", () => {
    const change = vi.fn();
    render(<EntityAttributesEditor value="{}" entityType="CHARACTER" onChange={change} />);
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "创建属性卡" }));
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: "修士属性卡" } });
    setCardField(1, "境界");
    fireEvent.click(screen.getByRole("button", { name: "添加卡片字段" }));
    setCardField(2, "寿元", "number");
    fireEvent.click(screen.getByRole("button", { name: "添加卡片字段" }));
    setCardField(3, "隐身", "boolean");
    fireEvent.click(screen.getByRole("button", { name: "保存属性卡" }));
    expect(change).not.toHaveBeenCalled();
    expect(readAttributeCards()).toEqual([expect.objectContaining({
      name: "修士属性卡", fields: [{ name: "境界", kind: "text" }, { name: "寿元", kind: "number" }, { name: "隐身", kind: "boolean" }],
    })]);
    fireEvent.click(screen.getByRole("button", { name: "加载属性卡" }));
    expect(change).toHaveBeenCalledTimes(1);
    expect(JSON.parse(change.mock.calls[0][0])).toEqual({ 境界: "", 寿元: null, 隐身: null });
  });

  it("guards unfinished card edits and discards them without changing entity data", () => {
    render(<Editor initial='{"境界":"化神"}' />);
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "创建属性卡" }));
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: "尚未保存" } });
    setCardField(1, "寿元", "number");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText("属性卡名称")).toHaveValue("尚未保存");
    expect(readAttributeCards()).toEqual([]);
    expect(json()).toEqual({ 境界: "化神" });
    confirm.mockReturnValue(true);
    closeSettings();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readAttributeCards()).toEqual([]);
    openSettings();
    expect(screen.getByRole("button", { name: "创建属性卡" })).toBeVisible();
    expect(json()).toEqual({ 境界: "化神" });
  });

  it("validates independent card names and fields and saves trimmed field names", () => {
    render(<Editor />);
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "创建属性卡" }));
    const save = screen.getByRole("button", { name: "保存属性卡" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: " 修士 " } });
    expect(save).toBeDisabled();
    setCardField(1, " 境界 ");
    fireEvent.click(screen.getByRole("button", { name: "添加卡片字段" }));
    expect(save).toBeDisabled();
    setCardField(2, "境界");
    expect(save).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("不能重复");
    setCardField(2, "寿元", "number");
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "删除第 2 个卡片字段" }));
    fireEvent.click(save);
    expect(readAttributeCards()[0]).toMatchObject({ name: "修士", fields: [{ name: "境界", kind: "text" }] });
    expect(json()).toEqual({});
  });

  it("can create a card even when the entity JSON is invalid", () => {
    const change = vi.fn();
    render(<EntityAttributesEditor value="[]" entityType="CHARACTER" onChange={change} />);
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "创建属性卡" }));
    fireEvent.change(screen.getByLabelText("属性卡名称"), { target: { value: "修士" } });
    setCardField(1, "境界");
    fireEvent.click(screen.getByRole("button", { name: "保存属性卡" }));
    expect(readAttributeCards()).toHaveLength(1);
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "加载属性卡" })).toBeDisabled();
  });

  it("edits a card schema independently without renaming or deleting entity values", () => {
    saveAttributeCard({ id: "person", name: "修士", entityType: "CHARACTER", fields: [{ name: "境界", kind: "text" }, { name: "年龄", kind: "number" }] });
    render(<Editor initial='{"境界":"化神","年龄":200,"嵌套":{"安全":true}}' />);
    openSettings();
    fireEvent.change(screen.getByLabelText("本机属性卡"), { target: { value: "person" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑属性卡" }));
    setCardField(1, "主修大道", "multiline");
    fireEvent.click(screen.getByRole("button", { name: "删除第 2 个卡片字段" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "更新属性卡" }));
    expect(readAttributeCards()[0].fields).toEqual([{ name: "主修大道", kind: "multiline" }]);
    expect(json()).toEqual({ 境界: "化神", 年龄: 200, 嵌套: { 安全: true } });
  });

  it("displays readable attributes without mutating nested data", () => {
    render(<EntityAttributesDisplay value='{"境界":"化神","存活":false,"未知":null,"能力":["回溯"]}' />);
    expect(screen.getByText("化神")).toBeVisible();
    expect(screen.getByText("否")).toBeVisible();
    expect(screen.getByText("未设置")).toBeVisible();
    expect(screen.getByText(/回溯/)).toBeVisible();
  });
});
