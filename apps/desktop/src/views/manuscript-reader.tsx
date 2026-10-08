import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { memo, useEffect } from "react";
import { documentToJson } from "./project-workspace-utils";

export const ManuscriptReader = memo(function ManuscriptReader({ documentJson }: { documentJson: string }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: documentToJson(documentJson),
    editable: false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: "tiptap-editor manuscript-reader-body", "aria-label": "已保存正文" } },
  });
  useEffect(() => {
    editor?.commands.setContent(documentToJson(documentJson), { emitUpdate: false });
  }, [documentJson, editor]);
  return editor ? <EditorContent editor={editor} /> : <p className="plan-empty">正在加载正文…</p>;
});
