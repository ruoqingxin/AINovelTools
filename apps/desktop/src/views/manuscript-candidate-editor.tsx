import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, List, Redo2, Undo2 } from "lucide-react";
import { memo } from "react";

export const ManuscriptCandidateEditor = memo(function ManuscriptCandidateEditor({ editor, characterCount }: { editor: Editor; characterCount?: number }) {
  const formatting = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      bulletList: current.isActive("bulletList"),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });

  return <>
    <div className="editor-toolbar" aria-label="编辑器工具栏">
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} data-active={formatting.bold || undefined} aria-label="粗体" title="粗体"><Bold size={15} /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} data-active={formatting.italic || undefined} aria-label="斜体" title="斜体"><Italic size={15} /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} data-active={formatting.bulletList || undefined} aria-label="项目列表" title="项目列表"><List size={15} /></button>
      <span className="editor-toolbar-divider" aria-hidden="true" />
      <button type="button" onClick={() => editor.chain().focus().undo().run()} disabled={!formatting.canUndo} aria-label="撤销" title="撤销 (Ctrl+Z)"><Undo2 size={15} /></button>
      <button type="button" onClick={() => editor.chain().focus().redo().run()} disabled={!formatting.canRedo} aria-label="重做" title="重做 (Ctrl+Shift+Z)"><Redo2 size={15} /></button>
      {characterCount !== undefined ? <span className="editor-character-count">{characterCount} 字</span> : null}
    </div>
    <EditorContent className="manuscript-editor-content" editor={editor} />
  </>;
});
