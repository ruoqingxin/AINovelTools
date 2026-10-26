use super::EditArgs;
use novel_application::DiscussionRelevance;
use novel_infrastructure::{
    CoauthorCheckPage, CoauthorDecisionContext, CoauthorDecisionsPage, CoauthorDocument,
    DiscussionMessage,
};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::fmt::Write;

pub(super) const PROMPT_VERSION: &str = "coauthor-v22";

#[derive(Default)]
pub(super) struct ToolFailureGuard {
    last: Option<(String, String)>,
    repeats: usize,
}

impl ToolFailureGuard {
    pub(super) fn observe(&mut self, name: &str, result: &Value) -> bool {
        let Some(error) = result["error"].as_str() else {
            self.last = None;
            self.repeats = 0;
            return false;
        };
        if self.last.as_ref().is_some_and(|(previous, message)| previous == name && message == error) {
            self.repeats += 1;
        } else {
            self.last = Some((name.into(), error.into()));
            self.repeats = 1;
        }
        self.repeats >= 3
    }
}

pub(super) fn source_provenance(result: &mut Value) {
    if let Some(hits) = result.get_mut("hits").and_then(Value::as_array_mut) {
        for hit in hits {
            source_provenance(hit);
        }
    }
    let origin = match result["kind"].as_str() {
        Some("ENTITY" | "PLAN" | "MANUSCRIPT" | "FACT" | "RELATION") => "PROJECT_SHARED",
        Some("MESSAGE") => "CURRENT_BRANCH_HISTORY",
        _ => return,
    };
    result["provenance"] = json!({
        "origin":origin, "isDiscussionDecision":false,
        "truthDeterminedByLocation":false,
    });
}

pub(super) fn decision_scope(result: &mut Value, session_id: uuid::Uuid) {
    result["decisionScope"] = json!({
        "sessionId":session_id, "origin":"CURRENT_BRANCH_DISCUSSION",
        "updatesFormalSources":false, "impliesFormalSyncRequired":false,
        "rejectedScope":"EXACT_DECISION_CONTENT_ONLY",
    });
}

pub(super) fn advances_check(name: &str, result: &Value) -> bool {
    matches!(
        name,
        "start_source_check" | "read_check_source" | "record_check_result" | "save_check_note"
    ) && result["executed"] != false
        && (result["check"]["id"].is_string() || result["checkId"].is_string())
}

pub(super) fn retrieval_receipt(
    method: &str,
    query: &str,
    offset: u32,
    history: bool,
    result: &Value,
) -> Value {
    let failed = result["executed"] == false || result.get("error").is_some();
    let hits = result["hits"].as_array();
    let status = if failed || hits.is_none() {
        "UNAVAILABLE"
    } else {
        match result["execution"].as_str() {
            Some("RETURNED_PAGE") => "RETURNED_PAGE",
            Some("INVALID_QUERY") if hits.is_some_and(Vec::is_empty) => "INVALID_QUERY",
            Some("NOT_RUN") if method == "SEMANTIC" && hits.is_some_and(Vec::is_empty) => "NOT_RUN",
            _ => "UNAVAILABLE",
        }
    };
    json!({
        "method":method, "query":query, "offset":offset,
        "scope":if history { "CURRENT_BRANCH_HISTORY" } else { "PROJECT_SOURCES" },
        "status":status,
        "returned":if status == "RETURNED_PAGE" { hits.map(Vec::len) } else { None },
        "hasMore":result.get("hasMore"),
        "contextOmittedHits":result.get("contextOmittedHits"),
        "coverage":result.get("coverage"),
        "indexStatus":if method == "SEMANTIC" {
            json!({"kind":"SEMANTIC_INDEX",
                "indexedChunks":result["status"]["indexedChunks"],
                "pendingUpdates":result["status"]["pendingSourceUpdates"]})
        } else {
            json!({"kind":"SOURCE_SEARCH_INDEX","pendingUpdates":result["pendingIndexUpdates"]})
        },
    })
}

