import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, List } from "lucide-react";
import { memo } from "react";

export const ManuscriptCandidateEditor = memo(function ManuscriptCandidateEditor({ editor }: { editor: Editor }) {
  const formatting = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      bulletList: current.isActive("bulletList"),
    }),
  });

  return <>
    <div className="editor-toolbar" aria-label="编辑器工具栏">
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} data-active={formatting.bold || undefined} aria-label="粗体" title="粗体"><Bold size={15} /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} data-active={formatting.italic || undefined} aria-label="斜体" title="斜体"><Italic size={15} /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} data-active={formatting.bulletList || undefined} aria-label="项目列表" title="项目列表"><List size={15} /></button>
    </div>
    <EditorContent editor={editor} />
  </>;
});
