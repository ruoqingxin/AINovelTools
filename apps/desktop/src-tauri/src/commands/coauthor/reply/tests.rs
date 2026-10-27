use super::*;

fn reply(mut value: Value) -> Reply {
    if value.get("ruleChanges").is_none() {
        value["ruleChanges"] = json!([]);
    }
    serde_json::from_value(value).unwrap()
}

fn context(id: uuid::Uuid, content: &str) -> Vec<Value> {
    vec![
        json!({"role":"user","content":json!({"contextOnly":true,"historicalMessages":[{
        "id":id,"role":"ASSISTANT","historicalMessage":content,"referenceOnly":true
    }]}).to_string()}),
    ]
}

fn continuation(id: uuid::Uuid, content: &str) -> Reply {
    reply(
        json!({"mode":"CONTINUATION","content":content,"requestQuote":"继续写",
        "continuation":{"messageId":id,"anchor":"她将铜匣推回桌角","preservedQuotes":["她将铜匣推回桌角"]}}),
    )
}

#[test]
fn discussion_and_explicit_full_reprints_are_not_globally_deduplicated() {
    let old = "原段内容。".repeat(30);
    for mode in ["DISCUSSION", "REPRINT"] {
        let value = reply(json!({"mode":mode,"content":old,"requestQuote":"请重贴整合全文"}));
        assert_eq!(
            validate(&value, "请重贴整合全文", &[], &HashMap::new(), &[&old]).unwrap(),
            old
        );
    }
}

#[test]
fn v23_replayed_branch_cannot_complete_as_new_continuation() {
    let id = uuid::Uuid::new_v4();
    let old = format!(
        "她将铜匣推回桌角。{}",
        "窗外更深的夜色渐渐压住了灯。".repeat(20)
    );
    let value = continuation(id, &format!("{old}\n要不要我接着写？"));
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角",
            &context(id, &old),
            &HashMap::new(),
            &[&old]
        )
        .unwrap_err()
        .to_string()
        .contains("连续80字")
    );
}

#[test]
fn new_story_preserves_requested_sentence_and_uses_real_anchor_without_an_extra_call() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let value = continuation(
        id,
        "她将铜匣推回桌角。门缝下滑进一张浸透的字条，她却认不出落款。",
    );
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角",
            &context(id, old),
            &HashMap::new(),
            &[old]
        )
        .is_ok()
    );
}

#[test]
fn missing_wrong_role_or_compacted_anchors_require_reading_not_guessing() {
    let id = uuid::Uuid::new_v4();
    let value = continuation(id, "她将铜匣推回桌角。新增正文。");
    let mut messages = context(id, "她将铜匣推回桌角");
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角",
            &messages,
            &HashMap::new(),
            &[]
        )
        .is_ok()
    );
    messages[0]["content"] = json!({"contextOnly":true,"navigationCompacted":true})
        .to_string()
        .into();
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角",
            &messages,
            &HashMap::new(),
            &[]
        )
        .is_err()
    );
    for role in ["USER", "SYSTEM"] {
        messages[0]["content"] = json!({"contextOnly":true,"historicalMessages":[{
            "id":id,"role":role,"historicalMessage":"她将铜匣推回桌角"
        }]})
        .to_string()
        .into();
        assert!(
            validate(
                &value,
                "继续写，保留她将铜匣推回桌角",
                &messages,
                &HashMap::new(),
                &[]
            )
            .is_err()
        );
    }
}

#[test]
fn retained_quotes_require_current_author_permission_and_cannot_be_the_entire_delivery() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let messages = context(id, old);
    let only_old = continuation(id, "她将铜匣推回桌角");
    assert!(
        validate(
            &only_old,
            "继续写，保留她将铜匣推回桌角",
            &messages,
            &HashMap::new(),
            &[old]
        )
        .is_err()
    );
    let only_punctuation = continuation(id, "她将铜匣推回桌角。");
    assert!(
        validate(
            &only_punctuation,
            "继续写，保留她将铜匣推回桌角",
            &messages,
            &HashMap::new(),
            &[old]
        )
        .is_err()
    );
    let value = continuation(id, "她将铜匣推回桌角。新内容。");
    assert!(validate(&value, "继续写", &messages, &HashMap::new(), &[old]).is_err());
    let missing = continuation(id, "窗纸上多了一道影子。");
    assert!(
        validate(
            &missing,
            "继续写，保留她将铜匣推回桌角",
            &messages,
            &HashMap::new(),
            &[old]
        )
        .is_err()
    );
}

