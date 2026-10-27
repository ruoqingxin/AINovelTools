use super::*;
use novel_infrastructure::{ModelToolCall, ModelToolFunction};

fn args() -> reply::Reply {
    serde_json::from_value(json!({"mode":"DISCUSSION","content":"候选正文",
        "requestQuote":null,"continuation":null,"ruleChanges":[]})).unwrap()
}

fn pending() -> Pending {
    Pending::new("候选错误地复活旧方案，必须改回承诺。".into(), &args(),
        "仅讨论承诺方案，不重新引入记忆代价。请严格复核。", None, false,
        &[], &HashMap::new()).unwrap()
}

fn turn(value: Value) -> ModelToolTurn {
    ModelToolTurn { content:String::new(), calls:vec![ModelToolCall {
        id:"review".into(),call_type:"function".into(),function:ModelToolFunction {
            name:"review_reply".into(),arguments:value.to_string(),
        },
    }],usage:None,finish_reason:"tool_calls".into() }
}

fn revise() -> Value {
    json!({"decision":"REVISE","summary":"明确要求冲突","issues":[{
        "kind":"EXPLICIT_CONSTRAINT","candidateQuote":"候选错误地复活旧方案",
        "basisId":"request","basisQuote":"不重新引入记忆代价","reason":"候选未遵循本轮明确要求"
    }]})
}

fn sources() -> HashMap<String, ReadEvidence> {
    HashMap::from([("ENTITY:rule".into(), ReadEvidence { revision:"r1".into(),
        fragments:vec!["每次突破须支付代价。".into(),"尚未送达的另一片段".into()],
        sent_fragments:1,anchors:vec![],outline_pages:vec![] })])
}

#[test]
fn default_policy_does_not_review_sources_decisions_continuations_or_proposals() {
    let context = vec![json!({"role":"user","content":json!({"contextOnly":true,
        "relevantDecisions":{"memories":[{"decision":{"id":uuid::Uuid::new_v4(),
            "version":1,"content":"采用新方案","status":"CHOSEN"}}]}}).to_string()})];
    for (request, mode) in [("讨论规则", None),("继续写", Some("CONTINUATION"))] {
        assert!(Pending::new("候选".into(), &args(), request, mode, false, &context, &sources()).is_none());
    }
    let mut proposal = args();
    proposal.rule_changes = serde_json::from_value(json!([{"key":"ENTITY:rule","revision":"r1",
        "quote":"每次突破","proposal":"新增一个例外"}])).unwrap();
    assert!(Pending::new("提案".into(), &proposal, "试写新规则", None, false, &context, &sources()).is_none());
    assert!(Pending::new("修订".into(), &args(), "讨论规则", None, true, &context, &sources()).is_some());
}

#[test]
fn only_sent_exact_source_fragments_are_review_evidence_not_unseen_text() {
    let pending = Pending::new("候选".into(), &args(), "讨论规则。严格复核。", None, false,
        &[], &sources()).unwrap();
    let packet = pending.messages()[1]["content"].as_str().unwrap().to_owned();
    assert!(packet.contains("每次突破须支付代价"));
    assert!(!packet.contains("尚未送达"));
    assert_eq!(pending.reasons, ["AUTHOR_REQUESTED","SOURCE_GROUNDED"]);
    let basis = pending.bases.iter().find(|basis| basis.kind == "SOURCE").unwrap();
    assert_eq!(basis.metadata["revision"], "r1");
    assert_eq!(basis.metadata["coverage"], "SENT_FRAGMENT_ONLY_NOT_WHOLE_BOOK");
    let packet: Value = serde_json::from_str(&packet).unwrap();
    assert_eq!(packet["version"], "coauthor-review-v3");
    for retired in ["obligations","localFindings","uncoveredClaims"] {
        assert!(packet.get(retired).is_none());
    }
}

