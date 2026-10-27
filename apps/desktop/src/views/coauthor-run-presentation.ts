type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

const tools: Record<string, string> = {
  deliver_reply: "提交本轮回复", search_sources: "按关键词检索资料", read_source: "读取资料原文",
  search_semantic_sources: "按语义检索资料", get_related_knowledge: "查找关联知识",
  get_knowledge_anchors: "读取知识的原文位置", get_knowledge_evidence_progress: "核对知识证据读取进度",
  read_knowledge_evidence: "读取知识证据原文", start_source_check: "建立查证清单",
  get_source_checks: "读取查证范围与进度", read_check_source: "读取清单中的原文",
  get_check_notes: "读取查证笔记", save_check_note: "保存查证笔记", record_check_result: "记录查证判断",
  read_manuscript_blocks: "读取正文段落", read_outline_content: "读取大纲原文", read_draft: "读取工作稿",
  edit_draft: "准备工作稿修改", record_decision: "记录讨论决定", get_decisions: "读取讨论决定",
  get_decision_dependents: "检查决定的影响范围", link_source: "关联参考资料",
  prepare_changeset: "准备关联修改方案", get_change_plan: "读取关联修改方案",
  read_change_item: "读取方案中的修改内容", get_changes: "读取关联变更记录",
};
export function coauthorToolLabel(name: unknown): string {
  return typeof name === "string" ? tools[name] ?? "执行辅助操作" : "执行辅助操作";
}

const steps: Record<string, string> = {
  initial_search: "检索当前问题的关键词候选", initial_decisions: "读取当前讨论的决定与约束",
  initial_semantic_search: "尝试语义检索（是否执行以授权和索引状态为准）",
  local_source_followup: "补查本地关联资料", input_budget: "设置本轮输入预算",
  input_budget_expansion: "调整本轮输入预算", context_assembly: "整理本轮参考资料、历史讨论与工作稿",
  reply_requirement: "确认本轮回复形式", budget_limit: "达到输入预算上限，未继续请求",
  content_review_input: "准备回复复核资料", source_delivery: "向模型发送参考资料",
  check_delivery: "记录已向模型送达的查证原文", knowledge_evidence_delivery: "记录已送达的知识证据",
  content_review: "收到回复复核结果（不代表内容一定正确）", reply_delivery: "交付本轮回复",
  content_review_error: "回复复核失败，无法据此确认质量", reply_delivery_rejected: "回复交付未通过校验",
  reply_candidate: "保留候选回复，尚未作为最终回复交付", content_review_skipped: "本轮未执行回复复核",
  reply_recovery_context: "补充回复交付所需的上下文", tool_recovery_limit: "达到辅助操作恢复上限",
  context_compaction: "压缩已处理的参考内容", draft_proposal: "保存工作稿修改建议，未正式采用",
  provider_response_error: "模型服务返回异常", content_review_stopped: "回复复核已停止",
  prepared_changes_receipt: "记录待确认的关联修改方案", error: "本轮发生错误，请查看问题与局限",
  round_limit: "达到本轮模型请求次数上限", model_check_analysis: "保留模型查证分析，仅作运行记录",
  buffered_model_text: "保留模型中间文字，未作为最终回复展示", check_summary: "生成查证进度记录",
  check_summary_error: "查证台账读取失败，完成状态待核实", retrieval_summary: "保存检索操作记录",
};
export function coauthorStepLabel(value: unknown): string {
  const step = record(value);
  if (step.kind === "tool") {
    const result = record(step.result);
    const failed = result.executed === false || result.error !== undefined || step.error !== undefined;
    return `${coauthorToolLabel(step.name)} · ${failed ? "未成功执行" : "已返回结果，是否有效需核对"}`;
  }
  if (step.kind === "model_request") {
    const round = typeof step.round === "number" ? `第 ${step.round} 次` : "本次";
    const size = typeof step.inputChars === "number" ? ` · 输入估算 ${step.inputChars} 字符` : "";
    return `向模型发送${round}请求${size}`;
  }
  return typeof step.kind === "string" ? steps[step.kind] ?? "其他运行记录" : "其他运行记录";
}

export const retrievalHeader = "检索操作回执（程序记录；计数为当次返回页，不是相关条数或全库总数）：";
const retrievalEnd = "未检索到不等于不存在；未形成有效查询、未授权或索引不完整均不能证明查全。";

// Recognize only the old program-generated trailing block, never a generic heading or quotation.
export function splitLegacyRetrieval(content: string): { reply: string; receipt: string | null } {
  const marker = `\n\n${retrievalHeader}\n`;
  const start = content.lastIndexOf(marker);
  if (start < 0 || !content.endsWith(retrievalEnd)) return { reply: content, receipt: null };
  const receipt = content.slice(start + 2);
  const rows = receipt.split("\n").slice(1, -1);
  let count = 0;
  for (const row of rows) {
    if (/^仅列最近 12 次，另 \d+ 次见本轮审计。$/.test(row)) continue;
    if (/^最近一次语义索引快照：已索引分块 \d+，语义索引待更新 \d+；与查证索引独立，不合并计数。$/.test(row)) continue;
    const match = /^- (?:关键词|语义|词面补查) ("(?:[^"\\]|\\.)*")（(?:本分支历史|项目资料)，offset=\d+）：(?:实际返回 \d+ 条(?:，仍有后续页)?(?:，另因上下文预算省略 \d+ 条候选)?|未形成有效查询，不能记为 0 命中|未调用向量服务（未授权或无可用索引），不是 0 命中|未取得有效结果，不能记为 0 命中)(?:；关键词索引待更新 \d+ 项，不能据此声称查全)?。$/.exec(row);
    if (!match) return { reply: content, receipt: null };
    try { JSON.parse(match[1]); } catch { return { reply: content, receipt: null }; }
    count++;
  }
  return count ? { reply: content.slice(0, start), receipt } : { reply: content, receipt: null };
}

export function retrievalDisplay(run: { output: string; audit: unknown[] }): string | null {
  const entry = run.audit.map(record).find((item) => item.kind === "retrieval_summary" && typeof item.displayText === "string");
  return entry ? entry.displayText as string : splitLegacyRetrieval(run.output).receipt;
}
