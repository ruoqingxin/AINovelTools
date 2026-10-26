use super::{CoauthorError, ReadEvidence};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fmt::Write;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ReplyMode {
    Discussion,
    Continuation,
    Reprint,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reply {
    mode: ReplyMode,
    content: String,
    request_quote: Option<String>,
    continuation: Option<Continuation>,
    pub rule_changes: Vec<RuleChange>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Continuation {
    reference: Option<String>,
    message_id: Option<uuid::Uuid>,
    anchor: Option<String>,
    #[serde(default)]
    preserved_quotes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuleChange {
    pub key: String,
    pub revision: String,
    quote: String,
    proposal: String,
}

impl Reply {
    pub(super) fn continuation_id(
        &self,
        messages: &[Value],
    ) -> Result<Option<uuid::Uuid>, CoauthorError> {
        self.continuation
            .as_ref()
            .map(|value| resolve_continuation(value, messages).map(|(id, _)| id))
            .transpose()
    }
}

pub(super) fn definition() -> Value {
    json!({"type":"function","function":{
        "name":"deliver_reply",
        "description":"单独交付最终回复，成功即结束；续写只新增，规则改动列ruleChanges。",
        "parameters":{"type":"object","additionalProperties":false,
            "properties":{
                "mode":{"type":"string","enum":["DISCUSSION","CONTINUATION","REPRINT"]},
                "content":{"type":"string"},
                "requestQuote":{"type":["string","null"]},
                "continuation":{"type":["object","null"],"additionalProperties":false,"properties":{
                    "reference":{"type":"string","description":"已送达AI的continuationReference原值"},
                    "preservedQuotes":{"type":"array","maxItems":8,"items":{"type":"string"}}
                },"required":["reference","preservedQuotes"]},
                "ruleChanges":{"type":"array","maxItems":8,"items":{
                    "type":"object","additionalProperties":false,"properties":{
                        "key":{"type":"string"},"revision":{"type":"string"},
                        "quote":{"type":"string"},
                        "proposal":{"type":"string"}
                    },"required":["key","revision","quote","proposal"]}}
            },"required":["mode","content","requestQuote","continuation","ruleChanges"]}
    }})
}

fn invalid(message: &str) -> CoauthorError {
    CoauthorError::Invalid(message.into())
}

const ASSISTANT_PREFIX: &str = "历史发言 [ASSISTANT]（不等于有效决定或正式事实）：";

pub(super) fn attach_reference(result: &mut Value, index: usize) {
    if result["kind"] == "MESSAGE"
        && result["offset"] == 0
        && result["executed"] != false
        && result["content"]
            .as_str()
            .and_then(|content| content.strip_prefix(ASSISTANT_PREFIX))
            .is_some_and(|content| content.trim().chars().count() >= 8)
    {
        result["continuationReference"] = json!(format!("read-{index}"));
    }
}

// References are resolved from this request's actual context, never user JSON or a registry
// that could survive compaction, a branch switch, or another run.
fn references(messages: &[Value]) -> Vec<(String, uuid::Uuid, String)> {
    let mut references = Vec::new();
    if let Some(message) = messages.iter().find(|message| message["role"] == "user")
        && let Ok(context) = serde_json::from_str::<Value>(message["content"].as_str().unwrap_or(""))
        && context["contextOnly"] == true
    {
        for entry in context["historicalMessages"].as_array().into_iter().flatten() {
            if entry["role"] == "ASSISTANT"
                && let (Some(reference), Some(id), Some(content)) = (
                    entry["continuationReference"].as_str(),
                    entry["id"].as_str().and_then(|id| id.parse().ok()),
                    entry["historicalMessage"].as_str(),
                )
            {
                references.push((reference.into(), id, content.into()));
            }
        }
    }
    for message in messages.iter().filter(|message| message["role"] == "tool") {
        let Ok(result) = serde_json::from_str::<Value>(message["content"].as_str().unwrap_or(""))
        else {
            continue;
        };
        if result["kind"] == "MESSAGE"
            && result["offset"] == 0
            && result["executed"] != false
            && let (Some(reference), Some(id), Some(content)) = (
                result["continuationReference"].as_str(),
                result["key"]
                    .as_str()
                    .and_then(|key| key.strip_prefix("MESSAGE:"))
                    .and_then(|id| id.parse().ok()),
                result["content"].as_str().and_then(|content| content.strip_prefix(ASSISTANT_PREFIX)),
            )
        {
            references.push((reference.into(), id, content.into()));
        }
    }
    references
}

fn resolve_continuation(
    continuation: &Continuation,
    messages: &[Value],
) -> Result<(uuid::Uuid, String), CoauthorError> {
    if let Some(reference) = &continuation.reference {
        if continuation.message_id.is_some() || continuation.anchor.is_some() {
            return Err(invalid("续写reference与旧messageId/anchor不能混用，请只选择程序提供的reference。"));
        }
        let (_, id, content) = references(messages)
            .into_iter()
            .find(|(candidate, _, _)| candidate == reference)
            .ok_or_else(|| invalid("续写reference不在当前已送达AI上下文中；请先查询本分支历史并read_source读取，不猜测引用。"))?;
        let anchor = content.trim().chars().take(200).collect::<String>();
        if anchor.chars().count() < 8 {
            return Err(invalid("承接原文不足8字，请读取完整的本分支AI原回复。"));
        }
        return Ok((id, anchor));
    }
    match (continuation.message_id, &continuation.anchor) {
        (Some(id), Some(anchor)) => Ok((id, anchor.clone())),
        _ => Err(invalid("续写须提供continuation.reference；旧格式须同时有continuation.messageId与anchor。")),
    }
}

// Compare Unicode windows without LCS or modifying the author's prose.
fn repeated_excerpt<'a>(previous: &str, current: &'a str) -> Option<&'a str> {
    fn windows(text: &str) -> impl Iterator<Item = &str> {
        let mut offsets: Vec<_> = text.char_indices().map(|(index, _)| index).collect();
        offsets.push(text.len());
        (0..offsets.len().saturating_sub(80))
            .map(move |index| &text[offsets[index]..offsets[index + 80]])
    }
    if current.chars().take(80).count() < 80 {
        return None;
    }
    let old: HashSet<_> = windows(previous).collect();
    windows(current).find(|window| old.contains(window))
}

fn repeats(previous: &str, current: &str) -> bool {
    repeated_excerpt(previous, current).is_some()
}

fn without_quotes<'a>(content: &'a str, quotes: &[String]) -> Vec<&'a str> {
    let mut segments = vec![content];
    for quote in quotes {
        segments = segments
            .into_iter()
            .flat_map(|segment| segment.split(quote))
            .collect();
    }
    segments
}