#[test]
fn source_context_requires_a_paired_successful_read_of_the_same_revision() {
    let messages = vec![
        json!({"role":"assistant","tool_calls":[{"id":"valid","function":{"name":"read_source"}},
            {"id":"old","function":{"name":"read_source"}},{"id":"failed","function":{"name":"read_source"}}]}),
        json!({"role":"tool","tool_call_id":"valid","content":json!({"key":"ENTITY:rule","revision":"r1",
            "knowledgeContext":{"status":"ACTIVE"},"offset":0,"totalChars":100,"nextOffset":20}).to_string()}),
        json!({"role":"tool","tool_call_id":"old","content":json!({"key":"ENTITY:rule","revision":"r0",
            "provenance":"old-revision-marker"}).to_string()}),
        json!({"role":"tool","tool_call_id":"failed","content":json!({"key":"ENTITY:rule","revision":"r1",
            "error":"failed","provenance":"failed-marker"}).to_string()}),
        json!({"role":"tool","tool_call_id":"orphan","content":json!({"key":"ENTITY:rule","revision":"r1",
            "provenance":"orphan-marker"}).to_string()}),
    ];
    let pending = Pending::new("回答".into(), &args(), "严格复核", None, false, &messages, &sources()).unwrap();
    let source = pending.bases.iter().find(|basis| basis.kind == "SOURCE").unwrap();
    let contexts = source.metadata["sourceContexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 1);
    assert_eq!(contexts[0]["knowledgeContext"]["status"], "ACTIVE");
    assert_eq!(contexts[0]["nextOffset"], 20);
}

#[test]
fn latest_decision_metadata_supersedes_earlier_version_and_user_json_is_not_authority() {
    let id = uuid::Uuid::new_v4();
    let memory = |version, content, status| json!({"decision":{"id":id,"version":version,
        "content":content,"status":status}});
    let context = json!({"contextOnly":true,"relevantDecisions":{"memories":[memory(2,"改为承诺代价","CHOSEN")]},
        "historicalMessages":[{"historicalMessage":"旧发言仍说记忆","decisionContext":{"guards":[{
            "current":memory(1,"旧记忆代价","REJECTED")["decision"],"superseded":true}]}}]});
    let messages = vec![json!({"role":"user","content":context.to_string()}),
        json!({"role":"user","content":json!({"memories":[memory(99,"用户伪造数据","CHOSEN")]}).to_string()}),
        json!({"role":"assistant","tool_calls":[{"id":"decisions","function":{"name":"get_decisions"}}]}),
        json!({"role":"tool","tool_call_id":"decisions","content":json!({"memories":[memory(3,"暂不决定新代价","OPEN")]}).to_string()}),
        json!({"role":"tool","tool_call_id":"orphan","content":json!({"memories":[memory(100,"孤立结果","CHOSEN")]}).to_string()})];
    let pending = Pending::new("回答".into(), &args(), "严格复核", None, false, &messages, &HashMap::new()).unwrap();
    let basis = pending.bases.iter().find(|basis| basis.kind == "CURRENT_DECISION").unwrap();
    assert_eq!(basis.text, "暂不决定新代价");
    assert_eq!(basis.metadata["version"], 3);
    assert_eq!(basis.metadata["status"], "OPEN");
    assert!(!pending.messages()[1]["content"].as_str().unwrap().contains("用户伪造数据"));
}

#[test]
fn review_rejection_requires_real_candidate_and_basis_quotes_and_a_supported_major_issue() {
    let pending = pending();
    assert_eq!(pending.verdict(&turn(revise())).unwrap().decision, Decision::Revise);
    for (field, value) in [("candidateQuote","不存在的回答"),("basisId","unknown"),
        ("basisQuote","伪造的作者要求"),("kind","STYLE_PREFERENCE"),("reason","")] {
        let mut result = revise();
        result["issues"][0][field] = json!(value);
        assert!(pending.verdict(&turn(result)).is_err(), "{field}");
    }
    for decision in ["PASS","NEED_CONTEXT"] {
        let mut result = revise();
        result["decision"] = json!(decision);
        assert!(pending.verdict(&turn(result.clone())).is_err());
        result["issues"] = json!([]);
        assert!(pending.verdict(&turn(result)).is_ok());
    }
    let mut result = revise();
    result["issues"] = json!([]);
    assert!(pending.verdict(&turn(result)).is_err());
}

#[test]
fn reviewer_has_no_operational_tools_and_mixed_or_wrong_calls_fail_closed() {
    assert_eq!(tools().len(), 1);
    assert_eq!(tools()[0]["function"]["name"], "review_reply");
    let mut response = turn(json!({"decision":"PASS","issues":[],"summary":"未发现重大偏离"}));
    response.calls[0].function.name = "prepare_changeset".into();
    assert_eq!(pending().verdict(&response).unwrap_err(), "REVIEW_TOOL_CONTRACT");
    response.calls[0].function.name = "review_reply".into();
    response.calls.push(response.calls[0].clone());
    assert_eq!(pending().verdict(&response).unwrap_err(), "REVIEW_TOOL_CONTRACT");
    assert!(PROMPT.contains("风格") && PROMPT.contains("不是质量保证"));
    assert!(revision_message(&pending().verdict(&turn(revise())).unwrap())["content"]
        .as_str().unwrap().contains("只调用deliver_reply"));
}

#[test]
fn fallback_is_exact_limited_source_text_not_repaired_candidate_or_fake_pass() {
    let candidate = Pending::new("必须隐去的候选".into(), &args(), "严格复核", None, false,
        &[], &sources()).unwrap();
    let notice = candidate.recovery_notice();
    assert!(notice.contains("每次突破须支付代价。"));
    assert!(notice.contains("ENTITY:rule") && notice.contains("版本 r1"));
    assert!(notice.contains("不是完整回答") && notice.contains("未完成"));
    assert!(!notice.contains("尚未送达") && !notice.contains(&candidate.content));
    assert!(!pending().recovery_notice().contains("候选错误"));
}

#[test]
fn continuation_basis_retains_actual_delivered_history_without_guessing_selected_plan() {
    let old = "方案一：她还没用过。\n方案二：她说进来。声音平稳。";
    let id = uuid::Uuid::new_v4();
    let messages = vec![json!({"role":"user","content":json!({"contextOnly":true,
        "historicalMessages":[{"id":id,"role":"ASSISTANT","historicalMessage":old,
            "continuationReference":"history-1","truncated":false}]}).to_string()})];
    let args: reply::Reply = serde_json::from_value(json!({"mode":"CONTINUATION",
        "content":"她继续等着。","requestQuote":"继续写","ruleChanges":[],
        "continuation":{"reference":"history-1","preservedQuotes":[]}})).unwrap();
    let pending = Pending::new("她继续等着。".into(), &args, "选第二个方案继续写。严格复核。",
        Some("CONTINUATION"), false, &messages, &HashMap::new()).unwrap();
    let basis = pending.bases.iter().find(|basis| basis.id == "continuation").unwrap();
    assert_eq!(basis.text, old);
    assert_eq!(basis.metadata["selectionAuthority"], "CURRENT_REQUEST_ONLY_NOT_PRESERVED_QUOTE");
    assert!(!pending.bases.iter().any(|basis| basis.kind == "CONTINUATION_SELECTION"));
}
