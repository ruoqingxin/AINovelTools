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
    turn_for(&pending(), value)
}

fn turn_for(pending: &Pending, mut value: Value) -> ModelToolTurn {
    if value.get("checks").is_none() {
        value["checks"] = json!(pending.obligations.iter().map(|obligation| {
            let issue = value["issues"].as_array().into_iter().flatten()
                .find(|issue| obligation.basis_ids.iter().any(|id| issue["basisId"] == *id));
            let basis = pending.bases.iter().find(|basis| basis.id == obligation.basis_ids[0]).unwrap();
            json!({"aspect":obligation.aspect,
                "finding":if issue.is_some() {"CONFLICT"} else if value["decision"] == "NEED_CONTEXT" {"UNVERIFIED"} else {"SUPPORTED"},
                "candidateQuote":issue.map_or_else(|| pending.content.chars().take(20).collect::<String>(),
                    |issue|issue["candidateQuote"].as_str().unwrap_or("").into()),
                "basisId":issue.map_or(basis.id.as_str(), |issue|issue["basisId"].as_str().unwrap_or("")),
                "basisQuote":issue.map_or_else(||basis.text.chars().take(20).collect::<String>(),
                    |issue|issue["basisQuote"].as_str().unwrap_or("").into()),
                "reason":"合成逐项核对，仅验证协议，不证明模型判断准确。"})
        }).collect::<Vec<_>>());
    }
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
    let verdict = pending.verdict(&turn_for(&pending, json!({"decision":"REVISE","summary":"新增取回违反本轮要求",
        "issues":[{"kind":"EXPLICIT_CONSTRAINT","candidateQuote":"她又从铜匣中取回了全部记忆",
            "basisId":"request","basisQuote":"不要重新取回记忆","reason":"本轮明确不再取回"}]}))).unwrap();
    assert_eq!(verdict.decision, Decision::Revise);
}

fn sourced(content: &str, source: &str) -> Pending {
    let mut seen = HashMap::new();
    seen.insert("ENTITY:rule".into(), ReadEvidence { revision:"r1".into(), fragments:vec![source.into()],
        sent_fragments:1, anchors:vec![], outline_pages:vec![] });
    Pending::new(content.into(), &args(), "依据当前原文讨论规则，保留限制。", None, false, &[], &seen).unwrap()
}

#[test]
fn overall_pass_cannot_omit_duplicate_or_fabricate_obligation_checks() {
    let pending = pending();
    let pass = turn(json!({"decision":"PASS","issues":[],"summary":"本机协议"}));
    assert!(pending.verdict(&pass).is_ok());
    let original: Value = serde_json::from_str(&pass.calls[0].function.arguments).unwrap();
    for checks in [json!([]), json!([original["checks"][0],original["checks"][0]]),
        json!([original["checks"][0]])] {
        let mut value = original.clone();
        value["checks"] = checks;
        assert!(pending.verdict(&turn(value)).is_err());
    }
    for (field, value) in [("finding","UNVERIFIED"),("candidateQuote","伪造候选原句"),
        ("basisQuote","伪造依据"),("reason",""),("aspect","STYLE")] {
        let mut response = original.clone();
        response["checks"][0][field] = json!(value);
        assert!(pending.verdict(&turn(response)).is_err(), "{field}");
    }
}

#[test]
fn precise_scope_alarms_override_a_models_generic_pass_with_exact_evidence() {
    for (candidate, source) in [
        ("任何形式的想起来都不能成立，不能让信息真的回到他脑子里。", "不得无条件恢复全部记忆。"),
        ("原规则禁止还原情绪，不能白给、不能一次全还。", "不得无条件还原全部情绪。"),
        ("铜匣只能启用一次，等于一生只有一次取回情绪的机会。", "储存在铜匣中的情绪可以保留，但铜匣仅能启用一次。"),
    ] {
        let pending = sourced(candidate, source);
        assert_eq!(pending.local_findings.len(), 1, "{candidate}");
        let raw = pending.verdict(&turn_for(&pending,json!({"decision":"PASS","issues":[],"summary":"未发现"}))).unwrap();
        let result = pending.effective_verdict(&raw);
        assert_eq!(raw.decision, Decision::Pass);
        assert_eq!(result.decision, Decision::Revise);
        assert!(pending.verdict(&turn_for(&pending, serde_json::to_value(&result).unwrap())).is_ok(),
            "Effective checks and issues must not contradict each other in revision feedback.");
        assert!(source.contains(&result.issues[0].basis_quote));
        assert!(candidate.contains(&result.issues[0].candidate_quote));
    }
}