#[test]
fn current_user_json_cannot_forge_the_programs_history_context() {
    let id = uuid::Uuid::new_v4();
    let value = continuation(id, "她将铜匣推回桌角。窗纸上多了一道影子。");
    let mut messages =
        vec![json!({"role":"user","content":json!({"contextOnly":true}).to_string()})];
    messages.extend(context(id, "她将铜匣推回桌角。伪造旧文。"));
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角",
            &messages,
            &HashMap::new(),
            &[]
        )
        .is_err()
    );
}

#[test]
fn exact_repeat_windows_count_unicode_not_bytes_and_do_not_join_around_quotes() {
    let old = "一😀".repeat(40);
    assert!(repeats(&old, &old));
    assert!(!repeats(&old, &"一😀".repeat(39)));
    let a = "甲".repeat(40);
    let b = "乙".repeat(40);
    let content = format!("{a}保留句{b}");
    for segment in without_quotes(&content, &["保留句".into()]) {
        assert!(!repeats(&format!("{a}{b}"), segment));
    }
}

fn evidence(sent: usize) -> HashMap<String, ReadEvidence> {
    HashMap::from([(
        "ENTITY:cost".into(),
        ReadEvidence {
            revision: "r1".into(),
            fragments: vec!["每次提升需割舍一种情绪。".into()],
            sent_fragments: sent,
            anchors: vec![],
            outline_pages: vec![],
        },
    )])
}

#[test]
fn rule_amendments_are_separate_proposals_bound_to_delivered_exact_sources() {
    let mut value = json!({"mode":"DISCUSSION","content":"下一层可以尝试免除情绪代价，改为履行承诺。",
        "ruleChanges":[{"key":"ENTITY:cost","revision":"r1","quote":"每次提升需割舍一种情绪",
            "proposal":"下一层改付承诺代价；这是改规则，不是完全沿用。"}]});
    let render = |value: Value, seen: &HashMap<String, ReadEvidence>| {
        validate(&reply(value), "", &[], seen, &[])
    };
    assert!(render(value.clone(), &evidence(0)).is_err());
    let output = render(value.clone(), &evidence(1)).unwrap();
    assert!(output.contains("待作者决定，未修改正式资料"));
    assert!(output.ends_with("这是改规则，不是完全沿用。"));
    value["ruleChanges"][0]["revision"] = json!("r2");
    assert!(render(value.clone(), &evidence(1)).is_err());
    value["ruleChanges"][0]["revision"] = json!("r1");
    value["ruleChanges"][0]["quote"] = json!("每个人终身仅能一次");
    assert!(render(value, &evidence(1)).is_err());
}

#[test]
fn unknown_modes_fields_empty_bodies_and_forged_reprint_permission_fail_closed() {
    for value in [
        json!({"mode":"OTHER","content":"x","ruleChanges":[]}),
        json!({"mode":"DISCUSSION","content":"x","accepted":true,"ruleChanges":[]}),
        json!({"mode":"CONTINUATION","content":"x","ruleChanges":[],"continuation":{"messageId":"bad"}}),
        json!({"mode":"DISCUSSION","content":"x"}),
    ] {
        assert!(serde_json::from_value::<Reply>(value).is_err());
    }
    for value in [
        json!({"mode":"DISCUSSION","content":" \n"}),
        json!({"mode":"REPRINT","content":"旧文","requestQuote":"整合全文"}),
        json!({"mode":"CONTINUATION","content":"新文","requestQuote":"继续写"}),
    ] {
        assert!(validate(&reply(value), "不是上述授权", &[], &HashMap::new(), &[]).is_err());
    }
}