pub(super) fn search_summary(receipts: &[Value]) -> String {
    if receipts.is_empty() {
        return String::new();
    }
    let mut summary =
        "\n\n检索操作回执（程序记录；计数为当次返回页，不是相关条数或全库总数）：\n".to_owned();
    let omitted = receipts.len().saturating_sub(12);
    if omitted > 0 {
        let _ = writeln!(summary, "仅列最近 12 次，另 {omitted} 次见本轮审计。");
    }
    for receipt in receipts.iter().skip(omitted) {
        let method = match receipt["method"].as_str() {
            Some("SEMANTIC") => "语义",
            Some("LEXICAL_FOLLOWUP") => "词面补查",
            _ => "关键词",
        };
        let query = receipt["query"].to_string();
        let scope = if receipt["scope"] == "CURRENT_BRANCH_HISTORY" {
            "本分支历史"
        } else {
            "项目资料"
        };
        let _ = write!(
            summary,
            "- {method} {query}（{scope}，offset={}）：",
            receipt["offset"]
        );
        if receipt["status"] == "RETURNED_PAGE"
            && let Some(count) = receipt["returned"].as_u64()
        {
            let _ = write!(summary, "实际返回 {count} 条");
            if receipt["hasMore"] == true {
                summary.push_str("，仍有后续页");
            }
            if let Some(count) = receipt["contextOmittedHits"]
                .as_u64()
                .filter(|count| *count > 0)
            {
                let _ = write!(summary, "，另因上下文预算省略 {count} 条候选");
            }
        } else if receipt["status"] == "INVALID_QUERY" {
            summary.push_str("未形成有效查询，不能记为 0 命中");
        } else if receipt["status"] == "NOT_RUN" {
            summary.push_str("未调用向量服务（未授权或无可用索引），不是 0 命中");
        } else {
            summary.push_str("未取得有效结果，不能记为 0 命中");
        }
        if matches!(receipt["method"].as_str(), Some("KEYWORD" | "LEXICAL_FOLLOWUP"))
            && let Some(pending) = receipt["indexStatus"]["pendingUpdates"]
                .as_u64()
                .filter(|pending| *pending > 0)
        {
            let _ = write!(summary, "；关键词索引待更新 {pending} 项，不能据此声称查全");
        }
        summary.push_str("。\n");
    }
    if let Some(receipt) = receipts.iter().rev().find(|r| r["method"] == "SEMANTIC") {
        let status = &receipt["indexStatus"];
        if let (Some(chunks), Some(pending)) = (
            status["indexedChunks"].as_u64(),
            status["pendingUpdates"].as_u64(),
        ) {
            let _ = writeln!(
                summary,
                "最近一次语义索引快照：已索引分块 {chunks}，语义索引待更新 {pending}；与查证索引独立，不合并计数。"
            );
        }
    }
    summary.push_str("未检索到不等于不存在；未形成有效查询、未授权或索引不完整均不能证明查全。");
    summary
}

pub(super) struct InputBudget {
    pub initial: usize,
    pub current: usize,
    pub maximum: usize,
    pub expanded: bool,
}

impl InputBudget {
    pub fn new(initial: usize, model_capacity: usize) -> Self {
        const MAX_INPUT_TOKENS: usize = 65_536;
        let initial = initial.min(model_capacity).min(MAX_INPUT_TOKENS);
        Self {
            initial,
            current: initial,
            maximum: initial
                .saturating_mul(2)
                .min(model_capacity)
                .min(MAX_INPUT_TOKENS),
            expanded: false,
        }
    }

    fn expand_once(&mut self, required: usize) -> bool {
        if required <= self.current || self.expanded || self.maximum <= self.current {
            return false;
        }
        self.current = self.maximum;
        self.expanded = true;
        true
    }
}

