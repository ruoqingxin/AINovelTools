import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, exportManuscript, type ManuscriptExportFormat, type ManuscriptExportReceipt } from "../lib/tauri-client";
import "./manuscript-export-panel.css";

export function ManuscriptExportPanel({ projectId, chapter, chapterDirty, saving }: {
  projectId: string;
  chapter?: { id: string; title: string };
  chapterDirty: boolean;
  saving: boolean;
}) {
  const [scope, setScope] = useState(chapter ? "chapter" : "book");
  const [format, setFormat] = useState<ManuscriptExportFormat>("TXT");
  const [exporting, setExporting] = useState(false);
  const [receipt, setReceipt] = useState<ManuscriptExportReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function runExport() {
    if (busy.current || saving || scope === "chapter" && !chapter) return;
    if (chapterDirty && !window.confirm("当前正文有未保存修改。本次只导出已保存正文，继续吗？")) return;
    busy.current = true;
    setExporting(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await exportManuscript({
        expectedProjectId: projectId,
        format,
        scope: scope === "chapter" && chapter ? { kind: "CHAPTER", chapterId: chapter.id } : { kind: "BOOK" },
      });
      if (mounted.current) setReceipt(result);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setExporting(false);
    }
  }

  return <details className="manuscript-export">
    <summary className="secondary-action" title="导出已保存正文"><Download size={15} />导出正文</summary>
    <div className="manuscript-export-panel">
      <form onSubmit={(event) => { event.preventDefault(); void runExport(); }}>
        <strong>已保存正文</strong>
        <label>导出范围
          <select aria-label="导出范围" value={scope} onChange={(event) => setScope(event.target.value)} disabled={exporting}>
            {chapter ? <option value="chapter">当前章节 · {chapter.title}</option> : null}
            <option value="book">全书活动章节</option>
          </select>
        </label>
        <label>文件格式
          <select aria-label="文件格式" value={format} onChange={(event) => setFormat(event.target.value as ManuscriptExportFormat)} disabled={exporting}>
            <option value="TXT">TXT / UTF-8</option><option value="MARKDOWN">Markdown / UTF-8</option>
          </select>
        </label>
        <button type="submit" className="primary-action" disabled={exporting || saving}>
          <Download size={15} />{exporting ? "导出中…" : "导出"}
        </button>
      </form>
      {error ? <p className="project-error" role="alert">{error}</p> : null}
      {receipt ? <div className="manuscript-export-result" role="status">
        <strong>已导出 {receipt.chapters.length} 章</strong>
        <code>{receipt.path}</code>
        {receipt.draftChapterCount ? <span>另有 {receipt.draftChapterCount} 章本地草稿未导出</span> : null}
        {receipt.skippedChapters.length ? <details>
          <summary>{receipt.skippedChapters.length} 章尚无已保存正文</summary>
          <ul>{receipt.skippedChapters.map((item) => <li key={item.chapterId}>{item.title}</li>)}</ul>
        </details> : null}
      </div> : null}
    </div>
  </details>;
}