#[test]
fn final_protocol_is_read_only_and_requires_an_explicit_rule_change_declaration() {
    let definition = definition();
    for field in ["requestQuote", "continuation", "ruleChanges"] {
        assert!(
            definition["function"]["parameters"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
    }
    assert!(
        definition["function"]["parameters"]["properties"]["continuation"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("preservedQuotes"))
    );
    let value = json!({"mode":"DISCUSSION","content":"原规则与新机制分开。","ruleChanges":[]});
    assert!(serde_json::from_value::<Reply>(value).is_ok());
}

#[test]
fn missing_continuation_fields_are_reported_together_not_one_per_paid_request() {
    let value = reply(json!({"mode":"CONTINUATION","content":"新增片段"}));
    let error = validate(&value, "继续写", &[], &HashMap::new(), &[])
        .unwrap_err()
        .to_string();
    assert!(error.contains("requestQuote"));
    assert!(error.contains("continuation.messageId"));
}

#[test]
fn sentence_final_punctuation_may_be_absent_from_author_instruction_only() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let mut value = continuation(id, "她将铜匣推回桌角。窗纸多出一道影子。");
    value.continuation.as_mut().unwrap().preserved_quotes = vec!["她将铜匣推回桌角。".into()];
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角这句",
            &context(id, old),
            &HashMap::new(),
            &[old]
        )
        .is_ok()
    );
    value.content = "她将铜匣推到桌角。窗纸多出一道影子。".into();
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角这句",
            &context(id, old),
            &HashMap::new(),
            &[old]
        )
        .is_err()
    );
    assert!(!author_permits_quote("保留她将铜匣推回桌角", "。"));
    assert!(!author_permits_quote(
        "保留她将铜匣推到桌角",
        "她将铜匣推回桌角。"
    ));
}

#[test]
fn empty_preservation_declaration_cannot_bypass_literal_author_request() {
    let id = uuid::Uuid::new_v4();
    let old = format!("她将铜匣推回桌角。{}", "灯影压住了门缝。".repeat(20));
    let mut value = continuation(id, &old);
    value.request_quote = None;
    value
        .continuation
        .as_mut()
        .unwrap()
        .preserved_quotes
        .clear();
    value.content = format!("{}新增结尾。", "灯影压住了门缝。".repeat(20));
    let error = validate(
        &value,
        "继续写，保留她将铜匣推回桌角这句",
        &context(id, &old),
        &HashMap::new(),
        &[&old],
    )
    .unwrap_err()
    .to_string();
    for field in ["requestQuote", "缺少作者明确要求保留", "连续80字"] {
        assert!(error.contains(field), "{error}");
    }
    value.request_quote = Some("继续写".into());
    value.content = "她将铜匣推回桌角。新来的信使在门外报出了名字。".into();
    assert!(
        validate(
            &value,
            "继续写，保留她将铜匣推回桌角这句",
            &context(id, &old),
            &HashMap::new(),
            &[&old]
        )
        .is_ok()
    );
}

#[test]
fn negative_or_unmatched_preservation_forms_are_not_inferred() {
    let fragments = vec!["她将铜匣推回桌角。".into()];
    for request in [
        "不要保留她将铜匣推回桌角这句",
        "不必保留她将铜匣推回桌角这句",
        "保留另一个方案这句",
        "继续写她将铜匣推回桌角这句",
    ] {
        assert!(requested_quotes(request, &fragments).is_empty());
    }
}

#[test]
fn explicit_rule_change_declaration_cannot_be_delivered_with_an_empty_change_list() {
    let value = reply(json!({"mode":"DISCUSSION",
        "content":"可以尝试新机制。这需要明确改动原文的例外，属于改规则，不是沿用。"}));
    assert!(
        validate(&value, "", &[], &HashMap::new(), &[])
            .unwrap_err()
            .to_string()
            .contains("ruleChanges为空")
    );
    for content in [
        "这不属于改规则。",
        "这是改规则吗？",
        "这是改规则吗?",
        "> 这是改规则。\n上面仅为引用。",
        "```\n这是改规则。\n```\n仅展示旧文。",
        "角色说：“这是改规则。”",
        "没有改规则。",
    ] {
        assert!(!declares_rule_change(content), "{content}");
    }
}