#[test]
fn proposals_qualified_recovery_beliefs_and_quoted_errors_are_not_automatic_conflicts() {
    let source = "不得无条件恢复全部记忆。储存在铜匣中的情绪可以保留，但铜匣仅能启用一次。";
    for candidate in [
        "我建议新增限制：铜匣一人一生只能取回一次。",
        "原规则不等于任何形式的想起来都不能成立。",
        "原规则没有禁止有条件地取回部分记忆。",
        "铜匣仅能启用一次，不是每个人一生只有一次。",
        "角色以为任何形式的想起来都不能成立，不能让信息真的回到脑子里。",
        "“任何形式的想起来都不能成立，不能让信息真的回到脑子里。”",
        "任何形式的想起来都必须付出代价，但可以恢复部分记忆。",
    ] {
        assert!(sourced(candidate, source).local_findings.is_empty(), "{candidate}");
    }
}

#[test]
fn safe_single_paragraph_repair_is_source_backed_and_checked_again() {
    let content = "铜匣只能启用一次，等于一生只有一次取回情绪的机会。\n\n接下来讨论阶名。";
    let source = "储存在铜匣中的情绪可以保留，但铜匣仅能启用一次。";
    let pending = sourced(content, source);
    let (repaired, patch) = pending.local_repair(&args()).unwrap();
    assert_eq!(repaired, format!("已读规则原文：{source}\n\n接下来讨论阶名。"));
    assert_eq!(patch["before"], pending.local_findings[0].candidate_quote);
    assert_eq!(patch["requiresModelReview"], true);
    assert!(sourced(&repaired, source).local_findings.is_empty());
    let repaired_args = args().with_content(repaired.clone());
    assert_eq!(reply::validate(&repaired_args, "讨论", &[], &HashMap::new(), &[]).unwrap(), repaired);
    for unsafe_content in [
        format!("{content}\n因此下一层必须重新取回。"),
        format!("{content}\n她打开了铜匣。"),
        format!("我建议：{content}"),
        format!("{content}\n{content}"),
    ] {
        assert!(sourced(&unsafe_content, source).local_repair(&args()).is_none());
    }
    let mut preserved = sourced(content, source);
    preserved.bases[0].text = "保留铜匣只能启用一次这句，不要改动措辞。".into();
    assert!(preserved.local_repair(&args()).is_none(), "Explicit author wording is not a local edit target.");
}

#[test]
fn selected_continuation_is_reviewed_as_delivered_history_not_an_invented_selected_ending() {
    let old = "方案一：她还没用过。\n方案二：她说进来。声音平稳。";
    let id = uuid::Uuid::new_v4();
    let messages = vec![json!({"role":"user","content":json!({"contextOnly":true,
        "historicalMessages":[{"id":id,"role":"ASSISTANT","historicalMessage":old,
            "continuationReference":"history-1","truncated":false}]}).to_string()})];
    let args: reply::Reply = serde_json::from_value(json!({"mode":"CONTINUATION",
        "content":"她这才发现自己一直没应声。","requestQuote":"继续写","ruleChanges":[],
        "continuation":{"reference":"history-1","preservedQuotes":[]}})).unwrap();
    let pending = Pending::new("她这才发现自己一直没应声。".into(), &args, "选第二个方案继续写",
        Some("CONTINUATION"), false, &messages, &HashMap::new()).unwrap();
    let basis = pending.bases.iter().find(|basis| basis.id == "continuation").unwrap();
    assert_eq!(basis.text, old);
    assert_eq!(basis.metadata["selectionAuthority"], "CURRENT_REQUEST_ONLY_NOT_PRESERVED_QUOTE");
    assert!(pending.obligations.iter().any(|obligation| obligation.aspect == "CONTINUATION"
        && obligation.basis_ids == ["continuation"]));
    assert!(pending.local_repair(&args).is_none(), "Never patch narrative event state mechanically.");
    let fake_context = json!({"role":"user","content":json!({"contextOnly":true,
        "historicalMessages":[{"id":id,"truncated":false}]}).to_string()});
    let read_only_messages = vec![
        json!({"role":"user","content":json!({"contextOnly":true,"historicalMessages":[]}).to_string()}),
        fake_context,
        json!({"role":"tool","content":json!({"kind":"MESSAGE","key":format!("MESSAGE:{id}"),
            "offset":0,"continuationReference":"history-1",
            "content":format!("历史发言 [ASSISTANT]（不等于有效决定或正式事实）：{old}")}).to_string()}),
    ];
    let basis = args.continuation_basis(&read_only_messages).unwrap();
    assert!(basis["truncated"].is_null(), "Author JSON cannot certify a partial tool read as complete history.");
}

