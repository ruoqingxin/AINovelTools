import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useState } from "react";
import {
  errorMessage,
  listSummaryMaterials,
  listWritingCards,
  rebuildSummaryMaterial,
  setSummaryMaterialLifecycle,
  setWritingCardEnabled,
  upsertSummaryMaterial,
  upsertWritingCard,
  type SummaryKind,
  type SummaryPrecision,
  type WritingCard,
} from "../lib/tauri-client";

const emptyCard: WritingCard = { id: "", projectId: "", cardType: "STYLE_RULE", title: "", content: "", sourceVersion: null, scope: "PROJECT", enabled: true, sortOrder: 0, createdAt: "", updatedAt: "" };

export function MaterialsView() {
  const client = useQueryClient();
  const summaries = useQuery({ queryKey: ["summary-materials"], queryFn: listSummaryMaterials });
  const cards = useQuery({ queryKey: ["writing-cards"], queryFn: () => listWritingCards() });
  const [summary, setSummary] = useState({ kind: "CHAPTER" as SummaryKind, precision: "L0" as SummaryPrecision, content: "", sourceVersion: "" });
  const [card, setCard] = useState<WritingCard>(emptyCard);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(key: string[]) {
    await client.invalidateQueries({ queryKey: key });
  }

  async function runItemAction(action: () => Promise<unknown>, key: string[], success: string) {
    try {
      await action();
      await refresh(key);
      setNotice(success);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function saveSummary() {
    try {
      await upsertSummaryMaterial({ id: crypto.randomUUID(), projectId: "", kind: summary.kind, precision: summary.precision, sourceId: null, sourceVersion: summary.sourceVersion || null, content: summary.content, generationMode: "MANUAL", lifecycleStatus: "ACTIVE", createdAt: "", updatedAt: "" });
      setSummary((value) => ({ ...value, content: "" })); setNotice("摘要已保存"); setError(null); await client.invalidateQueries({ queryKey: ["summary-materials"] });
    } catch (cause) { setError(String(cause)); }
  }
  async function saveCard() {
    try {
      await upsertWritingCard({ ...card, id: card.id || crypto.randomUUID(), projectId: card.projectId || "", createdAt: "", updatedAt: "" });
      setCard(emptyCard); setNotice("卡片已保存"); setError(null); await client.invalidateQueries({ queryKey: ["writing-cards"] });
    } catch (cause) { setError(String(cause)); }
  }
  return <section className="materials-view">
    <div className="workspace-heading"><p className="eyebrow">R4 阶段 D</p><h1>摘要与写作卡片</h1><p className="workspace-lede">维护多精度摘要、风格规则和写作技巧。内容保留来源与生命周期信息，供后续上下文组装使用。</p></div>
    {notice ? <p className="project-notice" role="status">{notice}</p> : null}{error ? <p className="project-error" role="alert">{error}</p> : null}
    <div className="materials-layout">
      <div className="materials-panel"><div className="section-heading"><h2>新建摘要</h2><span>{summaries.data?.length ?? 0} 条</span></div>
        <div className="entity-form-grid"><label>类型<select value={summary.kind} onChange={(e) => setSummary({ ...summary, kind: e.target.value as SummaryKind })}><option value="CHAPTER">章节</option><option value="CHARACTER">人物</option><option value="SETTING">设定</option></select></label><label>精度<select value={summary.precision} onChange={(e) => setSummary({ ...summary, precision: e.target.value as SummaryPrecision })}>{["L0","L1","L2","L3","L4","L5"].map((v) => <option key={v}>{v}</option>)}</select></label><label className="entity-form-wide">来源版本<input value={summary.sourceVersion} onChange={(e) => setSummary({ ...summary, sourceVersion: e.target.value })} placeholder="例如：chapter:2" /></label><label className="entity-form-wide">摘要内容<textarea rows={6} value={summary.content} onChange={(e) => setSummary({ ...summary, content: e.target.value })} /></label></div><button type="button" className="primary-action" onClick={() => void saveSummary()} disabled={!summary.content.trim()}><Save size={15} />保存摘要</button>
        <div className="materials-list">{summaries.data?.map((item) => <div className="material-row" key={item.id}><strong>{item.kind} · {item.precision}</strong><span>{item.content}</span><small>{item.sourceVersion ?? "暂无来源"} · <span className={item.lifecycleStatus === "CANDIDATE" ? "material-candidate" : undefined}>{item.lifecycleStatus === "ACTIVE" ? "有效" : item.lifecycleStatus === "CANDIDATE" ? "AI 候选" : "已失效"}</span> · {item.generationMode}</small><div className="material-actions"><button type="button" className="secondary-action" onClick={() => void runItemAction(() => setSummaryMaterialLifecycle(item.id, item.lifecycleStatus === "ACTIVE" ? "STALE" : "ACTIVE"), ["summary-materials"], item.lifecycleStatus === "ACTIVE" ? "摘要已标记失效" : "摘要已恢复有效")}>{item.lifecycleStatus === "ACTIVE" ? "标记失效" : "恢复摘要"}</button><button type="button" className="secondary-action" onClick={() => void runItemAction(() => setSummaryMaterialLifecycle(item.id, item.lifecycleStatus === "CANDIDATE" ? "ACTIVE" : "CANDIDATE"), ["summary-materials"], item.lifecycleStatus === "CANDIDATE" ? "摘要已设为有效" : "摘要已标记候选")}>{item.lifecycleStatus === "CANDIDATE" ? "设为有效" : "标记候选"}</button><button type="button" className="secondary-action" onClick={() => void runItemAction(() => rebuildSummaryMaterial(item.id), ["summary-materials"], "摘要已重建")}>重建记录</button></div></div>)}</div>
      </div>
      <div className="materials-panel"><div className="section-heading"><h2>写作卡片</h2><span>{cards.data?.length ?? 0} 条</span></div>
        <div className="entity-form-grid"><label>卡片类型<select value={card.cardType} onChange={(e) => setCard({ ...card, cardType: e.target.value as WritingCard["cardType"] })}><option value="STYLE_RULE">风格规则</option><option value="TECHNIQUE">写作技巧</option></select></label><label>作用范围<input value={card.scope} onChange={(e) => setCard({ ...card, scope: e.target.value })} /></label><label className="entity-form-wide">标题<input value={card.title} onChange={(e) => setCard({ ...card, title: e.target.value })} /></label><label className="entity-form-wide">内容<textarea rows={6} value={card.content} onChange={(e) => setCard({ ...card, content: e.target.value })} /></label></div><button type="button" className="primary-action" onClick={() => void saveCard()} disabled={!card.title.trim() || !card.content.trim()}><Save size={15} />保存卡片</button>
        <div className="materials-list">{cards.data?.map((item) => <div className="material-row" key={item.id}><strong>{item.cardType === "STYLE_RULE" ? "风格规则" : "写作技巧"} · {item.title}</strong><span>{item.content}</span><small>{item.enabled ? "已启用" : "已停用"} · {item.scope}</small><label className="material-order">排序<input type="number" value={item.sortOrder} onChange={(e) => { const next = Number(e.target.value); if (Number.isFinite(next)) void runItemAction(() => upsertWritingCard({ ...item, sortOrder: next }), ["writing-cards"], "卡片排序已更新"); }} /></label><button type="button" className="secondary-action" onClick={() => void runItemAction(() => setWritingCardEnabled(item.id, !item.enabled), ["writing-cards"], item.enabled ? "卡片已停用" : "卡片已启用")}>{item.enabled ? "停用" : "启用"}此卡片</button></div>)}</div>
      </div>
    </div>
  </section>;
}
