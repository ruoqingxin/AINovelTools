use super::*;
use crate::coauthor_store::tests::{entity, project};

const FIXTURE: &str = include_str!("../../../../../../tools/fixtures/coauthor-n2-regression.json");

#[test]
fn deepseek_regression_noisy_natural_query_recovers_missing_rule_without_relabelling_primary() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../tools/fixtures/coauthor-deepseek-comparison.json"
    )).unwrap();
    for case_id in ["compare-renamed-short", "compare-renamed-long-tail"] {
        let (mut manager, root, scope) = project();
        let case = fixture["cases"].as_array().unwrap().iter().find(|case| case["id"] == case_id).unwrap();
        let prefix = "风景与路况。".repeat(case["prefixRepeat"].as_u64().unwrap_or(0) as usize);
        let mut keys = std::collections::HashMap::new();
        for source in fixture["sources"].as_array().unwrap() {
            let id = source["id"].as_str().unwrap();
            let saved = manager.upsert_entity(EntityInput {
                id: None, entity_type: EntityType::Concept, name: source["title"].as_str().unwrap().into(),
                aliases: serde_json::from_value(source["aliases"].clone()).unwrap(),
                description: format!("{}{}", if id == "noise" { "" } else { &prefix }, source["content"].as_str().unwrap()),
                fixed_attributes_json: "{}".into(), tags: vec![], base_revision_id: None,
                source_version: None, expected_version: None,
            }).unwrap();
            keys.insert(id.to_owned(), format!("ENTITY:{}", saved.id));
        }
        let query = case["turns"][0]["message"].as_str().unwrap();
        let primary = manager.search_coauthor_sources(&scope, query, false, 0).unwrap();
        let before = serde_json::to_value(&primary).unwrap();
        let actual = primary.hits.iter().map(|hit| hit.key.clone()).collect::<BTreeSet<_>>();
        assert_eq!(actual, BTreeSet::from([keys["ladder"].clone(), keys["noise"].clone()]));
        let followup = manager.coauthor_source_followup(&scope, query, &primary).unwrap().expect(case_id);
        assert_eq!(followup.result.hits.len(), 1);
        assert_eq!(followup.result.hits[0].key, keys["cost"]);
        assert_eq!(followup.seed_key, keys["ladder"]);
        assert!(followup.result.hits[0].content.contains("不得无条件还原全部情绪"));
        assert_eq!(serde_json::to_value(&primary).unwrap(), before);
        let mut reordered = primary.clone();
        reordered.hits.reverse();
        assert_eq!(manager.coauthor_source_followup(&scope, query, &reordered).unwrap().unwrap().result.hits[0].key, keys["cost"]);
        let mut complete = primary.clone();
        complete.hits.push(followup.result.hits[0].clone());
        assert!(manager.coauthor_source_followup(&scope, query, &complete).unwrap().is_none());
        let mut oversized = complete.clone();
        oversized.hits.push(primary.hits[0].clone());
        assert!(manager.coauthor_source_followup(&scope, query, &oversized).unwrap().is_none());
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn frozen_renamed_cost_and_long_tail_variants_preserve_primary_and_retrieve_one_companion() {
    let data: Value = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(data["version"], "coauthor-n2-v1");
    for case in data["retrieval"]["cases"].as_array().unwrap() {
        let (mut manager, root, scope) = project();
        let prefix = "风景与路况。".repeat(case["prefixRepeat"].as_u64().unwrap() as usize);
        let mut keys = std::collections::HashMap::new();
        for source in data["retrieval"]["sources"].as_array().unwrap() {
            let id = source["id"].as_str().unwrap();
            let saved = manager.upsert_entity(EntityInput {
                id: None, entity_type: EntityType::Concept, name: source["title"].as_str().unwrap().into(),
                aliases: serde_json::from_value(source["aliases"].clone()).unwrap(),
                description: format!("{}{}", if id == "noise" { "" } else { &prefix }, source["content"].as_str().unwrap()),
                fixed_attributes_json: "{}".into(), tags: vec![], base_revision_id: None,
                source_version: None, expected_version: None,
            }).unwrap();
            keys.insert(id.to_owned(), format!("ENTITY:{}", saved.id));
        }
        let query = case["query"].as_str().unwrap();
        let primary = manager.search_coauthor_sources(&scope, query, false, 0).unwrap();
        let before = serde_json::to_value(&primary).unwrap();
        let expected = case["expectedInitial"].as_array().unwrap().iter()
            .map(|id| keys[id.as_str().unwrap()].clone()).collect::<BTreeSet<_>>();
        assert_eq!(primary.hits.iter().map(|hit| hit.key.clone()).collect::<BTreeSet<_>>(), expected);
        let followup = manager.coauthor_source_followup(&scope, query, &primary).unwrap();
        assert_eq!(serde_json::to_value(&primary).unwrap(), before);
        let expected = case["expectedFollowup"].as_array().unwrap();
        if expected.is_empty() {
            assert!(followup.is_none());
        } else {
            let followup = followup.unwrap();
            assert_eq!(followup.result.hits.len(), 1);
            let hit = &followup.result.hits[0];
            assert_eq!(hit.key, keys[expected[0].as_str().unwrap()]);
            assert!(hit.content.contains(case["requiredQuote"].as_str().unwrap()), "{}", case["id"]);
            assert!(!hit.content.contains("仓库"));
            assert!(followup.shared_terms.len() <= 12);
            assert_eq!(followup.candidate_limit, 16);
            assert!(manager.read_coauthor_source(&scope, &hit.key, &hit.revision, 0, 12000).is_ok());
        }
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn followup_rejects_stale_or_foreign_seeds_and_ignores_forged_excerpt_text() {
    let (mut manager, root, scope) = project();
    let saved = entity(&mut manager, "青阶体系", "登阶需失去一段听觉，铜铃只能使用一次。");
    entity(&mut manager, "听觉损耗条款", "登阶需失去一段听觉，铜铃只能使用一次，不可凭普通仪式恢复。");
    let mut primary = manager.search_coauthor_sources(&scope, "青阶", false, 0).unwrap();
    assert_eq!(primary.hits.len(), 1);
    primary.hits[0].content = "伪造导航，不应参与词频与关联判断。".into();
    assert!(manager.coauthor_source_followup(&scope, "青阶", &primary).unwrap().is_some());
    let foreign = CoauthorScope { project_id: Uuid::new_v4(), ..scope.clone() };
    assert!(manager.coauthor_source_followup(&foreign, "青阶", &primary).is_err());
    manager.upsert_entity(EntityInput {
        id: Some(saved.id), entity_type: EntityType::Concept, name: "青阶体系".into(), aliases: vec![],
        description: "规则已经变化。".into(), fixed_attributes_json: "{}".into(), tags: vec![],
        base_revision_id: Some(saved.current_revision_id), source_version: None, expected_version: Some(saved.version),
    }).unwrap();
    assert!(matches!(manager.coauthor_source_followup(&scope, "青阶", &primary), Err(CoauthorError::Conflict)));
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn followup_skips_pending_sources_and_never_uses_branch_history_as_a_companion() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "青阶体系", "登阶需失去一段听觉，铜铃只能使用一次。");
    let other = manager.create_discussion_session("其他分支".into(), DiscussionScopeKind::Project, None, None).unwrap();
    for session in [scope.session_id, other.id] {
        manager.append_discussion_message(session, DiscussionMessageRole::Assistant,
            "登阶需失去一段听觉，铜铃只能使用一次。分支秘密不可作为共享规则。".into(), None, None, None).unwrap();
    }
    let primary = manager.search_coauthor_sources(&scope, "青阶", false, 0).unwrap();
    assert!(manager.coauthor_source_followup(&scope, "青阶", &primary).unwrap().is_none());
    entity(&mut manager, "听觉损耗条款", "登阶需失去一段听觉，铜铃只能使用一次。");
    let pending = manager.current.as_ref().unwrap().database.coauthor_pending_updates().unwrap();
    assert!(pending > 0);
    assert!(manager.coauthor_source_followup(&scope, "青阶", &primary).unwrap().is_none());
    assert_eq!(manager.current.as_ref().unwrap().database.coauthor_pending_updates().unwrap(), pending);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn followup_does_not_expand_empty_invalid_exact_or_already_multiple_results() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "青阶体系", "登阶需要听觉，铜铃只能使用一次。");
    entity(&mut manager, "听觉损耗条款", "登阶需要听觉，铜铃只能使用一次。");
    entity(&mut manager, "无关器物杂记", "铜铃只能使用一次。这里只是工匠的无关记述。");
    for index in 0..3 {
        entity(&mut manager, &format!("背景{index}"), "远山下着细雨，船工收起绳索。");
    }
    for query in ["砂", "完全无匹配", "青阶体系", "修行等级", "听觉"] {
        let primary = manager.search_coauthor_sources(&scope, query, false, 0).unwrap();
        assert!(manager.coauthor_source_followup(&scope, query, &primary).unwrap().is_none(), "{query}");
    }
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn followup_never_uses_shared_metadata_as_body_evidence() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "青阶体系", "攀升须舍弃听觉，铜铃仅可用一次。");
    entity(&mut manager, "无关条款", "远山下着细雨，船工收起绳索。");
    let primary = manager.search_coauthor_sources(&scope, "青阶", false, 0).unwrap();
    assert_eq!(primary.hits.len(), 1);
    assert!(manager.coauthor_source_followup(&scope, "青阶", &primary).unwrap().is_none());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn followup_allows_new_author_message_queue_but_reports_pending_honestly() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "青阶体系", "登阶需失去一段听觉，铜铃只能使用一次。");
    entity(&mut manager, "听觉损耗条款", "登阶需失去一段听觉，铜铃只能使用一次。");
    let primary = manager.search_coauthor_sources(&scope, "青阶", false, 0).unwrap();
    manager.append_discussion_message(scope.session_id, DiscussionMessageRole::User,
        "继续讨论青阶，不更改规则。".into(), None, None, None).unwrap();
    let pending = manager.current.as_ref().unwrap().database.coauthor_pending_updates().unwrap();
    assert!(pending > 0);
    let followup = manager.coauthor_source_followup(&scope, "青阶", &primary).unwrap().unwrap();
    assert_eq!(followup.result.pending_index_updates, pending);
    assert_eq!(manager.current.as_ref().unwrap().database.coauthor_pending_updates().unwrap(), pending);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
