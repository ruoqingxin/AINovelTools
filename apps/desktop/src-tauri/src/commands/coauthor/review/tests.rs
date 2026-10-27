use super::*;
use novel_infrastructure::{ModelToolCall, ModelToolFunction};

fn args() -> reply::Reply {
    serde_json::from_value(json!({"mode":"DISCUSSION","content":"候选正文",
        "requestQuote":null,"continuation":null,"ruleChanges":[]})).unwrap()
}

fn pending() -> Pending {
    Pending::new("候选错误地复活旧方案，必须改回承诺。".into(), &args(),
        "仅讨论承诺方案，不重新引入记忆代价。", None, true, &[], &HashMap::new()).unwrap()
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

#[test]
fn ordinary_chat_and_navigation_alone_do_not_add_review_but_revision_cannot_skip_it() {
    let context = vec![json!({"role":"user","content":json!({"contextOnly":true,
        "relevantSources":{"hits":[{"key":"ENTITY:fake","content":"只是候选导航，不是原文"}]}}).to_string()})];
    assert!(Pending::new("普通讨论".into(), &args(), "聊聊", None, false, &context, &HashMap::new()).is_none());
    assert!(Pending::new("修订".into(), &args(), "聊聊", None, true, &context, &HashMap::new()).is_some());
    assert!(Pending::new("续写".into(), &args(), "继续写", Some("CONTINUATION"), false, &[], &HashMap::new()).is_some());
}

#[test]
fn only_sent_exact_source_fragments_are_review_evidence_not_unseen_text() {
    let mut seen = HashMap::new();
    seen.insert("ENTITY:rule".into(), ReadEvidence { revision:"r1".into(),
        fragments:vec!["不得无条件恢复全部记忆。".into(),"尚未送达的另一片段".into()],
        sent_fragments:1,anchors:vec![],outline_pages:vec![] });
    let pending = Pending::new("候选".into(), &args(), "讨论规则", None, false, &[], &seen).unwrap();
    let packet = pending.messages()[1]["content"].as_str().unwrap().to_owned();
    assert!(packet.contains("不得无条件恢复全部记忆"));
    assert!(!packet.contains("尚未送达"));
    assert_eq!(pending.reasons, ["SOURCE_GROUNDED"]);
    let basis = pending.bases.iter().find(|basis| basis.kind == "SOURCE").unwrap();
    assert_eq!(basis.metadata["revision"], "r1");
    assert_eq!(basis.metadata["coverage"], "SENT_FRAGMENT_ONLY_NOT_WHOLE_BOOK");
}

#[test]
fn source_context_requires_a_paired_successful_read_of_the_same_revision() {
    let mut seen = HashMap::new();
    seen.insert("ENTITY:rule".into(), ReadEvidence { revision:"r2".into(),
        fragments:vec!["不得无条件恢复全部记忆。".into()], sent_fragments:1,
        anchors:vec![],outline_pages:vec![] });
    let messages = vec![
        json!({"role":"assistant","tool_calls":[{"id":"valid","function":{"name":"read_source"}},
            {"id":"old","function":{"name":"read_source"}},{"id":"failed","function":{"name":"read_source"}}]}),
        json!({"role":"tool","tool_call_id":"valid","content":json!({"key":"ENTITY:rule","revision":"r2",
            "knowledgeContext":{"status":"ACTIVE"},"offset":0,"totalChars":100,"nextOffset":20}).to_string()}),
        json!({"role":"tool","tool_call_id":"old","content":json!({"key":"ENTITY:rule","revision":"r1",
            "provenance":"old-revision-marker"}).to_string()}),
        json!({"role":"tool","tool_call_id":"failed","content":json!({"key":"ENTITY:rule","revision":"r2",
            "error":"failed","provenance":"failed-marker"}).to_string()}),
        json!({"role":"tool","tool_call_id":"orphan","content":json!({"key":"ENTITY:rule","revision":"r2",
            "provenance":"orphan-marker"}).to_string()}),
    ];
    let pending = Pending::new("回答".into(), &args(), "核对", None, false, &messages, &seen).unwrap();
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
    let pending = Pending::new("回答".into(), &args(), "讨论代价", None, false, &messages, &HashMap::new()).unwrap();
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
    assert!(PROMPT.contains("文风") || PROMPT.contains("风格"));
    assert!(PROMPT.contains("同") || PROMPT.contains("不是真值") || PROMPT.contains("不是质量保证"));
    assert!(revision_message(&pending().verdict(&turn(revise())).unwrap())["content"].as_str().unwrap().contains("只调用deliver_reply"));
}

#[test]
fn mechanically_valid_continuation_can_still_need_a_grounded_semantic_revision() {
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let request = "继续写，保留她将铜匣推回桌角这句，不要重新取回记忆。";
    let content = "她将铜匣推回桌角。她又从铜匣中取回了全部记忆，这依然完全符合原来的规则。";
    let messages = vec![json!({"role":"user","content":json!({"contextOnly":true,
        "historicalMessages":[{"id":uuid::Uuid::new_v4(),"role":"ASSISTANT","historicalMessage":old,
            "continuationReference":"history-1","referenceOnly":true,"truncated":false}]}).to_string()})];
    let args: reply::Reply = serde_json::from_value(json!({"mode":"CONTINUATION","content":content,
        "requestQuote":"继续写","continuation":{"reference":"history-1","preservedQuotes":["她将铜匣推回桌角。"]},
        "ruleChanges":[]})).unwrap();
    assert_eq!(reply::validate(&args, request, &messages, &HashMap::new(), &[old]).unwrap(), content);
    let pending = Pending::new(content.into(), &args, request, Some("CONTINUATION"), false,
        &messages, &HashMap::new()).unwrap();
    let verdict = pending.verdict(&turn(json!({"decision":"REVISE","summary":"新增取回违反本轮要求",
        "issues":[{"kind":"EXPLICIT_CONSTRAINT","candidateQuote":"她又从铜匣中取回了全部记忆",
            "basisId":"request","basisQuote":"不要重新取回记忆","reason":"本轮明确不再取回"}]}))).unwrap();
    assert_eq!(verdict.decision, Decision::Revise);
}