pub(super) fn history(
    recent: &[DiscussionMessage],
    request: &str,
    contexts: &HashMap<uuid::Uuid, Option<CoauthorDecisionContext>>,
    decisions: &CoauthorDecisionsPage,
    budget: usize,
) -> Vec<Value> {
    let relevance = DiscussionRelevance::new(request);
    let ids: BTreeSet<_> = decisions
        .memories
        .iter()
        .map(|memory| memory.decision.id)
        .collect();
    let mut ranked = recent
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let linked = contexts
                .get(&message.id)
                .and_then(Option::as_ref)
                .is_some_and(|context| {
                    context
                        .guards
                        .iter()
                        .any(|guard| ids.contains(&guard.current.id))
                });
            let score = relevance.score(&message.content) + u16::from(linked) * 7_000;
            (index, score, message)
        })
        .filter(|(index, score, _)| *score > 0 || *index + 2 >= recent.len())
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(index, score, _)| std::cmp::Reverse((*score, *index)));
    let mut used = 0;
    let mut selected = Vec::new();
    for (index, _, message) in ranked.into_iter().take(6) {
        let remaining = budget.saturating_sub(used);
        if remaining < 200 {
            break;
        }
        let limit = remaining.saturating_sub(160).min(900);
        let content = relevance.excerpt(&message.content, limit);
        let entry = json!({
            "id":message.id, "role":message.role, "createdAt":message.created_at,
            "historicalMessage":content,
            "truncated":message.content.chars().count() > limit,
            "decisionContext":contexts.get(&message.id).and_then(Option::as_ref),
            "referenceOnly":true,
        });
        let size = entry.to_string().chars().count();
        if used + size <= budget {
            used += size;
            selected.push((index, entry));
        }
    }
    selected.sort_by_key(|(index, _)| *index);
    selected.into_iter().map(|(_, entry)| entry).collect()
}

pub(super) fn input_size(messages: &[Value], definitions: &[Value]) -> usize {
    json!(messages).to_string().chars().count() + json!(definitions).to_string().chars().count()
}

#[derive(Debug, Clone, Copy)]
pub(super) struct InputEstimate {
    pub chars: usize,
    pub tokens: usize,
}

pub(super) fn estimate_input(messages: &[Value], definitions: &[Value]) -> InputEstimate {
    let message_json = json!(messages).to_string();
    let definitions_json = json!(definitions).to_string();
    let text_tokens =
        novel_application::estimate_input_tokens(&message_json, &definitions_json) as usize;
    InputEstimate {
        chars: input_size(messages, definitions),
        // Protocol wrappers and tokenizer differences are additional to the
        // shared text heuristic. The model envelope separately reserves output.
        tokens: text_tokens
            .saturating_add(text_tokens.div_ceil(5))
            .saturating_add(messages.len().saturating_mul(16))
            .saturating_add(512),
    }
}

pub(super) fn prepare_input(
    messages: &mut Vec<Value>,
    definitions: &[Value],
    budget_tokens: usize,
    audit: &mut Vec<Value>,
) -> InputEstimate {
    let before = estimate_input(messages, definitions);
    if before.tokens > budget_tokens && compact_navigation(messages) {
        let after = estimate_input(messages, definitions);
        audit.push(json!({"kind":"context_compaction","stage":"navigation",
            "beforeChars":before.chars,"afterChars":after.chars,
            "beforeEstimatedInputTokens":before.tokens,"afterEstimatedInputTokens":after.tokens}));
    }
    let before = estimate_input(messages, definitions);
    if before.tokens > budget_tokens {
        let retired = checkpoint_checks(messages);
        if retired > 0 {
            let after = estimate_input(messages, definitions);
            audit.push(json!({"kind":"context_compaction","stage":"check_checkpoint",
                "retiredCalls":retired,"beforeChars":before.chars,"afterChars":after.chars,
                "beforeEstimatedInputTokens":before.tokens,"afterEstimatedInputTokens":after.tokens}));
        }
    }
    estimate_input(messages, definitions)
}

pub(super) fn prepare_request(
    messages: &mut Vec<Value>,
    definitions: &[Value],
    budget: &mut InputBudget,
    audit: &mut Vec<Value>,
) -> InputEstimate {
    let estimate = prepare_input(messages, definitions, budget.current, audit);
    let previous = budget.current;
    if budget.expand_once(estimate.tokens) {
        audit.push(
            json!({"kind":"input_budget_expansion","reason":"INPUT_TOKEN_BUDGET",
            "previousInputTokenBudget":previous,"inputTokenBudget":budget.current,
            "estimatedInputTokens":estimate.tokens,"maxInputTokenBudget":budget.maximum,
            "expansionCount":1,"maxExpansions":1,"configurationPersisted":false,
            "taskRestarted":false,"unit":"tokens"}),
        );
    }
    estimate
}