fn author_permits_quote(request: &str, quote: &str) -> bool {
    let core = quote.trim_end_matches(['。', '！', '？', '.', '!', '?']);
    !core.trim().is_empty() && request.contains(core)
}

// Only the literal "保留X这句" form is inferred, never a general intent classifier.
fn requested_quotes(request: &str, fragments: &[String]) -> Vec<String> {
    request
        .match_indices("保留")
        .filter(|(offset, _)| {
            !["不", "不要", "不必", "无需", "别"]
                .iter()
                .any(|negative| request[..*offset].ends_with(negative))
        })
        .filter_map(|(offset, _)| request[offset + "保留".len()..].split_once("这句"))
        .map(|(quote, _)| quote.trim())
        .filter(|quote| {
            !quote.is_empty()
                && quote.chars().count() <= 2000
                && fragments.iter().any(|fragment| fragment.contains(quote))
        })
        .take(8)
        .map(String::from)
        .collect()
}

fn declares_rule_change(content: &str) -> bool {
    let mut fenced = false;
    content.lines().any(|line| {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            return false;
        }
        if fenced || line.starts_with('>') {
            return false;
        }
        line.split_inclusive(['。', '！', '？', '\n'])
            .any(|sentence| {
                let sentence = sentence.trim_start_matches([' ', '\t', '*', '-']);
                !sentence.ends_with(['？', '?'])
                    && ["这属于改规则", "这需要明确改动原文", "这是改规则"]
                        .iter()
                        .any(|declaration| sentence.starts_with(declaration))
            })
    })
}