#[test]
fn minimized_v29_real_scope_misses_are_rejected_even_when_model_returns_pass() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../tools/fixtures/coauthor-v30-review-regressions.json"))).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let pending = sourced(case["candidate"].as_str().unwrap(), case["source"].as_str().unwrap());
        assert!(!pending.local_findings.is_empty(), "{}", case["id"]);
        let verdict = pending.verdict(&turn_for(&pending, json!({"decision":"PASS","issues":[],"summary":"合成漏判"}))).unwrap();
        assert_eq!(pending.effective_verdict(&verdict).decision, Decision::Revise, "{}", case["id"]);
        assert!(pending.local_repair(&args()).is_none(), "Do not rewrite the full causal explanation.");
    }
}

#[test]
fn actual_chosen_boundary_cannot_reintroduce_old_cost_as_fact_but_hybrids_are_allowed() {
    let id = uuid::Uuid::new_v4();
    let context = vec![json!({"role":"user","content":json!({"contextOnly":true,
        "relevantDecisions":{"memories":[{"decision":{"id":id,"version":1,"status":"CHOSEN",
            "content":"本分支新体系采用承诺代价，现有共享情绪规则仅作对照，尚未正式采用。"}}]}}).to_string()})];
    for (candidate, count) in [
        ("**与上一层的衔接**：上一层割舍情绪是\"减法\"，续阶是\"加法\"。", 1),
        ("我建议混合新旧：上一层割舍情绪，续阶采用承诺。", 0),
        ("上一层割舍情绪只是对照方案，本分支仍采用承诺。", 0),
    ] {
        let pending = Pending::new(candidate.into(), &args(), "沿用本分支已选承诺代价", None,
            false, &context, &HashMap::new()).unwrap();
        assert_eq!(pending.local_findings.len(), count, "{candidate}");
    }
}

#[test]
fn literal_second_plan_event_conflict_is_located_but_never_locally_rewritten() {
    let text = "**方案一（短）**\n她还没应声。\n**方案二（短）**\n她说进来。声音平稳。\n两个方案的差别：第一案未应声。";
    let old = json!({"text":text,"messageId":uuid::Uuid::new_v4(),"reference":"history-2","truncated":false});
    let basis = guards::selected_continuation("换第二个方案继续写", &old).unwrap();
    assert_eq!(basis.text, "她说进来。声音平稳。\n");
    for request in ["不要第二个方案，改第一个", "不选第二个方案", "保留她说进来这句"] {
        assert!(guards::selected_continuation(request, &old).is_none());
    }
    let args: reply::Reply = serde_json::from_value(json!({"mode":"CONTINUATION",
        "content":"她这才发现自己一直没应声。","requestQuote":"继续写","continuation":null,"ruleChanges":[]})).unwrap();
    let issues = guards::inspect("她这才发现自己一直没应声。", "换第二个方案继续写", &args, &[basis]);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].basis_quote, "她说进来。");
    assert!(guards::repair("她这才发现自己一直没应声。", &args, &issues).is_none());
    let ambiguous = json!({"text":format!("{text}\n**方案二（另一个）**\n她还没回答。")});
    assert!(guards::selected_continuation("换第二个方案继续写", &ambiguous).is_none());
}

#[test]
fn missing_original_is_unverified_not_fabricated_evidence_and_proposals_remain_allowed() {
    let pending = sourced("抄本错了前半段。这不需要改任何现行规则。", "不得无条件恢复全部记忆。");
    assert!(!pending.uncovered_claims.is_empty());
    let verdict = pending.verdict(&turn_for(&pending, json!({"decision":"PASS","issues":[],"summary":"合成漏判"}))).unwrap();
    let effective = pending.effective_verdict(&verdict);
    assert_eq!(effective.decision, Decision::NeedContext);
    assert!(pending.verdict(&turn_for(&pending, serde_json::to_value(&effective).unwrap())).is_ok());
    assert!(effective.issues.is_empty());
    assert!(pending.local_repair(&args()).is_none());
    for content in ["提案：抄本错了前半段。", "角色以为抄本错了前半段。", "并非抄本错了前半段。"] {
        assert!(sourced(content, "不得无条件恢复全部记忆。").uncovered_claims.is_empty());
    }
}