pub(super) fn budget_notice(estimate: InputEstimate, budget: &InputBudget, first: bool) -> String {
    let action = if first {
        "本轮尚未发送模型请求。请缩短本轮请求或选区，或在「AI 任务模型」中调整讨论的输入预算并核对模型上下文与最大输出设置。"
    } else {
        "已保留当前结果及查证进度，可按清单继续查证；也可在「AI 任务模型」中调整讨论的输入预算。"
    };
    let expansion = if budget.expanded {
        format!(
            "已将本轮输入预算从 {} 临时扩至 {} tokens 一次，仍然不足，不再自动扩容；未修改保存的预算设置。",
            budget.initial, budget.current
        )
    } else {
        "已达到模型可用输入容量或自动扩容保护上限，无法继续扩容；提高输入设置不能突破模型容量。"
            .into()
    };
    format!(
        "本轮上下文超出本地输入预算：估算 {} tokens，允许 {} tokens（已计入工具定义与估算余量，并为输出预留空间）。{expansion}{action}这不是账户余额或费用预算耗尽；估算不等于提供商实际用量。",
        estimate.tokens, budget.current
    )
}

pub(super) fn edit_receipt(args: &EditArgs, document: &CoauthorDocument) -> Value {
    let limit = 1800;
    json!({
        "prepared":true, "applied":false, "formalCommit":false, "syncsOtherSources":false,
        "title":document.title, "baseVersion":document.version,
        "change":{"operation":args.operation,"before":args.before,"after":args.after},
        "contentPreview":document.content.chars().take(limit).collect::<String>(),
        "previewTruncated":document.content.chars().count() > limit,
        "chars":document.content.chars().count(),
        "message":"工作稿建议已准备，尚未采用或正式提交；界面核对后可接入工作稿，不会自动同步其他正式资料。"
    })
}

pub(super) fn draft_reply(initial: &CoauthorDocument, document: &CoauthorDocument) -> String {
    let mut reply = "已准备工作稿建议。运行器尚未采用或正式提交；界面核对后可接入工作稿，不会自动同步设定卡或其他正式资料。".to_owned();
    if initial.content != document.content {
        let total = document.content.chars().count();
        let first_changed = initial
            .content
            .chars()
            .zip(document.content.chars())
            .take_while(|(before, after)| before == after)
            .count();
        let offset = if total > 1800 {
            first_changed.saturating_sub(120)
        } else {
            0
        };
        let preview = document
            .content
            .chars()
            .skip(offset)
            .take(1800)
            .collect::<String>();
        if total > 1800 {
            let _ = write!(
                reply,
                "\n\n修改后工作稿节选（自第 {} 字起，最多 1800 字，完整内容见建议）：\n",
                offset + 1
            );
        } else {
            reply.push_str("\n\n修改后工作稿预览：\n");
        }
        for line in preview.lines() {
            reply.push_str("> ");
            reply.push_str(line);
            reply.push('\n');
        }
    }
    reply
}

fn compact_tool_result(message: &mut Value, result: Value) -> bool {
    let mut candidate = message.clone();
    candidate["content"] = result.to_string().into();
    if estimate_input(std::slice::from_ref(&candidate), &[]).tokens
        >= estimate_input(std::slice::from_ref(message), &[]).tokens
    {
        return false;
    }
    *message = candidate;
    true
}