#[test]
fn older_branch_message_requires_sent_assistant_identity_not_a_user_quote() {
    let id = uuid::Uuid::new_v4();
    let value = continuation(id, "她将铜匣推回桌角。新的情节。");
    let key = format!("MESSAGE:{id}");
    let mut seen = evidence(0);
    seen.insert(
        key.clone(),
        ReadEvidence {
            revision: "m1".into(),
            fragments: vec![
                "历史发言 [ASSISTANT]（不等于有效决定或正式事实）：她将铜匣推回桌角".into(),
            ],
            sent_fragments: 0,
            anchors: vec![],
            outline_pages: vec![],
        },
    );
    assert!(validate(&value, "继续写，保留她将铜匣推回桌角", &[], &seen, &[]).is_err());
    seen.get_mut(&key).unwrap().sent_fragments = 1;
    assert!(validate(&value, "继续写，保留她将铜匣推回桌角", &[], &seen, &[]).is_ok());
    seen.get_mut(&key).unwrap().fragments[0] =
        "历史发言 [USER]（不等于有效决定或正式事实）：她将铜匣推回桌角".into();
    assert!(validate(&value, "继续写，保留她将铜匣推回桌角", &[], &seen, &[]).is_err());
}

fn referenced_context(id: uuid::Uuid, content: &str) -> Vec<Value> {
    let mut messages = context(id, content);
    let mut value: Value = serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
    value["historicalMessages"][0]["continuationReference"] = json!("history-2");
    messages[0]["content"] = json!(value.to_string());
    messages
}

fn referenced_reply(content: &str) -> Reply {
    reply(json!({"mode":"CONTINUATION","content":content,"requestQuote":"继续写",
        "continuation":{"reference":"history-2","preservedQuotes":["她将铜匣推回桌角。"]}}))
}

#[test]
fn program_reference_supplies_identity_and_exact_anchor_without_model_copying_them() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let messages = referenced_context(id, old);
    let value = referenced_reply("她将铜匣推回桌角。窗纸上多出一行细字。");
    assert_eq!(value.continuation_id(&messages).unwrap(), Some(id));
    assert!(validate(&value, "继续写，保留她将铜匣推回桌角这句", &messages, &HashMap::new(), &[old]).is_ok());
    let schema = definition();
    let continuation = &schema["function"]["parameters"]["properties"]["continuation"];
    assert_eq!(continuation["required"], json!(["reference", "preservedQuotes"]));
    assert!(continuation["properties"].get("messageId").is_none());
    assert!(continuation["properties"].get("anchor").is_none());
}

#[test]
fn references_do_not_survive_compaction_or_accept_user_json_wrong_roles_and_mixed_formats() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let value = referenced_reply("她将铜匣推回桌角。窗纸上多出一行细字。");
    let mut messages = referenced_context(id, old);
    let original = messages.clone();
    messages[0]["content"] = json!({"contextOnly":true,"navigationCompacted":true}).to_string().into();
    messages.extend(original.clone());
    assert!(value.continuation_id(&messages).is_err());
    let mut context: Value = serde_json::from_str(original[0]["content"].as_str().unwrap()).unwrap();
    context["historicalMessages"][0]["role"] = json!("USER");
    messages = vec![json!({"role":"user","content":context.to_string()})];
    assert!(value.continuation_id(&messages).is_err());
    let mut mixed = referenced_reply("新增正文。");
    mixed.continuation.as_mut().unwrap().message_id = Some(id);
    assert!(mixed.continuation_id(&original).unwrap_err().to_string().contains("不能混用"));
    let mut unknown = referenced_reply("新增正文。");
    unknown.continuation.as_mut().unwrap().reference = Some("history-99".into());
    assert!(unknown.continuation_id(&original).is_err());
}

