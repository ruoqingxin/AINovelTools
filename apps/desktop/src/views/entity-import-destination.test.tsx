import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportCandidate } from "../lib/entity-import-review";
import type { EntityCard } from "../lib/tauri-client";
import { EntityImportDestination } from "./entity-import-destination";

const candidate: ImportCandidate = {
  entityType: "CHARACTER", name: "魂尊", description: "候选描述", aliases: [], tags: [], selected: true,
};
function card(id: string, name = "幽冥魂尊"): EntityCard {
  return {
    entity: { id, entityType: "CHARACTER", projectId: "project", lifecycleStatus: "ACTIVE",
      version: 2, currentRevisionId: `${id}-revision`, createdAt: "", updatedAt: "" },
    revision: { id: `${id}-revision`, entityId: id, revision: 2, name, aliases: ["魂尊"],
      description: `来自 ${id} 的原始描述`, sourceVersion: `${id}.md`, fixedAttributesJson: "{}",
      tags: [], baseRevisionId: null, createdAt: "" },
  };
}
function setup(matches: EntityCard[], cards = matches, initial = candidate) {
  const change = vi.fn();
  function Harness() {
    const [item, setItem] = useState(initial);
    return <EntityImportDestination index={0} item={item} matches={matches} cards={cards} onChange={(value) => {
      change(value);
      setItem((current) => ({ ...current, ...value }));
    }} />;
  }
  render(<Harness />);
  return change;
}
async function searchOther(query: string) {
  fireEvent.click(screen.getByText("查找其他实体"));
  const input = await screen.findByRole("textbox", { name: "第 1 条候选查找其他实体" });
  fireEvent.change(input, { target: { value: query } });
  return input;
}
afterEach(cleanup);

describe("entity import destination", () => {
  it("shows only detected matches beside the candidate even when the library contains many other entities", () => {
    const matches = [card("one"), card("two", "幽冥衍识")];
    const others = Array.from({ length: 1000 }, (_, index) => card(`other-${index}`, `其他人物${index}`));
    const change = setup(matches, [...matches, ...others]);
    const group = screen.getByRole("group", { name: "第 1 条候选匹配实体" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("其他人物0")).not.toBeInTheDocument();
    expect(within(group).getByText("来源：two.md")).toBeVisible();
    expect(within(group).getByText("来自 two 的原始描述")).toBeVisible();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("radio", { name: /「幽冥衍识」/ }));
    expect(change).toHaveBeenCalledWith({
      selected: true, mergeTarget: { id: "two", expectedVersion: 2, expectedRevisionId: "two-revision" },
    });
    expect(screen.getByLabelText("第 1 条候选写入方式")).toHaveValue("two");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("keeps identically named matches distinct by entity ID and supports new or skip instead of merging", () => {
    const change = setup([card("one"), card("two")]);
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]);
    expect(radios[1]).toBeChecked();
    expect(radios[0]).not.toBeChecked();
    expect(change.mock.calls[0][0].mergeTarget.id).toBe("two");
    fireEvent.change(screen.getByLabelText("第 1 条候选写入方式"), { target: { value: "create" } });
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(change).toHaveBeenLastCalledWith({ selected: true, mergeTarget: undefined });
    fireEvent.change(screen.getByLabelText("第 1 条候选写入方式"), { target: { value: "skip" } });
    expect(change).toHaveBeenLastCalledWith({ selected: false, mergeTarget: undefined });
  });

  it("shows stopped matches but prevents them from being merge destinations", () => {
    const stopped = card("stopped");
    stopped.entity.lifecycleStatus = "ARCHIVED";
    setup([stopped]);
    expect(screen.getByRole("radio")).toBeDisabled();
    expect(screen.getByText("已停用")).toBeVisible();
    expect(screen.getByLabelText("第 1 条候选写入方式")).toHaveValue("create");
  });

  it("searches other same-type active entities only on demand, limits results, and retains an explicitly chosen target", async () => {
    const others = Array.from({ length: 35 }, (_, index) => card(`other-${index}`, `其他人物${index}`));
    const stopped = card("stopped", "其他停用人物");
    stopped.entity.lifecycleStatus = "ARCHIVED";
    const wrongType = card("concept", "其他规则");
    wrongType.entity.entityType = "CONCEPT";
    setup([], [...others, stopped, wrongType]);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    const input = await searchOther("其他");
    expect(screen.getByText("找到 35 个，显示前 20 个")).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    expect(screen.queryByRole("radio", { name: /停用|规则/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /「其他人物1」/ }));
    expect(screen.getByLabelText("第 1 条候选写入方式")).toHaveValue("other-1");
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("group", { name: "第 1 条候选已选目标" })).toBeVisible();
    expect(screen.getByRole("radio")).toBeChecked();
    expect(screen.queryByRole("group", { name: "第 1 条候选搜索结果" })).not.toBeInTheDocument();
  });

  it("supports normalized alias searches without repeating already detected matches", async () => {
    const matched = card("matched");
    const other = card("other", "另一个角色");
    other.revision.aliases = ["Alias"];
    setup([matched], [matched, other]);
    const input = await searchOther(" ＡＬＩＡＳ ");
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(within(screen.getByRole("group", { name: "第 1 条候选搜索结果" })).getByRole("radio", { name: /另一个角色/ })).toBeVisible();
    fireEvent.change(input, { target: { value: "魂尊" } });
    expect(screen.getByText("找到 0 个其他实体")).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });
});
