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
    assert!(
        definition["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("ruleChanges"))
    );
    let value = json!({"mode":"DISCUSSION","content":"原规则与新机制分开。","ruleChanges":[]});
    assert!(serde_json::from_value::<Reply>(value).is_ok());
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