fn assistant_fragments(
    id: uuid::Uuid,
    messages: &[Value],
    seen: &HashMap<String, ReadEvidence>,
) -> Vec<String> {
    let mut fragments = Vec::new();
    for message in messages
        .iter()
        .filter(|message| message["role"] == "user")
        .take(1)
    {
        let Ok(context) = serde_json::from_str::<Value>(message["content"].as_str().unwrap_or(""))
        else {
            continue;
        };
        if context["contextOnly"] != true {
            continue;
        }
        for entry in context["historicalMessages"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if entry["id"] == id.to_string()
                && entry["role"] == "ASSISTANT"
                && let Some(content) = entry["historicalMessage"].as_str()
            {
                fragments.push(content.into());
            }
        }
    }
    if let Some(read) = seen.get(&format!("MESSAGE:{id}")) {
        let sent = &read.fragments[..read.sent_fragments.min(read.fragments.len())];
        if sent.iter().any(|fragment| {
            fragment.starts_with("历史发言 [ASSISTANT]（不等于有效决定或正式事实）：")
        }) {
            fragments.extend(sent.iter().cloned());
        }
    }
    fragments
}

pub(super) fn validate(
    reply: &Reply,
    request: &str,
    messages: &[Value],
    seen: &HashMap<String, ReadEvidence>,
    previous_assistant: &[&str],
) -> Result<String, CoauthorError> {
    let mut errors = Vec::new();
    if reply.content.trim().is_empty() || reply.content.chars().count() > 50_000 {
        errors.push("交付正文须非空且不超过50000字。");
    }
    if !matches!(reply.mode, ReplyMode::Discussion) {
        let quote = reply.request_quote.as_deref().unwrap_or("");
        if quote.trim().is_empty() || quote.chars().count() > 2000 || !request.contains(quote) {
            errors.push("续写或重贴须提供本轮作者准确原话requestQuote，不得引用历史指令。");
        }
    }
    match (&reply.mode, &reply.continuation) {
        (ReplyMode::Continuation, Some(continuation)) => {
            let resolved = resolve_continuation(continuation, messages);
            let fragments = if let Ok((id, anchor)) = &resolved {
                let fragments = assistant_fragments(*id, messages, seen);
                if !(8..=200).contains(&anchor.chars().count())
                    || !fragments.iter().any(|fragment| fragment.contains(anchor))
                {
                    errors.push("续写承接点须为已送达的本分支AI原回复中的8至200字准确片段；缺失时先search_sources(history=true)并read_source读取，不能猜测方案。");
                }
                fragments
            } else {
                errors.push("续写须提供有效continuation.reference；旧格式须同时有continuation.messageId和准确anchor。");
                Vec::new()
            };
            if continuation.preserved_quotes.len() > 8
                || continuation.preserved_quotes.iter().any(|quote| {
                    quote.trim().is_empty()
                        || quote.chars().count() > 2000
                        || !author_permits_quote(request, quote)
                        || !reply.content.contains(quote)
                        || !fragments.iter().any(|fragment| fragment.contains(quote))
                })
            {
                errors.push("保留原句须同时存在于本轮作者请求、所承接回复及content；仅允许请求省略句末标点，最多8句，每句不超过2000字。");
            }
            let mut quotes = continuation.preserved_quotes.clone();
            for quote in requested_quotes(request, &fragments) {
                if !reply.content.contains(&quote) {
                    errors.push("content缺少作者明确要求保留的原句，不能清空preservedQuotes绕过。");
                }
                if !quotes.contains(&quote) {
                    quotes.push(quote);
                }
            }
            let segments = without_quotes(&reply.content, &quotes);
            if !segments
                .iter()
                .any(|segment| segment.chars().any(char::is_alphanumeric))
            {
                errors.push("续写不能只提交保留原句，请在content交付新增正文。");
            }
            if segments.iter().any(|segment| {
                previous_assistant
                    .iter()
                    .copied()
                    .chain(fragments.iter().map(String::as_str))
                    .any(|previous| repeats(previous, segment))
            }) {
                errors.push("续写含连续80字旧回复原文；仅保留作者指定原句，其余请交付新增正文。不能改模式绕过；REPRINT只适用于作者本轮明确要求全文整合。");
            }
        }
        (ReplyMode::Continuation, None) => {
            errors.push("续写必须提供continuation.reference与preservedQuotes（旧格式continuation.messageId和anchor仍须准确），不能以询问是否继续代替交付。");
        }
        (_, Some(_)) => {
            errors.push("非续写模式不能附continuation；请按本轮意图选用正确模式。");
        }
        _ => {}
    }
    if reply.rule_changes.len() > 8 {
        errors.push("单次规则改动提案最多8项，请分批讨论。");
    }
    if reply.rule_changes.is_empty() && declares_rule_change(&reply.content) {
        errors.push("正文明确自述改规则，但ruleChanges为空；请按已读原文列出改动提案，不能只改措辞隐去差异。");
    }
    let mut output = reply.content.clone();
    for change in &reply.rule_changes {
        if !["ENTITY:", "PLAN:", "MANUSCRIPT:", "FACT:", "RELATION:"]
            .iter()
            .any(|prefix| change.key.starts_with(prefix))
            || change.quote.trim().is_empty()
            || change.quote.chars().count() > 500
            || change.proposal.trim().is_empty()
            || change.proposal.chars().count() > 2000
            || !seen.get(&change.key).is_some_and(|read| {
                read.revision == change.revision
                    && read
                        .fragments
                        .iter()
                        .take(read.sent_fragments)
                        .any(|fragment| fragment.contains(&change.quote))
            })
        {
            errors.push("规则改动须引用本轮已读取并送达的准确key/revision及原文quote，另写非空proposal；历史建议或候选摘要不能作为规则原文。");
        }
    }
    if !errors.is_empty() {
        errors.sort_unstable();
        errors.dedup();
        return Err(invalid(&errors.join("\n")));
    }
    if !reply.rule_changes.is_empty() {
        output.push_str("\n\n规则改动提案（待作者决定，未修改正式资料；仅核对引文身份，不代表语义一致性已验证）：");
        for change in &reply.rule_changes {
            let _ = write!(
                output,
                "\n- 依据 {} @ {}：「{}」\n  提案：{}",
                change.key, change.revision, change.quote, change.proposal
            );
        }
    }
    Ok(output)
}

