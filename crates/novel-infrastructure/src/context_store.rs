use super::*;
use novel_application::{ContextCandidate, ContextCandidateKind};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

impl ProjectManager {
    pub(crate) fn collect_context_candidates(
        &self,
        input: &novel_application::AssembleContextInput,
        object_ids: &[Uuid],
    ) -> Vec<ContextCandidate> {
        let mut candidates = Vec::new();
        let query_text = [
            input.chapter_title.as_str(),
            input.chapter_plan.as_str(),
            input.instruction.as_deref().unwrap_or_default(),
            input.selection.as_deref().unwrap_or_default(),
            input.document_json.as_str(),
        ]
        .join("\n");
        let normalized_query = normalize_for_match(&query_text);

        let mut facts = self
            .list_current_facts()
            .unwrap_or_default()
            .into_iter()
            .map(|fact| {
                let score = score_values(
                    &normalized_query,
                    &[&fact.subject, &fact.predicate, &fact.object],
                );
                (score, fact)
            })
            .collect::<Vec<_>>();
        facts.sort_by_key(|left| std::cmp::Reverse(left.0));
        facts.truncate(12);
        let selected_fact_ids = facts
            .iter()
            .map(|(_, fact)| fact.knowledge_id)
            .collect::<std::collections::HashSet<_>>();
        for (score, fact) in facts {
            let content = format!("{} {} {}", fact.subject, fact.predicate, fact.object);
            candidates.push(build_candidate(
                ContextCandidateKind::AuthoritativeFact,
                content,
                fact.knowledge_id,
                format!("fact:{}:v{}", fact.knowledge_id, fact.knowledge_version),
                RetrievalMethod::Structured,
                ContextAuthority::AuthoritativeFact,
                score.max(7_000),
            ));
        }

        if let Some(world_state) = self.latest_world_state().ok().flatten() {
            let mut entries = world_state
                .entries
                .into_iter()
                .map(|entry| {
                    let score = score_values(
                        &normalized_query,
                        &[&entry.subject, &entry.predicate, &entry.object],
                    );
                    (score, entry)
                })
                .collect::<Vec<_>>();
            entries.sort_by_key(|left| std::cmp::Reverse(left.0));
            entries.truncate(12);
            for (score, entry) in entries {
                let content = format!("{} {} {}", entry.subject, entry.predicate, entry.object);
                candidates.push(build_candidate(
                    ContextCandidateKind::CurrentState,
                    content,
                    entry.fact_knowledge_id,
                    format!(
                        "world-state:{}:fact:{}:v{}",
                        world_state.id, entry.fact_knowledge_id, entry.fact_version
                    ),
                    RetrievalMethod::Structured,
                    ContextAuthority::TaskMaterial,
                    score.max(6_500),
                ));
            }
        }

        let mut entities = self
            .list_entities(false)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entity| {
                let revision = self
                    .list_entity_revisions(entity.id)
                    .ok()?
                    .into_iter()
                    .next()?;
                let score = [
                    score_values(&normalized_query, &[&revision.name]),
                    score_values(
                        &normalized_query,
                        &revision
                            .aliases
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                    ),
                    score_values(&normalized_query, &[&revision.description]),
                ]
                .into_iter()
                .max()
                .unwrap_or_default();
                Some((score, entity, revision))
            })
            .collect::<Vec<_>>();
        entities.sort_by_key(|left| std::cmp::Reverse(left.0));
        entities.truncate(8);
        for (score, entity, revision) in entities {
            let mut content = format!(
                "{}（{}）：{}",
                revision.name,
                entity_type_label(entity.entity_type),
                revision.description.trim()
            );
            if !revision.aliases.is_empty() {
                let _ = write!(content, "\n别名：{}", revision.aliases.join("、"));
            }
            if revision.fixed_attributes_json.trim() != "{}" {
                let _ = write!(
                    content,
                    "\n固定属性：{}",
                    revision.fixed_attributes_json.trim()
                );
            }
            candidates.push(build_candidate(
                ContextCandidateKind::Entity,
                content,
                entity.id,
                revision
                    .source_version
                    .unwrap_or_else(|| format!("entity:{}:r{}", entity.id, revision.revision)),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score.max(6_000),
            ));
        }

