import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmActionProvider, useConfirmAction } from "./confirm-action-provider";

function Caller({ done }: { done: (allowed: boolean) => void }) {
  const confirm = useConfirmAction();
  return <button onClick={() => void confirm({ message: "未保存修改将被放弃。", confirmLabel: "放弃修改" }).then(done)}>执行操作</button>;
}

describe("ConfirmActionProvider", () => {
  afterEach(cleanup);
  it("defaults focus to cancellation, traps Tab, and restores focus after Escape", async () => {
    const done = vi.fn();
    render(<ConfirmActionProvider><Caller done={done} /></ConfirmActionProvider>);
    const trigger = screen.getByRole("button", { name: "执行操作" });
    trigger.focus();
    fireEvent.click(trigger);
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "放弃修改" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(done).toHaveBeenCalledWith(false));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("requires explicit approval and rejects overlapping requests", async () => {
    const done = vi.fn();
    render(<ConfirmActionProvider><Caller done={done} /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "执行操作" }));
    fireEvent.click(screen.getByRole("button", { name: "执行操作" }));
    await waitFor(() => expect(done).toHaveBeenCalledExactlyOnceWith(false));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(done).toHaveBeenLastCalledWith(true));
  });
  it("cancels pending work when the provider is unmounted", async () => {
    const done = vi.fn();
    const view = render(<ConfirmActionProvider><Caller done={done} /></ConfirmActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "执行操作" }));
    await act(async () => view.unmount());
    expect(done).toHaveBeenCalledExactlyOnceWith(false);
  });
});