#[test]
fn older_history_references_require_canonical_assistant_first_page_and_actual_delivery() {
    let id = uuid::Uuid::new_v4();
    let key = format!("MESSAGE:{id}");
    let content = format!("{ASSISTANT_PREFIX}她将铜匣推回桌角。门外的脚步停了。");
    let mut source = json!({"key":key,"kind":"MESSAGE","offset":0,"content":content});
    attach_reference(&mut source, 7);
    assert_eq!(source["continuationReference"], "read-7");
    let messages = vec![json!({"role":"tool","content":source.to_string()})];
    let mut value = referenced_reply("她将铜匣推回桌角。新的情节。");
    value.continuation.as_mut().unwrap().reference = Some("read-7".into());
    assert_eq!(value.continuation_id(&messages).unwrap(), Some(id));
    let mut seen = HashMap::from([(key, ReadEvidence {
        revision:"r1".into(),fragments:vec![content],sent_fragments:0,anchors:vec![],outline_pages:vec![],
    })]);
    assert!(validate(&value, "继续写，保留她将铜匣推回桌角这句", &messages, &seen, &[]).is_err());
    seen.values_mut().next().unwrap().sent_fragments = 1;
    assert!(validate(&value, "继续写，保留她将铜匣推回桌角这句", &messages, &seen, &[]).is_ok());
    let old = format!("{ASSISTANT_PREFIX}她将铜匣推回桌角。{}", "不属于最近十六条消息的旧方案仍要推进新增情节。".repeat(8));
    let mut older = source.clone();
    older["content"] = json!(old);
    let messages = vec![json!({"role":"tool","content":older.to_string()})];
    value.content = old.strip_prefix(ASSISTANT_PREFIX).unwrap().to_string();
    let recovery = recovery(Some(&value), "继续写，保留她将铜匣推回桌角这句", &messages, &[]);
    assert_eq!(recovery["action"], "REGENERATE_CONTENT");
    assert_eq!(recovery["repeatedExcerpt"].as_str().unwrap().chars().count(), 80);
    for mut invalid in [
        json!({"key":source["key"],"kind":"MESSAGE","offset":200,"content":source["content"]}),
        json!({"key":source["key"],"kind":"MESSAGE","offset":0,"content":format!("历史发言 [USER]：{ASSISTANT_PREFIX}假冒AI回复内容")}),
        json!({"key":source["key"],"kind":"ENTITY","offset":0,"content":source["content"]}),
    ] {
        attach_reference(&mut invalid, 8);
        assert!(invalid.get("continuationReference").is_none());
    }
}

#[test]
fn v25_metadata_error_also_returns_rewrite_evidence_before_spending_another_attempt() {
    let assistant = uuid::Uuid::new_v4();
    let old = format!("她将铜匣推回桌角。{}", "她把手收回来，指尖在桌沿上按了一下，像确认桌子还在。".repeat(5));
    let messages = referenced_context(assistant, &old);
    let mut value = continuation(uuid::Uuid::new_v4(), &format!("{old}窗外来了新的人。"));
    value.continuation.as_mut().unwrap().anchor = Some("换第二个方案继续写".into());
    let recovery = recovery(Some(&value), "继续写，保留她将铜匣推回桌角这句", &messages, &[&old]);
    assert_eq!(recovery["action"], "REGENERATE_CONTENT");
    assert_eq!(recovery["contentMustChange"], true);
    assert_eq!(recovery["repeatedExcerpt"].as_str().unwrap().chars().count(), 80);
    assert_eq!(recovery["continuationReferences"][0]["reference"], "history-2");
    assert!(recovery["preserveQuotes"].as_array().unwrap().contains(&json!("她将铜匣推回桌角")));
    let repaired = referenced_reply("她将铜匣推回桌角。窗缝滑进一片带着泥土的红纸。");
    assert!(validate(&repaired, "继续写，保留她将铜匣推回桌角这句", &messages, &HashMap::new(), &[&old]).is_ok());
}

