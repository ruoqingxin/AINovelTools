use super::context_store::{
    WRITING_SETTING_SECTIONS, build_candidate, build_discussion_setting_context, source_revision,
};
use super::*;
use novel_application::{
    ContextCandidate, ContextCandidateKind, ContextError, DiscussionContextInput,
    DiscussionRelevance,
};
use std::collections::HashSet;
use std::fmt::Write as _;

mod project_sources;

fn source_error(error: impl std::fmt::Display) -> ContextError {
    ContextError::ProjectKnowledgeUnavailable(error.to_string())
}

impl ProjectManager {
    #[allow(clippy::too_many_lines)]
    pub(crate) fn collect_discussion_context_candidates(
        &self,
        input: &DiscussionContextInput,
    ) -> Result<Vec<ContextCandidate>, ContextError> {
        let project = self
            .current
            .as_ref()
            .ok_or_else(|| source_error("no project is open"))?;
        let sections = self.list_planning_sections().map_err(source_error)?;
        let nodes = self.list_plan_nodes().map_err(source_error)?;
        let mut background = build_discussion_setting_context(&sections);
        background.push_str(&self.story_direction_context(&sections, 200));
        background.insert_str(0, &format!("当前作品「{}」\n", project.manifest.name));
        let structure = nodes
            .iter()
            .filter(|node| !node.archived)
            .map(|node| format!("{}：{}", node.kind.as_str(), node.title))
            .collect::<Vec<_>>();
        if !structure.is_empty() {
            let _ = write!(
                background,
                "\n作品目录（共 {} 项，目录不等于正文）：\n{}",
                structure.len(),
                structure
                    .iter()
                    .take(24)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
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
        let focus = input.focus.clone().unwrap_or_default();
        let records = self.list_current_entity_revisions().map_err(source_error)?;
        let current = DiscussionRelevance::new(&input.user_message);
        let explicit_name = records.iter().any(|(_, revision)| {
            current.names_score(&[&revision.name]) > 0
                || current.names_score(
                    &revision
                        .aliases
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                ) > 0
        }) || nodes
            .iter()
            .any(|node| current.names_score(&[&node.title]) > 0);
        // Pronouns need the author's recent topic, never old AI suggestions.
        let query = if !explicit_name && is_follow_up(&input.user_message) {
            format!(
                "{}\n{}\n{}\n{}",
                input.user_message,
                focus.recent_topic,
                current.excerpt(&focus.chosen, 1_000),
                input.scope_label
            )
        } else {
            input.user_message.clone()
        };
        let current = DiscussionRelevance::new(&query);
        let memory = DiscussionRelevance::new(&format!(
            "{}\n{}\n{}",
            current.excerpt(&focus.chosen, 1_000),
            current.excerpt(&focus.questions, 400),
            focus.recent_topic,
        ));
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
                        .max(if explicit_name || !is_follow_up(&input.user_message) {
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
        let related = DiscussionRelevance::new(&format!("{query}\n{selected_names}"));
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
            .map_err(source_error)?
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
            .iter()
            .filter_map(|section| {
                if section.story_state == PlanningStoryState::Retired {
                    return None;
                }
                if let Some(id) = section.id.strip_prefix("plan-node:")
                    && !nodes
                        .iter()
                        .any(|node| !node.archived && node.id.to_string() == id)
                {
                    return None;
                }
                let state = match section.story_state {
                    PlanningStoryState::Confirmed | PlanningStoryState::Locked => "已确认",
                    PlanningStoryState::AuthorReserved => "作者保留",
                    PlanningStoryState::Unknown => "明确未知",
                    PlanningStoryState::Deferred => "暂不决定",
                    _ => "未确认草稿，不是正式设定",
                };
                let title = nodes
                    .iter()
                    .find(|node| section.id == format!("plan-node:{}", node.id))
                    .map(|node| node.title.as_str())
                    .or_else(|| {
                        WRITING_SETTING_SECTIONS
                            .iter()
                            .find(|(id, _)| *id == section.id)
                            .map(|(_, title)| *title)
                    })
                    .unwrap_or(section.id.as_str());
                let score = related
                    .score(&format!(
                        "{}\n{}\n{}\n{}",
                        section.content,
                        section.pending_content,
                        section.rationale,
                        section.consequence
                    ))
                    .max(related.names_score(&[title]));
                (score >= 600).then_some((score, state, section, title))
            })
            .collect::<Vec<_>>();
        plans.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.id.cmp(&b.2.id)));
        for (score, state, section, title) in plans.into_iter().take(3) {
            let content = format!(
                "相关规划「{}」（{state}；规划不代表正文已发生）：{}\n修订候选（尚未确认）：{}\n作者备注：{}",
                title,
                current.excerpt(&section.content, 700),
                current.excerpt(&section.pending_content, 400),
                current.excerpt(
                    &format!("{}\n{}", section.rationale, section.consequence),
                    300
                )
            );
            candidates.push(build_candidate(
                ContextCandidateKind::AuthorSetting,
                content.clone(),
                Uuid::nil(),
                source_revision(&format!("planning:{}", section.id), &content),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score,
            ));
        }
        let current_facts = self.list_current_facts().map_err(source_error)?;
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
        if let Some(world) = self.latest_world_state().map_err(source_error)? {
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
            .map_err(source_error)?
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
            .map_err(source_error)?
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
        candidates.extend(self.discussion_project_sources(&nodes, &related, &selected_names)?);
        Ok(candidates)
    }
}

fn is_follow_up(question: &str) -> bool {
    let short_continuation = question.chars().count() <= 20
        && (question.contains('呢')
            || ["为什么", "换一个", "再想想", "就这样", "还有吗"]
                .iter()
                .any(|word| question.contains(word)));
    short_continuation
        || (question.chars().count() <= 80
            && [
                "继续",
                "然后呢",
                "还有呢",
                "这个",
                "那个",
                "这样",
                "刚才",
                "上面",
                "之前",
                "它",
                "他",
                "她",
                "那就",
                "第二种",
                "第一种",
                "整理",
                "定稿",
                "这章",
                "这一章",
                "这段",
                "这里",
                "上述",
                "接着",
                "下一步",
            ]
            .iter()
            .any(|word| question.contains(word)))
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

    fn document(text: &str) -> String {
        serde_json::json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
        ]})
        .to_string()
    }

