use super::*;

impl ProjectManager {
    /// Read current project sources, not the search index's historical manuscript revisions.
    #[allow(clippy::too_many_lines)]
    pub(super) fn discussion_project_sources(
        &self,
        nodes: &[PlanNode],
        query: &DiscussionRelevance,
        entity_names: &str,
    ) -> Result<Vec<ContextCandidate>, ContextError> {
        let mut candidates = Vec::new();
        let score = |title: &str, text: &str| {
            query.names_score(&[title]).max(query.score(text)).max(
                if entity_names
                    .lines()
                    .any(|name| !name.is_empty() && text.contains(name))
                {
                    900
                } else {
                    0
                },
            )
        };
        let mut revisions = std::collections::HashMap::new();
        for node in nodes
            .iter()
            .filter(|node| !node.archived && node.kind == PlanNodeKind::Chapter)
        {
            if let Some(revision) = self.current_manuscript(node.id).map_err(source_error)? {
                let text = novel_application::document_text(&revision.document_json)?;
                revisions.insert(node.id, revision.id);
                let relevance = score(&node.title, &text);
                if relevance >= 600 && !text.trim().is_empty() {
                    candidates.push(build_candidate(
                        ContextCandidateKind::Keyword,
                        format!(
                            "当前正文「{}」（原文片段，不等于角色全知）：\n{}",
                            node.title,
                            query.excerpt(&text, 1_800)
                        ),
                        node.id,
                        format!("manuscript:{}", revision.id),
                        RetrievalMethod::Keyword,
                        ContextAuthority::TaskMaterial,
                        relevance,
                    ));
                }
            }
            let draft = self
                .current_manuscript_draft(node.id)
                .map_err(source_error)?;
            if let Some(document) = draft.document_json {
                let text = novel_application::document_text(&document)?;
                let relevance = score(&node.title, &text);
                if relevance >= 600 && !text.trim().is_empty() {
                    candidates.push(build_candidate(
                        ContextCandidateKind::Keyword,
                        format!(
                            "正文编辑草稿「{}」（尚未提交，不覆盖当前正文）：\n{}",
                            node.title,
                            query.excerpt(&text, 1_200)
                        ),
                        node.id,
                        source_revision(
                            &format!("manuscript-draft:{}:v{}", node.id, draft.version),
                            &document,
                        ),
                        RetrievalMethod::Keyword,
                        ContextAuthority::TaskMaterial,
                        relevance,
                    ));
                }
            }
        }
        for material in self.list_summary_materials().map_err(source_error)? {
            if material.lifecycle_status != "ACTIVE" {
                continue;
            }
            if material.kind == SummaryKind::Chapter {
                let Some(node) = nodes
                    .iter()
                    .find(|node| Some(node.id) == material.source_id && !node.archived)
                else {
                    continue;
                };
                // An allegedly active chapter summary still needs to match its current source.
                if material
                    .source_version
                    .as_deref()
                    .is_some_and(|source| source.starts_with("manuscript:"))
                    && material.source_version
                        != revisions.get(&node.id).map(|id| format!("manuscript:{id}"))
                {
                    continue;
                }
            }
            let title = nodes
                .iter()
                .find(|node| Some(node.id) == material.source_id)
                .map_or("参考摘要", |node| node.title.as_str());
            let relevance = score(title, &material.content);
            if relevance >= 600 {
                candidates.push(build_candidate(
                    ContextCandidateKind::Summary,
                    format!(
                        "摘要「{title}」（仅作导航，不能代替正文证据）：\n{}",
                        query.excerpt(&material.content, 1_000)
                    ),
                    material.id,
                    source_revision(
                        &format!("summary:{}", material.id),
                        &format!("{:?}\n{}", material.source_version, material.content),
                    ),
                    RetrievalMethod::Keyword,
                    ContextAuthority::Reference,
                    relevance,
                ));
            }
        }
        for card in self
            .list_writing_cards(None)
            .map_err(source_error)?
            .into_iter()
            .filter(|card| card.enabled)
        {
            let relevance = score(&card.title, &card.content);
            if relevance >= 600 {
                candidates.push(build_candidate(
                    ContextCandidateKind::Keyword,
                    format!(
                        "写作资料「{}」（{}，范围 {}；参考材料，不自动成为事实）：\n{}",
                        card.title,
                        card.card_type,
                        card.scope,
                        query.excerpt(&card.content, 1_000)
                    ),
                    card.id,
                    source_revision(&format!("writing-card:{}", card.id), &card.content),
                    RetrievalMethod::Keyword,
                    ContextAuthority::Reference,
                    relevance,
                ));
            }
        }
        for event in self
            .list_events()
            .map_err(source_error)?
            .into_iter()
            .filter(|event| event.lifecycle_status == KnowledgeLifecycleStatus::Active)
        {
            let relevance = score(&event.name, &event.name);
            if relevance >= 600 {
                candidates.push(build_candidate(
                    ContextCandidateKind::Event,
                    format!(
                        "已记录事件「{}」（时间 {}，不得据此赋予所有角色相关知识）",
                        event.name, event.occurred_at
                    ),
                    event.id,
                    format!("event:{}:v{}", event.id, event.event_version),
                    RetrievalMethod::Structured,
                    ContextAuthority::TaskMaterial,
                    relevance,
                ));
            }
        }
        for item in self
            .list_foreshadowings()
            .map_err(source_error)?
            .into_iter()
            .filter(|item| item.lifecycle_status == KnowledgeLifecycleStatus::Active)
        {
            let relevance = score(&item.title, &item.title);
            if relevance >= 600 {
                candidates.push(build_candidate(
                    ContextCandidateKind::Foreshadowing,
                    format!(
                        "伏笔「{}」（状态 {}；回收计划不等于已经发生）",
                        item.title, item.status
                    ),
                    item.id,
                    format!("foreshadowing:{}:v{}", item.id, item.foreshadowing_version),
                    RetrievalMethod::Structured,
                    ContextAuthority::TaskMaterial,
                    relevance,
                ));
            }
        }
        // Only author-maintained notes and author utterances are searchable here.
        // Past assistant proposals must not quietly become project facts.
        for session in self.list_discussion_sessions().map_err(source_error)? {
            let workspace = self
                .get_discussion_workspace(session.id)
                .map_err(source_error)?;
            let draft = workspace.draft;
            let text = format!(
                "已选方向（仍未正式入库）：{}\n备选（不代表选定）：{}\n未决：{}",
                draft.chosen, draft.alternatives, draft.questions
            );
            let relevance = score(&session.title, &text);
            if relevance >= 600
                && (!draft.chosen.is_empty()
                    || !draft.alternatives.is_empty()
                    || !draft.questions.is_empty())
            {
                candidates.push(build_candidate(
                    ContextCandidateKind::Summary,
                    format!(
                        "讨论笔记「{}」（以本轮最新选择为准）：\n{}",
                        session.title,
                        query.excerpt(&text, 1_000)
                    ),
                    session.id,
                    source_revision(
                        &format!("discussion-notes:{}:v{}", session.id, workspace.version),
                        &text,
                    ),
                    RetrievalMethod::Keyword,
                    ContextAuthority::Reference,
                    relevance,
                ));
            }
        }
        let project = self
            .current
            .as_ref()
            .ok_or_else(|| source_error("no project is open"))?;
        let mut statement = project
            .database
            .connection
            .prepare(
                "SELECT m.id, s.title, m.content FROM discussion_messages m
             JOIN discussion_sessions s ON s.id = m.session_id
             WHERE s.project_id = ?1 AND m.role = 'USER' ORDER BY m.rowid DESC",
            )
            .map_err(source_error)?;
        let rows = statement
            .query_map([project.manifest.project_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(source_error)?;
        let mut history = Vec::new();
        for row in rows {
            let (id, title, content) = row.map_err(source_error)?;
            let relevance = query.score(&content);
            if relevance >= 600 {
                history.push(build_candidate(
                    ContextCandidateKind::Summary,
                    format!(
                        "历史作者发言「{title}」（未确认，可能已被后续想法替代）：\n{}",
                        query.excerpt(&content, 800)
                    ),
                    Uuid::parse_str(&id).map_err(source_error)?,
                    format!("discussion-message:{id}"),
                    RetrievalMethod::Keyword,
                    ContextAuthority::Reference,
                    relevance,
                ));
                // Keep the highest scoring recent matches without retaining the whole archive.
                history.sort_by_key(|candidate| std::cmp::Reverse(candidate.evidence.relevance));
                history.truncate(3);
            }
        }
        candidates.extend(history);
        Ok(candidates)
    }
}