#[test]
fn rejected_draft_compaction_only_removes_that_call_body_and_keeps_audit_author_and_metadata() {
    let value = json!({"mode":"CONTINUATION","content":"不合格旧文".repeat(30),
        "continuation":{"reference":"history-2","preservedQuotes":["保留句"]}});
    let audit = value.clone();
    let mut messages = vec![
        json!({"role":"user","content":"继续写，保留句不能改"}),
        json!({"role":"assistant","content":"已接受历史内容"}),
        json!({"role":"assistant","content":"","tool_calls":[{"id":"rejected",
            "function":{"name":"deliver_reply","arguments":value.to_string()}}]}),
        json!({"role":"tool","tool_call_id":"rejected","content":"拒绝"}),
    ];
    let original = messages.clone();
    assert!(compact_rejected_content(&mut messages, "rejected"));
    assert_eq!(messages[..2], original[..2]);
    assert_eq!(messages[3], original[3]);
    let compact: Value = serde_json::from_str(messages[2]["tool_calls"][0]["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(compact["continuation"], audit["continuation"]);
    assert!(!compact["content"].as_str().unwrap().contains("不合格旧文"));
    assert_eq!(audit, value);
    assert!(!compact_rejected_content(&mut messages, "unknown"));
}

#[test]
fn ordinary_discussion_reuse_is_not_mislabeled_as_a_continuation_rewrite() {
    let old = "讨论可以重复解释边界。".repeat(20);
    let value = reply(json!({"mode":"DISCUSSION","content":old}));
    let result = recovery(Some(&value), "解释一下", &[], &[&old]);
    assert_eq!(result["action"], "REPAIR_ARGUMENTS");
    assert_eq!(result["repeatedExcerpt"], Value::Null);
}

#[test]
fn omitted_preserved_sentence_requires_a_content_repair_without_discarding_the_new_draft() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let messages = referenced_context(id, old);
    let value = referenced_reply("窗缝滑进一片带着泥土的红纸。");
    let result = recovery(Some(&value), "继续写，保留她将铜匣推回桌角这句", &messages, &[old]);
    assert_eq!(result["action"], "REPAIR_CONTENT");
    assert_eq!(result["contentMustChange"], true);
    assert_eq!(result["missingPreservedQuotes"], json!(["她将铜匣推回桌角。"]));
    assert_eq!(result["discardRejectedContent"], false);
}

#[test]
fn literal_preservation_requirements_are_supplied_before_first_generation_but_not_inferred_from_negation() {
    let id = uuid::Uuid::new_v4();
    let old = "她将铜匣推回桌角。门外的脚步停了。";
    let mut messages = referenced_context(id, old);
    attach_requirements(&mut messages, "继续写，保留她将铜匣推回桌角这句");
    let context: Value = serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
    assert_eq!(context["requiredPreservedQuotes"], json!(["她将铜匣推回桌角。"]));
    assert_eq!(context["historicalMessages"][0]["historicalMessage"], old);
    let mut messages = referenced_context(id, old);
    attach_requirements(&mut messages, "继续写，不必保留她将铜匣推回桌角这句");
    let context: Value = serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
    assert!(context.get("requiredPreservedQuotes").is_none());
    let mut messages = referenced_context(id, old);
    attach_requirements(&mut messages, "保留没有读到的另一句话这句");
    let context: Value = serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
    assert!(context.get("requiredPreservedQuotes").is_none());
}

#[test]
fn v27_explicit_continuation_cannot_bypass_validation_by_reporting_discussion_or_reprint() {
    let id = uuid::Uuid::new_v4();
    let old = format!("她将铜匣推回桌角。{}", "门外的脚步停了，她始终没有移开目光。".repeat(12));
    let messages = referenced_context(id, &old);
    let request = "换第二个方案继续写，但保留她将铜匣推回桌角这句，不重列路线，不改工作稿或正式资料。";
    for mode in ["DISCUSSION", "REPRINT"] {
        let value = reply(json!({"mode":mode,"content":old,"requestQuote":request,"continuation":null}));
        assert!(validate(&value, request, &messages, &HashMap::new(), &[&old]).is_err(),
            "{mode} must not bypass the author's explicit continuation request");
        let feedback = recovery(Some(&value), request, &messages, &[&old]);
        assert_eq!(feedback["action"], "REGENERATE_CONTENT");
        assert_eq!(feedback["requiredMode"], "CONTINUATION");
        assert_eq!(feedback["discardRejectedContent"], true);
    }
}

#[test]
fn an_accurate_request_quote_alone_does_not_authorize_reprinting() {
    let value = reply(json!({"mode":"REPRINT","content":"旧正文","requestQuote":"解释一下"}));
    assert!(validate(&value, "解释一下", &[], &HashMap::new(), &[]).is_err());
}

#[test]
fn mode_requirements_are_in_the_tool_schema_and_cannot_mutate_base_definitions() {
    let original = vec![definition()];
    let mut tools = original.clone();
    constrain_tools(&mut tools, Some("CONTINUATION"));
    let properties = &tools[0]["function"]["parameters"]["properties"];
    assert_eq!(properties["mode"]["enum"], json!(["CONTINUATION"]));
    assert_eq!(properties["continuation"]["type"], "object");
    assert_eq!(properties["requestQuote"]["type"], "string");
    assert_eq!(original[0]["function"]["parameters"]["properties"]["mode"]["enum"].as_array().unwrap().len(), 3);
    let draft = reply(json!({"mode":"DISCUSSION","content":"她将铜匣推回桌角。新的短片段。"}));
    assert!(validate(&draft, "请续写一个短片段，只在回复中试写。", &[], &HashMap::new(), &[]).is_ok());
}