pub(super) fn recovery(
    args: Option<&Reply>,
    request: &str,
    messages: &[Value],
    previous_assistant: &[&str],
) -> Value {
    let available = references(messages);
    let fragments = available.iter().map(|(_, _, content)| content.clone()).collect::<Vec<_>>();
    let previous = previous_assistant.iter().copied().chain(fragments.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let mut quotes = requested_quotes(request, &fragments);
    if let Some(continuation) = args.and_then(|args| args.continuation.as_ref()) {
        for quote in &continuation.preserved_quotes {
            if author_permits_quote(request, quote)
                && previous.iter().any(|content| content.contains(quote))
                && !quotes.contains(quote)
            {
                quotes.push(quote.clone());
            }
        }
    }
    let repeated = args.filter(|args| matches!(args.mode, ReplyMode::Continuation)).and_then(|args| {
        without_quotes(&args.content, &quotes).into_iter().find_map(|segment| {
            previous.iter().find_map(|previous| repeated_excerpt(previous, segment))
        })
    });
    json!({
        "action":if repeated.is_some() { "REGENERATE_CONTENT" } else { "REPAIR_ARGUMENTS" },
        "contentMustChange":repeated.is_some(),
        "repeatedExcerpt":repeated,
        "preserveQuotes":quotes,
        "continuationReferences":available.into_iter().take(8).map(|(reference, _, content)|
            json!({"reference":reference,"excerpt":content.chars().take(80).collect::<String>()}))
            .collect::<Vec<_>>(),
        "instruction":if repeated.is_some() {
            "重写content：只保留作者指定原句，从所选方案结尾推进新增情节，不再复述旧段；只改reference、anchor或模式不能修复正文重复。失败正文已保留审计，不是可继续照抄的草稿。"
        } else {
            "按本轮错误修正参数；有可用continuationReference时只复制reference，不填写UUID/anchor。没有可用引用先检索并读取本分支AI原回复，不猜测。"
        },
    })
}

// Keep the unmodified call in the audit, but do not anchor the next generation to an
// entire rejected draft. No author text, accepted output, or preserved sentence is edited.
pub(super) fn compact_rejected_content(messages: &mut [Value], call_id: &str) -> bool {
    for message in messages.iter_mut().rev().filter(|message| message["role"] == "assistant") {
        for call in message["tool_calls"].as_array_mut().into_iter().flatten() {
            if call["id"] != call_id || call["function"]["name"] != "deliver_reply" {
                continue;
            }
            let Ok(mut args) = serde_json::from_str::<Value>(
                call["function"]["arguments"].as_str().unwrap_or(""),
            ) else {
                return false;
            };
            args["content"] = json!("（未通过的重复正文已从请求上下文移除；原文保留审计。按工具recovery重新生成新增正文，保留指定原句。）");
            call["function"]["arguments"] = json!(args.to_string());
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests;
