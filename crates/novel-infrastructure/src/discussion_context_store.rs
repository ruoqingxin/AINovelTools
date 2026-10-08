use super::context_store::{build_candidate, build_discussion_setting_context, source_revision};
use super::*;
use novel_application::{
    ContextCandidate, ContextCandidateKind, DiscussionContextInput, DiscussionRelevance,
};
use std::collections::HashSet;

impl ProjectManager {
    #[allow(clippy::too_many_lines)]
    pub(crate) fn collect_discussion_context_candidates(
        &self,
        input: &DiscussionContextInput,
    ) -> Vec<ContextCandidate> {
        let sections = self.list_planning_sections().unwrap_or_default();
        let background = build_discussion_setting_context(&sections);
        let revision = source_revision("planning:discussion-background", &background);
        let mut candidates = vec![build_candidate(
            ContextCandidateKind::ProjectSetting,
            background,
            Uuid::nil(),
            revision,
            RetrievalMethod::Structured,
            ContextAuthority::ProjectSetting,
            10_000,
        )];
        let current = DiscussionRelevance::new(&input.user_message);
        let focus = input.focus.clone().unwrap_or_default();
        let memory = DiscussionRelevance::new(&format!(
            "{}\n{}\n{}",
            current.excerpt(&focus.chosen, 1_000),
            current.excerpt(&focus.questions, 400),
            focus.recent_topic,
        ));
        let records = self.list_current_entity_revisions().unwrap_or_default();
        let explicit_name = records.iter().any(|(_, revision)| {
            current.names_score(&[&revision.name]) > 0
                || current.names_score(
                    &revision
                        .aliases
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                ) > 0
        });
        let mut entities = records
            .into_iter()
            .filter_map(|(entity, revision)| {
                let linked = focus.linked_entity_id == Some(entity.id);
                let mut names = vec![revision.name.as_str()];
                names.extend(revision.aliases.iter().map(String::as_str));
                let score = if linked {
                    10_000
                } else {
                    current
                        .names_score(&names)
                        .max(current.score(&revision.description))
                        .max(if explicit_name {
                            0
                        } else {
                            memory.names_score(&names) / 2
                        })
                };
                (score >= 600).then_some((score, entity, revision))
            })
            .collect::<Vec<_>>();
        entities.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
        entities.truncate(3);
        let selected_ids = entities
            .iter()
            .map(|(_, entity, _)| entity.id)
            .collect::<HashSet<_>>();
        let selected_names = entities
            .iter()
            .map(|(_, _, revision)| revision.name.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let related =
            DiscussionRelevance::new(&format!("{}\n{selected_names}", input.user_message));
        for (score, entity, revision) in entities {
            let content = format!(
                "当前实体「{}」：{}\n别名：{}\n相关属性：{}",
                revision.name,
                current.excerpt(&revision.description, 700),
                current.excerpt(&revision.aliases.join("、"), 200),
                relevant_attributes(&revision.fixed_attributes_json, &current),
            );
            candidates.push(build_candidate(
                ContextCandidateKind::Entity,
                content,
                entity.id,
                format!("entity:{}:revision:{}", entity.id, revision.id),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score,
            ));
        }
        let mut rules = self
            .list_author_settings()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|setting| {
                let score = current
                    .score(&setting.content)
                    .max(related.names_score(&[&setting.entity_name]));
                let selected = selected_ids.contains(&setting.entity_id);
                (selected || score >= 600).then_some((
                    score
                        .saturating_add(u16::from(selected) * 7_000)
                        .min(10_000),
                    setting,
                ))
            })
            .collect::<Vec<_>>();
        rules.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
        for (score, setting) in rules.into_iter().take(4) {
            candidates.push(build_candidate(
                ContextCandidateKind::AuthorSetting,
                format!(
                    "作者确认规则「{}」（{}，不代表正文已发生）：{}",
                    setting.entity_name,
                    setting.visibility,
                    current.excerpt(&setting.content, 700)
                ),
                setting.id,
                format!(
                    "author-setting:{}:revision:{}",
                    setting.id, setting.entity_revision_id
                ),
                RetrievalMethod::Structured,
                ContextAuthority::ProjectSetting,
                score,
            ));
        }
        let mut plans = sections
            .into_iter()
            .filter_map(|section| {
                let state = match section.story_state {
                    PlanningStoryState::Confirmed | PlanningStoryState::Locked => "已确认",
                    PlanningStoryState::AuthorReserved => "作者保留",
                    PlanningStoryState::Unknown => "明确未知",
                    PlanningStoryState::Deferred => "暂不决定",
                    _ => return None,
                };
                let score = related.score(&section.content);
                (score >= 600).then_some((score, state, section))
            })
            .collect::<Vec<_>>();
        plans.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.id.cmp(&b.2.id)));
        for (score, state, section) in plans.into_iter().take(3) {
            let content = format!(
                "相关规划「{}」（{state}）：{}",
                section.id,
                current.excerpt(&section.content, 700)
            );
            candidates.push(build_candidate(
                ContextCandidateKind::AuthorSetting,
                content.clone(),
                Uuid::nil(),
                source_revision(&format!("planning:{}", section.id), &section.content),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score,
            ));
        }
        let current_facts = self.list_current_facts().unwrap_or_default();
        let labels = current_facts
            .iter()
            .map(|fact| {
                (
                    fact.knowledge_id,
                    format!("{} {} {}", fact.subject, fact.predicate, fact.object),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        let mut facts = current_facts
            .into_iter()
            .filter_map(|fact| {
                let content = format!("{} {} {}", fact.subject, fact.predicate, fact.object);
                let score = related
                    .names_score(&[&fact.subject])
                    .max(related.score(&content));
                (score >= 600).then_some((score, fact, content))
            })
            .collect::<Vec<_>>();
        facts.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.knowledge_id.cmp(&b.1.knowledge_id))
        });
        for (score, fact, content) in facts.into_iter().take(3) {
            candidates.push(build_candidate(
                ContextCandidateKind::AuthoritativeFact,
                current.excerpt(&content, 700),
                fact.knowledge_id,
                format!("fact:{}:v{}", fact.knowledge_id, fact.knowledge_version),
                RetrievalMethod::Structured,
                ContextAuthority::AuthoritativeFact,
                score,
            ));
        }
        if let Some(world) = self.latest_world_state().ok().flatten() {
            let mut states = world
                .entries
                .into_iter()
                .filter_map(|entry| {
                    let content = format!(
                        "当前状态：{} {} {}",
                        entry.subject, entry.predicate, entry.object
                    );
                    let score = related
                        .names_score(&[&entry.subject])
                        .max(related.score(&content));
                    (score >= 600).then_some((score, entry, content))
                })
                .collect::<Vec<_>>();
            states.sort_by_key(|item| std::cmp::Reverse(item.0));
            for (score, entry, content) in states.into_iter().take(2) {
                candidates.push(build_candidate(
                    ContextCandidateKind::CurrentState,
                    current.excerpt(&content, 500),
                    entry.fact_knowledge_id,
                    format!(
                        "world-state:{}:fact:{}:v{}",
                        world.id, entry.fact_knowledge_id, entry.fact_version
                    ),
                    RetrievalMethod::Structured,
                    ContextAuthority::TaskMaterial,
                    score,
                ));
            }
        }
        let mut relations = self
            .list_relations()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.lifecycle_status == KnowledgeLifecycleStatus::Active)
            .filter_map(|item| {
                let content = format!(
                    "正式关系：{} -> {} -> {}",
                    labels
                        .get(&item.from_knowledge_id)
                        .map_or("未知对象", String::as_str),
                    item.relation_type,
                    labels
                        .get(&item.to_knowledge_id)
                        .map_or("未知对象", String::as_str),
                );
                let score = related.score(&content);
                (score >= 600).then_some((score, item, content))
            })
            .collect::<Vec<_>>();
        relations.sort_by_key(|item| std::cmp::Reverse(item.0));
        for (score, item, content) in relations.into_iter().take(2) {
            candidates.push(build_candidate(
                ContextCandidateKind::Relation,
                current.excerpt(&content, 500),
                item.id,
                format!("relation:{}:v{}", item.id, item.relation_version),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score,
            ));
        }
        let mut beliefs = self
            .list_beliefs()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.lifecycle_status == KnowledgeLifecycleStatus::Active)
            .filter_map(|item| {
                let content = format!(
                    "角色知识边界：{}认为：{}",
                    labels
                        .get(&item.holder_knowledge_id)
                        .map_or("未知角色", String::as_str),
                    item.proposition,
                );
                let score = related.score(&content);
                (score >= 600).then_some((score, item, content))
            })
            .collect::<Vec<_>>();
        beliefs.sort_by_key(|item| std::cmp::Reverse(item.0));
        for (score, item, content) in beliefs.into_iter().take(2) {
            candidates.push(build_candidate(
                ContextCandidateKind::Belief,
                current.excerpt(&content, 500),
                item.id,
                format!("belief:{}:v{}", item.id, item.belief_version),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score,
            ));
        }
        candidates
    }
}

