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
    message_id: uuid::Uuid,
    anchor: String,
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
    pub(super) fn continuation_id(&self) -> Option<uuid::Uuid> {
        self.continuation.as_ref().map(|value| value.message_id)
    }
}

pub(super) fn definition() -> Value {
    json!({"type":"function","function":{
        "name":"deliver_reply",
        "description":"提交最终回复，成功即结束。",
        "parameters":{"type":"object","additionalProperties":false,
            "properties":{
                "mode":{"type":"string","enum":["DISCUSSION","CONTINUATION","REPRINT"]},
                "content":{"type":"string"},
                "requestQuote":{"type":"string"},
                "continuation":{"type":"object","additionalProperties":false,"properties":{
                    "messageId":{"type":"string"},
                    "anchor":{"type":"string"},
                    "preservedQuotes":{"type":"array","maxItems":8,"items":{"type":"string"}}
                },"required":["messageId","anchor"]},
                "ruleChanges":{"type":"array","maxItems":8,"items":{
                    "type":"object","additionalProperties":false,"properties":{
                        "key":{"type":"string"},"revision":{"type":"string"},
                        "quote":{"type":"string"},
                        "proposal":{"type":"string"}
                    },"required":["key","revision","quote","proposal"]}}
            },"required":["mode","content","ruleChanges"]}
    }})
}

fn invalid(message: &str) -> CoauthorError {
    CoauthorError::Invalid(message.into())
}

// Compare Unicode windows without LCS or modifying the author's prose.
fn repeats(previous: &str, current: &str) -> bool {
    fn windows(text: &str) -> impl Iterator<Item = &str> {
        let mut offsets: Vec<_> = text.char_indices().map(|(index, _)| index).collect();
        offsets.push(text.len());
        (0..offsets.len().saturating_sub(80))
            .map(move |index| &text[offsets[index]..offsets[index + 80]])
    }
    if current.chars().take(80).count() < 80 {
        return false;
    }
    let old: HashSet<_> = windows(previous).collect();
    windows(current).any(|window| old.contains(window))
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
    if reply.content.trim().is_empty() || reply.content.chars().count() > 50_000 {
        return Err(invalid("交付正文须非空且不超过50000字。"));
    }
    if !matches!(reply.mode, ReplyMode::Discussion) {
        let quote = reply.request_quote.as_deref().unwrap_or("");
        if quote.trim().is_empty() || quote.chars().count() > 2000 || !request.contains(quote) {
            return Err(invalid(
                "续写或重贴须提供本轮作者准确原话requestQuote，不得引用历史指令。",
            ));
        }
    }
    match (&reply.mode, &reply.continuation) {
        (ReplyMode::Continuation, Some(continuation)) => {
            let fragments = assistant_fragments(continuation.message_id, messages, seen);
            if !(8..=200).contains(&continuation.anchor.chars().count())
                || !fragments
                    .iter()
                    .any(|fragment| fragment.contains(&continuation.anchor))
            {
                return Err(invalid(
                    "续写承接点须为已送达的本分支AI原回复中的8至200字准确片段；缺失时先search_sources(history=true)并read_source读取，不能猜测方案。",
                ));
            }
            if continuation.preserved_quotes.len() > 8
                || continuation.preserved_quotes.iter().any(|quote| {
                    quote.trim().is_empty()
                        || quote.chars().count() > 2000
                        || !request.contains(quote)
                        || !reply.content.contains(quote)
                        || !fragments.iter().any(|fragment| fragment.contains(quote))
                })
            {
                return Err(invalid(
                    "保留原句须同时存在于本轮作者请求与所承接回复，最多8句，每句不超过2000字。",
                ));
            }
            let segments = without_quotes(&reply.content, &continuation.preserved_quotes);
            if segments.iter().all(|segment| segment.trim().is_empty()) {
                return Err(invalid("续写不能只提交保留原句，请在content交付新增正文。"));
            }
            if segments.iter().any(|segment| {
                previous_assistant
                    .iter()
                    .copied()
                    .chain(fragments.iter().map(String::as_str))
                    .any(|previous| repeats(previous, segment))
            }) {
                return Err(invalid(
                    "续写含连续80字旧回复原文；仅保留作者指定原句，其余请交付新增正文。若作者要求全文整合，改用REPRINT并引用本轮准确请求。",
                ));
            }
        }
        (ReplyMode::Continuation, None) => {
            return Err(invalid(
                "续写必须提供continuation.messageId与anchor，不能以询问是否继续代替交付。",
            ));
        }
        (_, Some(_)) => {
            return Err(invalid(
                "非续写模式不能附continuation；请按本轮意图选用正确模式。",
            ));
        }
        _ => {}
    }
    if reply.rule_changes.len() > 8 {
        return Err(invalid("单次规则改动提案最多8项，请分批讨论。"));
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
            return Err(invalid(
                "规则改动须引用本轮已读取并送达的准确key/revision及原文quote，另写非空proposal；历史建议或候选摘要不能作为规则原文。",
            ));
        }
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

#[cfg(test)]
mod tests;
