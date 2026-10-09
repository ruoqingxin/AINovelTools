import { EditorContent, Extension, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { memo, useEffect } from "react";
import { documentToJson } from "./project-workspace-utils";

const SourceBlockIds = Extension.create({
  name: "sourceBlockIds",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "listItem", "codeBlock", "horizontalRule"],
      attributes: {
        blockId: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-block-id"),
          renderHTML: (attributes) => typeof attributes.blockId === "string"
            ? { "data-block-id": attributes.blockId } : {},
        },
      },
    }];
  },
});

export const ManuscriptReader = memo(function ManuscriptReader({ documentJson, blockId, ariaLabel = "已保存正文" }: { documentJson: string; blockId?: string; ariaLabel?: string }) {
  const editor = useEditor({
    extensions: [StarterKit, SourceBlockIds],
    content: documentToJson(documentJson),
    editable: false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: "tiptap-editor manuscript-reader-body", "aria-label": ariaLabel } },
  });
  useEffect(() => {
    editor?.commands.setContent(documentToJson(documentJson), { emitUpdate: false });
    if (!editor) return;
    for (const element of editor.view.dom.querySelectorAll<HTMLElement>("[data-block-id]")) {
      if (blockId && element.getAttribute("data-block-id") === blockId) {
        element.dataset.sourceTarget = "true";
        element.tabIndex = -1;
        element.scrollIntoView?.({ block: "center" });
        element.focus({ preventScroll: true });
      } else {
        delete element.dataset.sourceTarget;
      }
    }
  }, [documentJson, editor, blockId]);
  return editor ? <EditorContent editor={editor} /> : <p className="plan-empty">正在加载正文…</p>;
});