// Only a successful persisted assessment permits replacing previously delivered
// source text. Tool-call/result pairs and exact identities remain intact.
pub(super) fn compact_assessed_reads(messages: &mut [Value], assessment: &Value) -> usize {
    if assessment["recorded"] != true {
        return 0;
    }
    let Some(entry) = assessment.get("entry") else {
        return 0;
    };
    let mut changed = 0;
    for message in messages
        .iter_mut()
        .filter(|message| message["role"] == "tool")
    {
        let Some(content) = message["content"].as_str() else {
            continue;
        };
        let Ok(read) = serde_json::from_str::<Value>(content) else {
            continue;
        };
        if read.get("readId").is_none()
            || read.get("checkId").is_none()
            || read["checkId"] != assessment["check"]["id"]
            || read["key"] != entry["key"]
            || read["revision"] != entry["revision"]
            || read.get("content").is_none()
        {
            continue;
        }
        let compact = json!({
            "checkId":read["checkId"], "key":read["key"], "revision":read["revision"],
            "title":read["title"], "offset":read["offset"], "totalChars":read["totalChars"],
            "assessment":entry["assessment"], "reason":entry["reason"], "quote":entry["quote"],
            "provenance":{"origin":"DERIVED_CHECK_ASSESSMENT","isDiscussionDecision":false},
            "compacted":true, "notice":"原文此前已送达，判断已落库；摘要不是新的原文读取，细节请read_check_source重读。"
        });
        if compact_tool_result(message, compact) {
            changed += 1;
        }
    }
    // Older progress counters are superseded by this receipt; retain each
    // persisted judgment, not six copies of the same full check header.
    let mut latest = true;
    for message in messages
        .iter_mut()
        .rev()
        .filter(|message| message["role"] == "tool")
    {
        let Some(content) = message["content"].as_str() else {
            continue;
        };
        let Ok(mut result) = serde_json::from_str::<Value>(content) else {
            continue;
        };
        if result["recorded"] != true
            || result["check"]["id"] != assessment["check"]["id"]
            || result.get("entry").is_none()
        {
            continue;
        }
        if latest {
            latest = false;
            continue;
        }
        result["check"] = json!({"id":assessment["check"]["id"],"progressSnapshotOmitted":true});
        if compact_tool_result(message, result) {
            changed += 1;
        }
    }
    changed
}

pub(super) fn compact_navigation(messages: &mut [Value]) -> bool {
    let mut changed = false;
    for message in messages
        .iter_mut()
        .filter(|message| message["role"] == "user")
        .take(1)
    {
        let Some(content) = message["content"].as_str() else {
            continue;
        };
        let Ok(mut navigation) = serde_json::from_str::<Value>(content) else {
            continue;
        };
        if navigation["contextOnly"] != true || navigation["navigationCompacted"] == true {
            continue;
        }
        if let Some(hits) = navigation["supplementalSources"]["result"]["hits"].as_array() {
            let seed = navigation["relevantSources"]["hits"].as_array().into_iter().flatten()
                .find(|hit| hit["key"] == navigation["supplementalSources"]["seedKey"]
                    && hit["revision"] == navigation["supplementalSources"]["seedRevision"]);
            let pointers = hits.iter().take(1).chain(seed).map(|hit| json!({
                "key":hit["key"],"revision":hit["revision"],"title":hit["title"],
                "navigationOnly":true,"sourceTextRetained":false,
            })).collect::<Vec<_>>();
            if !pointers.is_empty() {
                navigation["sourcePointers"] = json!(pointers);
            }
        }
        let Some(object) = navigation.as_object_mut() else {
            continue;
        };
        for key in ["historicalMessages", "relevantSources", "semanticSources", "supplementalSources"] {
            object.remove(key);
        }
        object.insert("navigationCompacted".into(), json!(true));
        object.insert("notice".into(), json!("已移除历史与检索导航以节省预算，不表示没有相关内容；需要时重新检索。当前请求、最新决定、选区和工作稿定位保留。"));
        message["content"] = navigation.to_string().into();
        changed = true;
    }
    changed
}

struct ToolExchange {
    parent: usize,
    index: usize,
    id: String,
    name: String,
    result: Value,
}