        let mut foreshadowings = self
            .list_foreshadowings()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                item.lifecycle_status == KnowledgeLifecycleStatus::Active
                    && !item.status.eq_ignore_ascii_case("RESOLVED")
            })
            .map(|item| {
                let target_score = u16::from(item.target_chapter_id == Some(input.chapter_id))
                    .saturating_mul(3_000);
                let score =
                    score_values(&normalized_query, &[&item.title]).saturating_add(target_score);
                (score, item)
            })
            .collect::<Vec<_>>();
        foreshadowings.sort_by_key(|left| std::cmp::Reverse(left.0));
        foreshadowings.truncate(6);
        for (score, item) in foreshadowings {
            candidates.push(build_candidate(
                ContextCandidateKind::Foreshadowing,
                format!("未回收伏笔：{}（{}）", item.title, item.status),
                item.id,
                format!("foreshadowing:{}:v{}", item.id, item.foreshadowing_version),
                RetrievalMethod::Structured,
                ContextAuthority::TaskMaterial,
                score.max(5_500),
            ));
        }

        let mut summaries = self
            .list_summary_materials()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.lifecycle_status == "ACTIVE")
            .map(|item| {
                let current_chapter_score =
                    u16::from(item.source_id == Some(input.chapter_id)).saturating_mul(5_000);
                let setting_score =
                    u16::from(item.kind == SummaryKind::Setting).saturating_mul(2_000);
                let score = score_values(&normalized_query, &[&item.content])
                    .saturating_add(current_chapter_score)
                    .saturating_add(setting_score);
                (score, item)
            })
            .collect::<Vec<_>>();
        summaries.sort_by_key(|left| std::cmp::Reverse(left.0));
        summaries.truncate(6);
        for (score, item) in summaries {
            candidates.push(build_candidate(
                ContextCandidateKind::Summary,
                format!(
                    "{} {}摘要：{}",
                    summary_precision_label(item.precision),
                    summary_kind_label(item.kind),
                    item.content.trim()
                ),
                item.id,
                item.source_version
                    .unwrap_or_else(|| format!("summary:{}", item.id)),
                RetrievalMethod::Structured,
                ContextAuthority::Reference,
                score.max(4_000),
            ));
        }

        let mut events = self
            .list_events()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.lifecycle_status == KnowledgeLifecycleStatus::Active)
            .map(|item| {
                let participant_hits = item
                    .participant_fact_ids
                    .iter()
                    .filter(|id| selected_fact_ids.contains(id))
                    .count();
                let participant_score = u16::try_from(participant_hits)
                    .unwrap_or(u16::MAX)
                    .saturating_mul(1_500);
                let score = score_values(&normalized_query, &[&item.name])
                    .saturating_add(participant_score);
                (score, item)
            })
            .collect::<Vec<_>>();
        events.sort_by_key(|left| std::cmp::Reverse(left.0));
        events.truncate(6);
        for (score, item) in events {
            candidates.push(build_candidate(
                ContextCandidateKind::Event,
                format!("事件（{}）：{}", item.occurred_at, item.name),
                item.id,
                format!("event:{}:v{}", item.id, item.event_version),
                RetrievalMethod::Structured,
                ContextAuthority::Reference,
                score.max(3_500),
            ));
        }

        let structured_source_ids = candidates
            .iter()
            .map(|candidate| candidate.evidence.chunk.source_id)
            .collect::<std::collections::HashSet<_>>();
        for result in self
            .search_project_objects(object_ids)
            .unwrap_or_default()
            .into_iter()
            .chain(
                self.search_project(input_search_query(input), None, 8, 0)
                    .unwrap_or_default(),
            )
        {
            if structured_source_ids.contains(&result.object_id) {
                continue;
            }
            candidates.push(search_result_candidate(
                result,
                5_000,
                RetrievalMethod::Keyword,
            ));
        }

        candidates
    }
}

fn input_search_query(input: &novel_application::AssembleContextInput) -> String {
    input
        .instruction
        .as_deref()
        .unwrap_or(input.chapter_title.as_str())
        .trim()
        .to_owned()
}

fn search_result_candidate(
    result: SearchResult,
    relevance: u16,
    method: RetrievalMethod,
) -> ContextCandidate {
    let authority = match result.object_type.as_str() {
        "ENTITY" | "PLAN" | "MANUSCRIPT" => ContextAuthority::TaskMaterial,
        _ => ContextAuthority::Reference,
    };
    build_candidate(
        ContextCandidateKind::Keyword,
        result.snippet,
        result.object_id,
        result
            .source_version
            .unwrap_or_else(|| "search:current".to_owned()),
        method,
        authority,
        relevance,
    )
}

fn build_candidate(
    kind: ContextCandidateKind,
    content: String,
    source_id: Uuid,
    source_revision: String,
    method: RetrievalMethod,
    authority: ContextAuthority,
    relevance: u16,
) -> ContextCandidate {
    let source_hash = format!("sha256:{:x}", Sha256::digest(content.as_bytes()));
    ContextCandidate::new(
        kind,
        RetrievalEvidence {
            chunk: KnowledgeChunk {
                id: Uuid::new_v4(),
                source_id,
                source_revision,
                source_hash,
                chunk_index: 0,
                chunking_version: "context-candidate-v1".to_owned(),
                content,
                embedding: None,
            },
            method,
            authority,
            relevance,
        },
    )
}

fn normalize_for_match(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && !character.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect()
}

fn score_values(query: &str, values: &[&str]) -> u16 {
    if query.is_empty() {
        return 0;
    }
    let mut best = 0_u16;
    for value in values {
        let normalized = normalize_for_match(value);
        if normalized.is_empty() {
            continue;
        }
        let length = normalized.chars().count();
        let score = if length > 1 && query.contains(&normalized) {
            u16::try_from(length.saturating_mul(200).min(4_000))
                .unwrap_or(u16::MAX)
                .saturating_add(5_000)
        } else if length > 1 {
            let overlap = normalized
                .chars()
                .filter(|character| query.contains(*character))
                .count();
            u16::try_from(overlap.saturating_mul(200).min(3_000)).unwrap_or(u16::MAX)
        } else {
            0
        };
        best = best.max(score);
    }
    best
}

fn entity_type_label(value: EntityType) -> &'static str {
    match value {
        EntityType::Character => "人物",
        EntityType::Location => "地点",
        EntityType::Faction => "势力",
        EntityType::Item => "道具",
        EntityType::Concept => "概念",
    }
}

fn summary_kind_label(value: SummaryKind) -> &'static str {
    match value {
        SummaryKind::Chapter => "章节",
        SummaryKind::Character => "人物",
        SummaryKind::Setting => "设定",
    }
}

fn summary_precision_label(value: SummaryPrecision) -> &'static str {
    match value {
        SummaryPrecision::L0 => "L0",
        SummaryPrecision::L1 => "L1",
        SummaryPrecision::L2 => "L2",
        SummaryPrecision::L3 => "L3",
        SummaryPrecision::L4 => "L4",
        SummaryPrecision::L5 => "L5",
    }
}
