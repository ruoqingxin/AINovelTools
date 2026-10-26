import "@testing-library/jest-dom/vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ManuscriptCandidateEditor } from "./manuscript-candidate-editor";

afterEach(cleanup);

describe("ManuscriptCandidateEditor", () => {
  it("tracks undo and redo availability and keeps the character count in the toolbar", async () => {
    const editor = new Editor({
      extensions: [StarterKit], content: "<p>Original</p>",
      // This test covers editing state; jsdom has no selection layout geometry.
      editorProps: { handleScrollToSelection: () => true },
    });
    try {
      render(<ManuscriptCandidateEditor editor={editor} characterCount={8} />);
      expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
      expect(screen.getByText("8 字")).toBeVisible();
      act(() => { editor.commands.insertContent("New "); });
      await waitFor(() => expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled());
      const changed = editor.getText();
      fireEvent.click(screen.getByRole("button", { name: "撤销" }));
      expect(editor.getText()).toBe("Original");
      await waitFor(() => expect(screen.getByRole("button", { name: "重做" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "重做" }));
      expect(editor.getText()).toBe(changed);
    } finally { editor.destroy(); }
  });
});
