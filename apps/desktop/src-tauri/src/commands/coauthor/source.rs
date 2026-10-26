use super::{CoauthorError, ModelToolCall, SourceArgs, arguments};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    reference: Option<String>,
    key: Option<String>,
    revision: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "super::read_limit")]
    limit: usize,
}

fn identity(value: &Value) -> Option<(&str, &str)> {
    let key = value["key"].as_str()?;
    let revision = value["revision"].as_str()?;
    let (kind, id) = key.split_once(':')?;
    (!id.is_empty()
        && !revision.trim().is_empty()
        && matches!(
            kind,
            "ENTITY" | "PLAN" | "MANUSCRIPT" | "FACT" | "RELATION" | "MESSAGE"
        ))
    .then_some((key, revision))
}

fn attach_fact_references(value: &mut Value, index: usize, ordinal: &mut usize) {
    for fact in value
        .get_mut("knowledgeContext")
        .and_then(|context| context.get_mut("facts"))
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if identity(fact).is_some_and(|(key, _)| key.starts_with("FACT:")) {
            *ordinal += 1;
            fact["sourceReference"] = json!(format!("source-{index}-{ordinal}"));
        }
    }
}

pub(super) fn attach_references(value: &mut Value, index: usize) {
    let mut ordinal = 0;
    if value["executed"] == false || value.get("error").is_some() {
        return;
    }
    for hit in value
        .get_mut("hits")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if identity(hit).is_some() {
            ordinal += 1;
            hit["sourceReference"] = json!(format!("source-{index}-{ordinal}"));
            attach_fact_references(hit, index, &mut ordinal);
        }
    }
    if identity(value).is_some() {
        value["sourceReference"] = json!(format!("source-{index}-0"));
        attach_fact_references(value, index, &mut ordinal);
    }
}

fn candidates(messages: &[Value]) -> Vec<Value> {
    let mut sources = Vec::new();
    if let Some(message) = messages.iter().find(|message| message["role"] == "user")
        && let Ok(context) =
            serde_json::from_str::<Value>(message["content"].as_str().unwrap_or(""))
        && context["contextOnly"] == true
    {
        for page in [
            &context["relevantSources"],
            &context["semanticSources"],
            &context["supplementalSources"]["result"],
        ] {
            sources.extend(page["hits"].as_array().into_iter().flatten().cloned());
        }
        sources.extend(
            context["sourcePointers"]
                .as_array()
                .into_iter()
                .flatten()
                .cloned(),
        );
    }
    // Only actual source-producing tool exchanges grant references. Novel text and
    // later author messages, including JSON that resembles context, never do.
    let mut pending = std::collections::HashSet::new();
    for message in messages {
        if message["role"] == "assistant" {
            pending.clear();
            for call in message["tool_calls"].as_array().into_iter().flatten() {
                if matches!(
                    call["function"]["name"].as_str(),
                    Some(
                        "search_sources"
                            | "search_semantic_sources"
                            | "read_source"
                            | "get_related_knowledge"
                    )
                ) && let Some(id) = call["id"].as_str()
                {
                    pending.insert(id.to_owned());
                }
            }
        } else if message["role"] == "tool"
            && let Some(id) = message["tool_call_id"].as_str()
            && pending.remove(id)
            && let Ok(result) =
                serde_json::from_str::<Value>(message["content"].as_str().unwrap_or(""))
            && result["executed"] != false
            && result.get("error").is_none()
        {
            sources.extend(result["hits"].as_array().into_iter().flatten().cloned());
            sources.push(result);
        }
    }
    let facts = sources
        .iter()
        .filter(|source| identity(source).is_some())
        .flat_map(|source| {
            source["knowledgeContext"]["facts"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .filter(|fact| identity(fact).is_some_and(|(key, _)| key.starts_with("FACT:")))
        .cloned()
        .collect::<Vec<_>>();
    sources.extend(facts);
    sources.retain(|source| source["sourceReference"].is_string() && identity(source).is_some());
    sources
}

pub(super) fn resolve_call(
    call: &ModelToolCall,
    messages: &[Value],
) -> Result<ModelToolCall, CoauthorError> {
    let args: Read = arguments(call)?;
    let (key, revision) = if let Some(reference) = args.reference {
        if args.key.is_some() || args.revision.is_some() {
            return Err(CoauthorError::Invalid(
                "read_source的reference与旧key/revision不能混用。".into(),
            ));
        }
        let sources = candidates(messages);
        let source = sources.iter().find(|source| source["sourceReference"] == reference)
            .ok_or_else(|| CoauthorError::Invalid(
                "来源reference未在当前上下文送达或已被压缩；请重新检索，复制sourceReference，不猜测身份或版本。".into()))?;
        let (key, revision) = identity(source).unwrap();
        (key.to_owned(), revision.to_owned())
    } else {
        match (args.key, args.revision) {
            (Some(key), Some(revision)) => (key, revision),
            _ => {
                return Err(CoauthorError::Invalid(
                    "read_source须提供reference；旧格式须同时提供准确key/revision。".into(),
                ));
            }
        }
    };
    let mut resolved = call.clone();
    resolved.function.arguments = json!({
        "key":key,"revision":revision,"offset":args.offset,"limit":args.limit,
    })
    .to_string();
    Ok(resolved)
}

pub(super) fn resolved_identity(call: &ModelToolCall) -> Value {
    arguments::<SourceArgs>(call).map_or(Value::Null, |args| {
        json!({"key":args.key,"revision":args.revision,"offset":args.offset,"limit":args.limit})
    })
}

pub(super) fn recovery(call: &ModelToolCall, messages: &[Value]) -> Value {
    let args = serde_json::from_str::<Value>(&call.function.arguments).unwrap_or(Value::Null);
    let sources = candidates(messages);
    let matching = sources
        .iter()
        .filter(|source| {
            source["key"] == args["key"] || source["sourceReference"] == args["reference"]
        })
        .collect::<Vec<_>>();
    let choices = if matching.is_empty() {
        sources.iter().collect::<Vec<_>>()
    } else {
        matching
    };
    json!({
        "action":"RESELECT_SOURCE",
        "sourceReferences":choices.into_iter().rev().take(8).map(|source| json!({
            "reference":source["sourceReference"],"title":source["title"],
            "key":source["key"],"revision":source["revision"],
        })).collect::<Vec<_>>(),
        "instruction":"若参数抄错，改用已送达sourceReference读取；若该引用仍版本不匹配，重新search_sources取得当前引用。引用只定位来源，不代表原文已读；不得省略版本检查或原样重试。",
    })
}

#[cfg(test)]
mod tests;