    fn summary(chapter: Uuid, revision: Uuid, content: &str) -> SummaryMaterial {
        SummaryMaterial {
            id: Uuid::new_v4(),
            project_id: Uuid::nil(),
            kind: SummaryKind::Chapter,
            precision: SummaryPrecision::L1,
            source_id: Some(chapter),
            source_version: Some(format!("manuscript:{revision}")),
            content: content.into(),
            generation_mode: "MANUAL".into(),
            lifecycle_status: "ACTIVE".into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn discussion_reads_current_manuscripts_drafts_and_references_without_reviving_old_versions() {
        let root = std::env::temp_dir().join(format!("discussion-sources-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "魂灯故事").expect("project");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "渡河".into())
            .expect("chapter");
        let old = manager
            .save_manuscript(
                chapter.id,
                document("魂灯旧版：代价可以由他人承担。"),
                "TEST".into(),
            )
            .expect("old");
        let stale = manager
            .upsert_summary_material(summary(chapter.id, old.id, "魂灯旧摘要：代价可以转嫁。"))
            .expect("old summary");
        let current = manager
            .save_manuscript(
                chapter.id,
                document(&format!(
                    "河面寂静。{}魂灯每次渡河扣除三年寿元，代价必须本人支付。{}",
                    "水声".repeat(2_000),
                    "尾声".repeat(100)
                )),
                "TEST".into(),
            )
            .expect("current");
        // Even an incorrectly reactivated summary must not override its changed source.
        manager
            .set_summary_material_lifecycle(stale.id, "ACTIVE".into())
            .expect("reactivate");
        let mut current_summary = summary(chapter.id, current.id, "魂灯渡河的寿元代价由本人支付。");
        current_summary.precision = SummaryPrecision::L2;
        manager
            .upsert_summary_material(current_summary)
            .expect("summary");
        manager
            .save_manuscript_draft(
                chapter.id,
                Some(current.id),
                document("魂灯草稿方向：扣除记忆而非寿元，尚未决定。"),
                0,
            )
            .expect("draft");
        for (title, enabled) in [("魂灯写作参考", true), ("魂灯禁用资料", false)] {
            manager
                .upsert_writing_card(WritingCard {
                    id: Uuid::new_v4(),
                    project_id: Uuid::nil(),
                    card_type: "STYLE_RULE".into(),
                    title: title.into(),
                    content: format!("{title}：寿元代价应通过白发展现。"),
                    source_version: None,
                    scope: "PROJECT".into(),
                    enabled,
                    sort_order: 0,
                    created_at: String::new(),
                    updated_at: String::new(),
                })
                .expect("card");
        }
        let mut request = input("魂灯渡河的寿元代价怎么表现？");
        request.input_token_budget = 32_768;
        let context = manager
            .assemble_discussion_context(&request)
            .expect("context");
        for expected in [
            "当前正文「渡河」",
            "扣除三年寿元",
            "代价必须本人支付",
            "正文编辑草稿「渡河」",
            "尚未提交，不覆盖当前正文",
            "摘要「渡河」",
            "魂灯写作参考",
        ] {
            assert!(context.user_prompt.contains(expected), "missing {expected}");
        }
        for absent in [
            "代价可以由他人承担",
            "代价可以转嫁",
            "魂灯禁用资料",
            "\"type\":\"doc\"",
        ] {
            assert!(!context.user_prompt.contains(absent), "unexpected {absent}");
        }
        assert!(
            context
                .retrieval_evidence
                .iter()
                .any(|item| item.source_revision == format!("manuscript:{}", current.id))
        );
        let next = manager
            .save_manuscript(
                chapter.id,
                document("魂灯渡河改为消耗十年寿元，代价必须本人支付。"),
                "TEST".into(),
            )
            .expect("next");
        let changed = manager
            .assemble_discussion_context(&request)
            .expect("changed");
        assert!(changed.user_prompt.contains("十年寿元"));
        assert!(!changed.user_prompt.contains("扣除三年寿元"));
        assert!(
            !changed
                .retrieval_evidence
                .iter()
                .any(|item| item.source_revision == format!("manuscript:{}", current.id))
        );
        assert_ne!(context.context_version, changed.context_version);
        assert_ne!(current.id, next.id);
        drop(manager);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn short_followups_keep_the_topic_and_other_discussions_remain_unconfirmed() {
        let root = std::env::temp_dir().join(format!("discussion-followup-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "连续讨论").expect("project");
        manager
            .upsert_entity(entity("魂灯", "燃烧寿元，可以保存记忆。"))
            .expect("entity");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "渡河".into())
            .expect("chapter");
        manager
            .save_manuscript(
                chapter.id,
                document("魂灯渡河燃烧寿元，代价不能转嫁。"),
                "TEST".into(),
            )
            .expect("manuscript");
        let session = manager
            .create_discussion_session("魂灯代价".into(), DiscussionScopeKind::Project, None, None)
            .expect("session");
        let mut workspace = manager
            .get_discussion_workspace(session.id)
            .expect("workspace");
        workspace.draft.chosen = "魂灯燃烧寿元这个方向先保留。".into();
        manager.save_discussion_workspace(workspace).expect("notes");
        manager
            .append_discussion_message(
                session.id,
                DiscussionMessageRole::User,
                "魂灯的寿元代价不要太轻。".into(),
                None,
                None,
                None,
            )
            .expect("author");
        manager
            .append_discussion_message(
                session.id,
                DiscussionMessageRole::Assistant,
                "魂灯已经确认可以复活所有人。".into(),
                None,
                None,
                None,
            )
            .expect("assistant");
        let mut request = input("那它还有什么限制？");
        request.input_token_budget = 32_768;
        request.focus = Some(DiscussionFocus {
            recent_topic: "魂灯燃烧寿元是否太残酷？".into(),
            ..Default::default()
        });
        let context = manager
            .assemble_discussion_context(&request)
            .expect("context");
        for expected in [
            "代价不能转嫁",
            "讨论笔记「魂灯代价」",
            "仍未正式入库",
            "历史作者发言",
            "可能已被后续想法替代",
        ] {
            assert!(context.user_prompt.contains(expected), "missing {expected}");
        }
        assert!(!context.user_prompt.contains("复活所有人"));
        request.user_message = "代价呢？".into();
        let brief = manager
            .assemble_discussion_context(&request)
            .expect("brief followup");
        assert!(brief.user_prompt.contains("代价不能转嫁"));
        request.user_message = "城市里的雨是什么颜色？".into();
        let changed = manager
            .assemble_discussion_context(&request)
            .expect("new topic");
        assert!(!changed.user_prompt.contains("当前正文「渡河」"));
        assert!(!changed.user_prompt.contains("当前实体「魂灯」"));
        drop(manager);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn source_read_errors_are_not_silently_reported_as_empty_project_context() {
        let root = std::env::temp_dir().join(format!("discussion-source-error-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "来源错误").expect("project");
        manager
            .current
            .as_ref()
            .expect("project")
            .database
            .connection
            .execute("DROP TABLE summary_materials", [])
            .expect("break material source");
        assert!(matches!(
            manager.assemble_discussion_context(&input("聊聊故事")),
            Err(ContextError::ProjectKnowledgeUnavailable(_))
        ));
        drop(manager);
        std::fs::remove_dir_all(root).expect("cleanup");
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
        let irrelevant = manager
            .collect_discussion_context_candidates(&input("星空中的雨是什么颜色"))
            .expect("candidates");
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