fn relevant_attributes(json: &str, query: &DiscussionRelevance) -> String {
    let Ok(serde_json::Value::Object(attributes)) = serde_json::from_str(json) else {
        return "未提供结构化属性".into();
    };
    let mut entries = attributes
        .into_iter()
        .map(|(key, value)| {
            let text = format!("{key}：{value}");
            (query.score(&text), text)
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let text = entries
        .into_iter()
        .take(4)
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    query.excerpt(&text, 600)
}

#[cfg(test)]
mod tests {
    use super::*;
    use novel_application::DiscussionFocus;

    fn input(question: &str) -> DiscussionContextInput {
        DiscussionContextInput {
            scope_label: "本书".into(),
            scope_content: String::new(),
            history: String::new(),
            user_message: question.into(),
            input_token_budget: 8_192,
            focus: None,
        }
    }

    fn entity(name: &str, description: &str) -> EntityInput {
        EntityInput {
            id: None,
            entity_type: EntityType::Item,
            name: name.into(),
            aliases: vec![],
            description: description.into(),
            fixed_attributes_json: "{}".into(),
            tags: vec![],
            base_revision_id: None,
            source_version: Some("external:unchanged".into()),
            expected_version: None,
        }
    }

    #[test]
    fn current_topic_and_aliases_win_over_old_history_and_unselected_alternatives() {
        let root = PathBuf::from("target").join(format!("discussion-topic-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "话题检索").expect("project");
        let mut lamp = entity(
            "魂灯",
            &format!("古老的灯。{}寿元代价不可转嫁。", "山水描写".repeat(5_000)),
        );
        lamp.aliases = vec!["引魂灯".into()];
        let lamp = manager.upsert_entity(lamp).expect("lamp");
        let army = manager
            .upsert_entity(entity(
                "铁骑军",
                &format!("军队史。{}", "魂".repeat(10_000)),
            ))
            .expect("army");
        let mut request = input("引魂灯的寿元代价怎么设计？");
        request.history = "旧聊天：铁骑军的战役。".repeat(2_000);
        request.focus = Some(DiscussionFocus {
            alternatives: "铁骑军获得新的武器。".into(),
            recent_topic: "之前讨论了铁骑军。".into(),
            ..Default::default()
        });
        let package = manager
            .assemble_discussion_context(&request)
            .expect("context");
        assert!(package.user_prompt.contains("寿元代价不可转嫁"));
        assert!(
            package
                .retrieval_evidence
                .iter()
                .any(|item| item.source_id == lamp.id)
        );
        assert!(
            !package
                .retrieval_evidence
                .iter()
                .any(|item| item.source_id == army.id)
        );
        assert!(
            package.system_prompt.chars().count() + package.user_prompt.chars().count() <= 8_192
        );
        // No relevant entity is filled in just to reach an attachment count.
        let irrelevant =
            manager.collect_discussion_context_candidates(&input("星空中的雨是什么颜色"));
        assert_eq!(irrelevant.len(), 1);
        drop(manager);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn linked_entities_and_author_rules_always_use_current_revisions() {
        let root = PathBuf::from("target").join(format!("discussion-current-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "当前设定").expect("project");
        let session = manager
            .create_discussion_session("法宝".into(), DiscussionScopeKind::Project, None, None)
            .expect("session");
        let message = manager
            .append_discussion_message(
                session.id,
                DiscussionMessageRole::User,
                "选定寿元只能本人支付。".into(),
                None,
                None,
                None,
            )
            .expect("message");
        let proposal = manager
            .create_discussion_design_proposal(DiscussionDesignProposal {
                id: Uuid::new_v4(),
                session_id: session.id,
                workspace_version: 0,
                entities: vec![DiscussionDesignEntity {
                    entity_type: EntityType::Item,
                    name: "魂灯".into(),
                    description: "旧外观红灯。".into(),
                    aliases: vec![],
                    tags: vec![],
                    attributes: serde_json::json!({}),
                    settings: vec!["寿元只能本人支付。".into()],
                    visibility: "AUTHOR_ONLY".into(),
                    target_entity_id: None,
                    expected_entity_version: None,
                }],
                source_message_ids: vec![message.id],
                context_version: "context".into(),
                omitted_message_count: 0,
                status: "PENDING".into(),
                promoted_entity_ids: vec![],
                created_at: String::new(),
            })
            .expect("proposal");
        let ids = manager
            .confirm_discussion_design(proposal.id, proposal.entities)
            .expect("confirm");
        let mut request = input("它的代价呢？");
        request.focus = Some(DiscussionFocus {
            linked_entity_id: Some(ids[0]),
            ..Default::default()
        });
        let before = manager
            .assemble_discussion_context(&request)
            .expect("before");
        assert!(before.user_prompt.contains("寿元只能本人支付"));
        assert!(before.user_prompt.contains("AUTHOR_ONLY"));
        let old = manager.list_entities(false).expect("entities").remove(0);
        let mut update = entity("新魂灯", "新外观青灯。");
        update.id = Some(old.id);
        update.base_revision_id = Some(old.current_revision_id);
        update.expected_version = Some(old.version);
        let updated = manager.upsert_entity(update).expect("update");
        let after = manager
            .assemble_discussion_context(&request)
            .expect("after");
        assert!(!after.user_prompt.contains("旧外观红灯"));
        assert!(after.user_prompt.contains("新外观青灯"));
        assert!(after.user_prompt.contains("寿元只能本人支付"));
        assert!(after.retrieval_evidence.iter().any(|item| {
            item.source_revision
                .contains(&updated.current_revision_id.to_string())
        }));
        assert_ne!(before.context_version, after.context_version);
        assert!(manager.list_current_facts().expect("facts").is_empty());
        drop(manager);
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