pub(super) fn source_delivery_receipts(messages: &[Value]) -> Vec<Value> {
    tool_exchanges(messages).into_iter().filter_map(|exchange| {
        let result = exchange.result;
        if exchange.name != "read_source" || result["executed"] == false
            || result.get("error").is_some() {
            return None;
        }
        let key = result["key"].as_str()?;
        let revision = result["revision"].as_str()?;
        let content = result["content"].as_str()?;
        let offset = result["offset"].as_u64()?;
        Some(json!({"toolCallId":exchange.id,"key":key,"revision":revision,
            "offset":offset,"chars":content.chars().count(),"hasMore":result["hasMore"]}))
    }).collect()
}

fn tool_exchanges(messages: &[Value]) -> Vec<ToolExchange> {
    let mut pending = HashMap::new();
    let mut exchanges = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if message["role"] == "assistant" {
            pending.clear();
            for call in message["tool_calls"].as_array().into_iter().flatten() {
                if let (Some(id), Some(name)) =
                    (call["id"].as_str(), call["function"]["name"].as_str())
                {
                    pending.insert(id, (index, name));
                }
            }
        } else if message["role"] == "tool"
            && let Some(id) = message["tool_call_id"].as_str()
            && let Some((parent, name)) = pending.remove(id)
            && let Some(content) = message["content"].as_str()
            && let Ok(result) = serde_json::from_str::<Value>(content)
        {
            exchanges.push(ToolExchange {
                parent,
                index,
                id: id.into(),
                name: name.into(),
                result,
            });
        }
    }
    exchanges
}

pub(super) fn checkpoint_checks(messages: &mut Vec<Value>) -> usize {
    let Some(context_index) = messages
        .iter()
        .position(|message| message["role"] == "user")
    else {
        return 0;
    };
    let Some(raw) = messages[context_index]["content"].as_str() else {
        return 0;
    };
    let Ok(mut navigation) = serde_json::from_str::<Value>(raw) else {
        return 0;
    };
    if navigation["contextOnly"] != true {
        return 0;
    }
    let exchanges = tool_exchanges(messages);
    let mut assessments = navigation["checkAssessments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut retired = BTreeSet::new();
    let mut retired_results = BTreeSet::new();
    for exchange in &exchanges {
        let result = &exchange.result;
        if exchange.name != "record_check_result"
            || result["recorded"] != true
            || result["entry"]["revision"].as_str().is_none()
            || result["entry"]["key"].as_str().is_none()
            || result["check"]["id"].as_str().is_none()
        {
            continue;
        }
        assessments.retain(|saved| {
            saved["check"]["id"] != result["check"]["id"]
                || saved["entry"]["key"] != result["entry"]["key"]
        });
        assessments.push(
            json!({"check":{"id":result["check"]["id"]},"entry":result["entry"],
            "recorded":true,"formalCommit":false}),
        );
        retired.insert((exchange.parent, exchange.id.clone()));
        retired_results.insert(exchange.index);
    }
    if retired.is_empty() {
        return 0;
    }
    for exchange in &exchanges {
        let read = &exchange.result;
        if exchange.name == "read_check_source"
            && assessments.iter().any(|saved| {
                saved["check"]["id"] == read["checkId"]
                    && saved["entry"]["key"] == read["key"]
                    && saved["entry"]["revision"] == read["revision"]
            })
        {
            retired.insert((exchange.parent, exchange.id.clone()));
            retired_results.insert(exchange.index);
        }
    }
    navigation["checkAssessments"] = json!(assessments);
    navigation["checkCheckpointNotice"] = json!(
        "这些是本轮工具已落库判断的阶段检查点，不是作者决定、正式事实或新的原文读取。完整调用及原文保留在运行审计；当前进度须get_source_checks，细节须重读。"
    );
    messages[context_index]["content"] = navigation.to_string().into();
    for (index, message) in messages
        .iter_mut()
        .enumerate()
        .filter(|(_, message)| message["role"] == "assistant")
    {
        if let Some(pending) = message["tool_calls"].as_array_mut() {
            pending.retain(|call| {
                !call["id"]
                    .as_str()
                    .is_some_and(|id| retired.contains(&(index, id.to_owned())))
            });
            if pending.is_empty() {
                message.as_object_mut().unwrap().remove("tool_calls");
            }
        }
    }
    let mut position = 0;
    messages.retain(|message| {
        let keep = !(retired_results.contains(&position)
            || message["role"] == "assistant"
                && message.get("tool_calls").is_none()
                && message["content"].as_str().is_none_or(str::is_empty));
        position += 1;
        keep
    });
    retired_results.len()
}

pub(super) fn check_summary(page: &CoauthorCheckPage) -> String {
    let check = &page.check;
    let mut summary = format!(
        "\n\n查证台账「{}」：读取 {}/{}，送达 {}/{}，已判断 {}/{}；相关 {}，无关 {}，不确定 {}，未判断 {}。清单 {}。\n",
        check.title,
        check.read,
        check.total,
        check.sent,
        check.total,
        check.reviewed,
        check.total,
        check.relevant,
        check
            .reviewed
            .saturating_sub(check.relevant + check.uncertain),
        check.uncertain,
        check.total.saturating_sub(check.reviewed),
        check.id,
    );
    let _ = writeln!(
        summary,
        "范围仅限 {}；不代表范围外资料或全书已查全。逐项理由是模型判断，不是作者决定或正式事实。",
        check.kinds.join("、")
    );
    let _ = writeln!(
        summary,
        "当前查证索引待更新 {}；不是语义索引的待更新数。",
        check.pending_index_updates
    );
    for (status, label) in [
        (Some("RELEVANT"), "相关"),
        (Some("IRRELEVANT"), "无关"),
        (Some("UNCERTAIN"), "不确定"),
        (None, "未判断"),
    ] {
        let entries: Vec<_> = page
            .entries
            .iter()
            .filter(|entry| entry.assessment.as_deref() == status)
            .collect();
        if entries.is_empty() {
            continue;
        }
        let _ = write!(summary, "\n{label}：\n");
        for entry in entries {
            let reason = if entry.reason.is_empty() {
                entry
                    .last_error
                    .as_deref()
                    .unwrap_or("尚未记录判断，需继续读取或核对。")
            } else {
                &entry.reason
            };
            let reason_preview = reason.chars().take(160).collect::<String>();
            let _ = writeln!(
                summary,
                "- {} [{}]{}：{}",
                entry.title,
                entry.key,
                if entry.stale {
                    "（版本待复核，仅作历史）"
                } else {
                    ""
                },
                reason_preview
            );
            if reason.chars().count() > 160 {
                summary.push_str("  （理由节选，完整内容见查证台账。）\n");
            }
            if !entry.quote.is_empty() {
                let _ = writeln!(
                    summary,
                    "  原文引句：{}",
                    entry.quote.chars().take(160).collect::<String>()
                );
                if entry.quote.chars().count() > 160 {
                    summary.push_str("  （引句节选，完整内容见查证台账。）\n");
                }
            }
        }
    }
    if page.has_more {
        summary
            .push_str("\n这里只列首批条目，并非全部分类；用 get_source_checks 按 offset 续页。\n");
    }
    if check.complete {
        summary.push_str("\n本清单读取与判断流程完成，不代表语义判断全部正确或全书已修复。");
    } else if check.read == check.total
        && check.sent == check.total
        && check.reviewed == check.total
        && check.uncertain > 0
        && check.needs_review == 0
        && check.stale == 0
        && check.added == 0
        && check.pending_index_updates == 0
    {
        let _ = write!(
            summary,
            "\n本清单各项均已完成读取、送达与判断；仍有 {} 项不确定，疑点尚未解决，不能称为全部查证完成。",
            check.uncertain
        );
    } else {
        let _ = write!(
            summary,
            "\n尚未完成查证：未读完 {}，未完整送达 {}，未判断 {}，待核对 {}，旧版本 {}，新增 {}，查证索引待更新 {}。可按清单身份继续；不确定项不能算已解决。",
            check.total.saturating_sub(check.read),
            check.total.saturating_sub(check.sent),
            check.total.saturating_sub(check.reviewed),
            check.needs_review,
            check.stale,
            check.added,
            check.pending_index_updates,
        );
    }
    summary
}

#[cfg(test)]
mod tests;
