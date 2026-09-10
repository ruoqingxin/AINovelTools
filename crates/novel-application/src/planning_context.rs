use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

pub const PLANNING_PROMPT_VERSION: &str = "planning-v6";

const CORE_PROJECT_SECTION_IDS: [&str; 6] = [
    "seed-premise",
    "seed-genre-promise",
    "engine-protagonist",
    "engine-antagonism",
    "engine-stakes",
    "engine-ending",
];
const MAX_PROJECT_SECTIONS: usize = 12;
const MAX_PROJECT_SEMANTIC_SECTIONS: usize = 8;
const MAX_PROJECT_EVIDENCE_CHUNKS: usize = 10;
const MAX_PROJECT_CHUNKS_PER_SECTION: usize = 3;
const MAX_PROJECT_SECTION_CHARS: usize = 1_200;
const MAX_PROJECT_EVIDENCE_SECTION_CHARS: usize = 2_000;
const MAX_PROJECT_BRIEF_CHARS: usize = 240;
const MAX_PROJECT_CHUNK_CHARS: usize = 600;
const MAX_REFERENCE_BLOCKS: usize = 12;
const MAX_REFERENCE_BLOCK_CHARS: usize = 1_200;
const MIN_BLOCK_BUDGET: usize = 80;
const MAX_QUERY_CHARS: usize = 512;
const TRUNCATION_MARKER: &str = "\n[片段已按预算截断]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanningContextMode {
    Generate,
    Extract,
    ExtractRewrite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningContextPlan {
    pub project_context: String,
    pub reference_context: String,
    pub selected_project_sections: u16,
    pub selected_project_chunks: u16,
    pub selected_reference_blocks: u16,
    pub omitted_reference_blocks: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningContextBlock {
    pub id: String,
    pub heading: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningSourceChunk {
    pub id: String,
    pub section_id: String,
    pub content: String,
}

impl From<PlanningBlock> for PlanningContextBlock {
    fn from(block: PlanningBlock) -> Self {
        Self {
            id: block.id,
            heading: block.heading,
            content: block.content,
        }
    }
}

pub struct PlanningContextPlanner;

impl PlanningContextPlanner {
    #[must_use]
    pub fn plan(
        project_context: &str,
        reference_content: &str,
        query: &str,
        mode: PlanningContextMode,
        max_project_chars: usize,
        max_reference_chars: usize,
    ) -> PlanningContextPlan {
        Self::plan_with_similarities(
            project_context,
            reference_content,
            query,
            mode,
            max_project_chars,
            max_reference_chars,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
    }

    #[must_use]
    pub fn plan_with_reference_similarities(
        project_context: &str,
        reference_content: &str,
        query: &str,
        mode: PlanningContextMode,
        max_project_chars: usize,
        max_reference_chars: usize,
        reference_similarities: &HashMap<String, f32>,
    ) -> PlanningContextPlan {
        Self::plan_with_similarities(
            project_context,
            reference_content,
            query,
            mode,
            max_project_chars,
            max_reference_chars,
            &HashMap::new(),
            &HashMap::new(),
            reference_similarities,
        )
    }

    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn plan_with_similarities(
        project_context: &str,
        reference_content: &str,
        query: &str,
        mode: PlanningContextMode,
        max_project_chars: usize,
        max_reference_chars: usize,
        project_section_similarities: &HashMap<String, f32>,
        project_chunk_similarities: &HashMap<String, f32>,
        reference_similarities: &HashMap<String, f32>,
    ) -> PlanningContextPlan {
        let project_blocks = parse_project_context(project_context);
        let reference_blocks = parse_reference_context(reference_content);
        let (project_context, selected_project_sections, selected_project_chunks) =
            select_project_context(
                &project_blocks,
                query,
                max_project_chars,
                project_section_similarities,
                project_chunk_similarities,
            );
        let reference_limit = if mode == PlanningContextMode::Generate {
            max_reference_chars.min(max_project_chars / 4)
        } else {
            max_reference_chars
        };
        let (rendered_reference, selected_reference_blocks) = select_reference_context(
            &reference_blocks,
            query,
            reference_limit,
            reference_similarities,
        );

        PlanningContextPlan {
            project_context,
            reference_context: rendered_reference,
            selected_project_sections,
            selected_project_chunks,
            selected_reference_blocks,
            omitted_reference_blocks: u16::try_from(
                reference_blocks
                    .len()
                    .saturating_sub(usize::from(selected_reference_blocks)),
            )
            .unwrap_or(u16::MAX),
        }
    }

    #[must_use]
    pub fn reference_semantic_candidates(
        reference_content: &str,
        query: &str,
        limit: usize,
    ) -> Vec<PlanningContextBlock> {
        let blocks = parse_reference_context(reference_content);
        select_semantic_candidate_indexes(&blocks, query, limit)
            .into_iter()
            .filter_map(|index| blocks.get(index).cloned())
            .map(PlanningContextBlock::from)
            .collect()
    }

    #[must_use]
    pub fn project_section_brief(content: &str, max_chars: usize) -> String {
        if max_chars == 0 || content.trim().is_empty() {
            return String::new();
        }
        let normalized = content.replace("\r\n", "\n");
        let mut headings = Vec::new();
        let mut leads = Vec::new();
        for line in normalized.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with('#') {
                let heading = trimmed.trim_start_matches('#').trim();
                if !heading.is_empty() && headings.len() < 6 {
                    headings.push(heading.to_owned());
                }
            } else if leads.len() < 2 {
                leads.push(trimmed.chars().take(160).collect::<String>());
            }
            if headings.len() >= 6 && leads.len() >= 2 {
                break;
            }
        }
        let mut parts = headings;
        parts.extend(leads);
        let compact = parts.join("；");
        if compact.is_empty() {
            return content.chars().take(max_chars).collect();
        }
        compact.chars().take(max_chars).collect()
    }

    #[must_use]
    pub fn project_semantic_candidates(
        sections: &[PlanningContextBlock],
        query: &str,
        per_section_limit: usize,
    ) -> Vec<PlanningSourceChunk> {
        let mut candidates = Vec::new();
        for section in sections {
            let chunks = split_project_section_chunks(&section.content);
            for index in select_chunk_indexes(&chunks, query, per_section_limit) {
                let Some(content) = chunks.get(index) else {
                    continue;
                };
                candidates.push(PlanningSourceChunk {
                    id: format!("{}#chunk-{}", section.id, index + 1),
                    section_id: section.id.clone(),
                    content: content.clone(),
                });
            }
        }
        candidates
    }
}

#[derive(Debug, Clone)]
struct PlanningBlock {
    id: String,
    heading: String,
    content: String,
}

fn parse_project_context(value: &str) -> Vec<PlanningBlock> {
    let normalized = value.replace("\r\n", "\n");
    let mut blocks = Vec::new();
    let mut current_id: Option<String> = None;
    let mut current_content = String::new();

    for line in normalized.lines() {
        let candidate = line
            .split_once(':')
            .and_then(|(id, _)| is_section_id(id).then(|| id.to_owned()));
        if let Some(id) = candidate {
            flush_project_block(&mut blocks, current_id.take(), &mut current_content);
            current_id = Some(id);
            if let Some((_, content)) = line.split_once(':') {
                current_content.push_str(content);
                current_content.push('\n');
            }
        } else if current_id.is_some() {
            current_content.push_str(line);
            current_content.push('\n');
        }
    }
    flush_project_block(&mut blocks, current_id, &mut current_content);

    let mut seen = HashSet::new();
    blocks.retain_mut(|block| {
        block.content = compact_lines(&block.content);
        !block.content.is_empty() && seen.insert(normalize_for_match(&block.content))
    });
    if blocks.is_empty() && !value.trim().is_empty() {
        blocks.push(PlanningBlock {
            id: "project-context".to_owned(),
            heading: String::new(),
            content: compact_lines(value),
        });
    }
    blocks
}

fn flush_project_block(blocks: &mut Vec<PlanningBlock>, id: Option<String>, content: &mut String) {
    let Some(id) = id else {
        return;
    };
    blocks.push(PlanningBlock {
        id,
        heading: String::new(),
        content: std::mem::take(content),
    });
}

fn parse_reference_context(value: &str) -> Vec<PlanningBlock> {
    let normalized = value.replace("\r\n", "\n");
    let mut blocks = Vec::new();
    let mut current = String::new();

    for line in normalized.lines() {
        if line.trim().is_empty() {
            flush_reference_block(&mut blocks, &mut current);
            continue;
        }
        if is_reference_heading(line) && !current.trim().is_empty() {
            flush_reference_block(&mut blocks, &mut current);
        }
        for chunk in split_long_line(line, MAX_REFERENCE_BLOCK_CHARS) {
            current.push_str(&chunk);
            current.push('\n');
            if current.chars().count() >= MAX_REFERENCE_BLOCK_CHARS {
                flush_reference_block(&mut blocks, &mut current);
            }
        }
    }
    flush_reference_block(&mut blocks, &mut current);

    let mut seen = HashSet::new();
    blocks.retain(|block| {
        !block.content.is_empty() && seen.insert(normalize_for_match(&block.content))
    });
    blocks
}

fn flush_reference_block(blocks: &mut Vec<PlanningBlock>, current: &mut String) {
    let content = compact_lines(current);
    if content.is_empty() {
        return;
    }
    let heading = content
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| line.chars().count() <= 80)
        .unwrap_or_default()
        .to_owned();
    blocks.push(PlanningBlock {
        id: format!("reference-{}", blocks.len() + 1),
        heading,
        content,
    });
    current.clear();
}

fn compact_lines(value: &str) -> String {
    let mut seen = HashSet::new();
    value
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .filter(|line| seen.insert((*line).to_owned()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_long_line(value: &str, max_chars: usize) -> Vec<String> {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= max_chars {
        return vec![value.to_owned()];
    }
    characters
        .chunks(max_chars)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

fn split_project_section_chunks(value: &str) -> Vec<String> {
    let normalized = value.replace("\r\n", "\n");
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_length = 0_usize;

    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let line_length = trimmed.chars().count();
        if line_length > MAX_PROJECT_CHUNK_CHARS {
            flush_project_section_chunk(&mut chunks, &mut current, &mut current_length);
            chunks.extend(
                split_long_line(trimmed, MAX_PROJECT_CHUNK_CHARS)
                    .into_iter()
                    .filter(|chunk| !chunk.trim().is_empty()),
            );
            continue;
        }
        let separator = usize::from(!current.is_empty());
        if current_length
            .saturating_add(separator)
            .saturating_add(line_length)
            > MAX_PROJECT_CHUNK_CHARS
        {
            flush_project_section_chunk(&mut chunks, &mut current, &mut current_length);
        }
        if !current.is_empty() {
            current.push('\n');
            current_length = current_length.saturating_add(1);
        }
        current.push_str(trimmed);
        current_length = current_length.saturating_add(line_length);
    }
    flush_project_section_chunk(&mut chunks, &mut current, &mut current_length);
    chunks
}

fn flush_project_section_chunk(
    chunks: &mut Vec<String>,
    current: &mut String,
    current_length: &mut usize,
) {
    if current.trim().is_empty() {
        current.clear();
        *current_length = 0;
        return;
    }
    chunks.push(std::mem::take(current));
    *current_length = 0;
}

fn is_section_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

fn is_reference_heading(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('#')
        || trimmed.starts_with("===== 文件：")
        || (trimmed.ends_with(':') && trimmed.chars().count() <= 48)
}

fn select_project_context(
    blocks: &[PlanningBlock],
    query: &str,
    max_chars: usize,
    section_similarities: &HashMap<String, f32>,
    chunk_similarities: &HashMap<String, f32>,
) -> (String, u16, u16) {
    if blocks.is_empty() || max_chars == 0 {
        return (String::new(), 0, 0);
    }
    if chunk_similarities.is_empty() {
        return select_project_context_by_section(blocks, query, max_chars);
    }
    select_project_context_with_chunks(
        blocks,
        query,
        max_chars,
        section_similarities,
        chunk_similarities,
    )
}

fn select_project_context_by_section(
    blocks: &[PlanningBlock],
    query: &str,
    max_chars: usize,
) -> (String, u16, u16) {
    if blocks.is_empty() || max_chars == 0 {
        return (String::new(), 0, 0);
    }

    let mut ranked = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let core_score = u32::from(CORE_PROJECT_SECTION_IDS.contains(&block.id.as_str()))
                .saturating_mul(10_000);
            (
                index,
                core_score.saturating_add(relevance_score(query, block)),
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

    let core_count = blocks
        .iter()
        .filter(|block| CORE_PROJECT_SECTION_IDS.contains(&block.id.as_str()))
        .count();
    let selection_limit = MAX_PROJECT_SECTIONS
        .min(
            (max_chars / MIN_BLOCK_BUDGET)
                .max(core_count.min(MAX_PROJECT_SECTIONS))
                .max(1),
        )
        .min(blocks.len());
    let mut selected_indexes = blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| CORE_PROJECT_SECTION_IDS.contains(&block.id.as_str()))
        .map(|(index, _)| index)
        .take(selection_limit)
        .collect::<HashSet<_>>();
    for (index, _) in ranked {
        if selected_indexes.len() >= selection_limit {
            break;
        }
        selected_indexes.insert(index);
    }
    let (rendered, selected) = render_project_blocks(blocks, &selected_indexes, query, max_chars);
    (rendered, selected, 0)
}

#[derive(Debug, Clone)]
struct ScoredProjectChunk {
    section_index: usize,
    chunk_index: usize,
    content: String,
    score: f64,
}

fn select_project_context_with_chunks(
    blocks: &[PlanningBlock],
    query: &str,
    max_chars: usize,
    section_similarities: &HashMap<String, f32>,
    chunk_similarities: &HashMap<String, f32>,
) -> (String, u16, u16) {
    let section_ranking =
        rank_project_sections(blocks, query, section_similarities, chunk_similarities);
    let selected_sections = select_project_section_indexes(blocks, max_chars, &section_ranking);
    let mut scored_chunks = score_project_chunks(
        blocks,
        query,
        &selected_sections,
        &section_ranking,
        chunk_similarities,
    );
    if scored_chunks.is_empty() {
        return select_project_context_by_section(blocks, query, max_chars);
    }
    scored_chunks.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.section_index.cmp(&right.section_index))
            .then_with(|| left.chunk_index.cmp(&right.chunk_index))
    });
    let selected_chunks =
        select_project_evidence_chunks(&scored_chunks, &selected_sections, max_chars);
    render_project_evidence(blocks, &selected_chunks, query, max_chars)
}

fn select_project_section_indexes(
    blocks: &[PlanningBlock],
    max_chars: usize,
    section_ranking: &[(usize, f64)],
) -> HashSet<usize> {
    let section_limit = MAX_PROJECT_SEMANTIC_SECTIONS
        .min((max_chars / (MAX_PROJECT_BRIEF_CHARS + MIN_BLOCK_BUDGET)).max(1))
        .min(blocks.len());
    let mut selected_sections = blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| CORE_PROJECT_SECTION_IDS.contains(&block.id.as_str()))
        .map(|(index, _)| index)
        .take(section_limit)
        .collect::<HashSet<_>>();
    for (index, _) in section_ranking {
        if selected_sections.len() >= section_limit {
            break;
        }
        selected_sections.insert(*index);
    }
    selected_sections
}

fn score_project_chunks(
    blocks: &[PlanningBlock],
    query: &str,
    selected_sections: &HashSet<usize>,
    section_ranking: &[(usize, f64)],
    chunk_similarities: &HashMap<String, f32>,
) -> Vec<ScoredProjectChunk> {
    let mut scored_chunks = Vec::new();
    for (section_index, block) in blocks.iter().enumerate() {
        if !selected_sections.contains(&section_index) {
            continue;
        }
        let section_score = section_ranking
            .iter()
            .find(|(index, _)| *index == section_index)
            .map_or(0.0, |(_, score)| *score);
        let chunks = split_project_section_chunks(&block.content);
        let max_keyword = chunks
            .iter()
            .map(|chunk| content_relevance_score(query, chunk))
            .max()
            .unwrap_or_default();
        let last_chunk = chunks.len().saturating_sub(1).max(1);
        for (chunk_index, content) in chunks.into_iter().enumerate() {
            let id = format!("{}#chunk-{}", block.id, chunk_index + 1);
            let similarity = chunk_similarities.get(&id).copied();
            let semantic = f64::from(similarity.unwrap_or_default().clamp(0.0, 1.0));
            let keyword = content_relevance_score(query, &content);
            let keyword_normalized = if max_keyword == 0 {
                0.0
            } else {
                f64::from(keyword) / f64::from(max_keyword)
            };
            let chunk_number = u32::try_from(chunk_index).map_or(f64::MAX, f64::from);
            let last_chunk_number = u32::try_from(last_chunk).map_or(f64::MAX, f64::from);
            let position = 1.0 - (chunk_number / last_chunk_number);
            let score = semantic * 0.55
                + keyword_normalized * 0.20
                + section_score * 0.15
                + position * 0.10;
            scored_chunks.push(ScoredProjectChunk {
                section_index,
                chunk_index,
                content,
                score,
            });
        }
    }
    scored_chunks
}

fn select_project_evidence_chunks(
    scored_chunks: &[ScoredProjectChunk],
    selected_sections: &HashSet<usize>,
    max_chars: usize,
) -> Vec<ScoredProjectChunk> {
    let chunk_limit = MAX_PROJECT_EVIDENCE_CHUNKS
        .min((max_chars / MIN_BLOCK_BUDGET).max(1))
        .min(scored_chunks.len());
    let mut selected_chunks = Vec::new();
    let mut per_section = HashMap::<usize, usize>::new();
    for chunk in scored_chunks {
        if selected_chunks.len() >= chunk_limit {
            break;
        }
        let count = per_section.get(&chunk.section_index).copied().unwrap_or(0);
        if count >= MAX_PROJECT_CHUNKS_PER_SECTION {
            continue;
        }
        selected_chunks.push(ScoredProjectChunk {
            section_index: chunk.section_index,
            chunk_index: chunk.chunk_index,
            content: chunk.content.clone(),
            score: chunk.score,
        });
        per_section.insert(chunk.section_index, count + 1);
    }
    for section_index in selected_sections {
        if selected_chunks.len() >= chunk_limit
            || selected_chunks
                .iter()
                .any(|chunk| chunk.section_index == *section_index)
        {
            continue;
        }
        if let Some(chunk) = scored_chunks
            .iter()
            .find(|chunk| chunk.section_index == *section_index)
        {
            selected_chunks.push(ScoredProjectChunk {
                section_index: chunk.section_index,
                chunk_index: chunk.chunk_index,
                content: chunk.content.clone(),
                score: chunk.score,
            });
        }
    }
    selected_chunks.sort_by_key(|chunk| (chunk.section_index, chunk.chunk_index));
    selected_chunks
}

fn rank_project_sections(
    blocks: &[PlanningBlock],
    query: &str,
    section_similarities: &HashMap<String, f32>,
    chunk_similarities: &HashMap<String, f32>,
) -> Vec<(usize, f64)> {
    let keyword_scores = blocks
        .iter()
        .map(|block| relevance_score(query, block))
        .collect::<Vec<_>>();
    let max_keyword = keyword_scores.iter().copied().max().unwrap_or_default();
    let mut chunk_scores = HashMap::<&str, f32>::new();
    for (id, similarity) in chunk_similarities {
        let Some((section_id, _)) = id.split_once("#chunk-") else {
            continue;
        };
        chunk_scores
            .entry(section_id)
            .and_modify(|score| *score = score.max(*similarity))
            .or_insert(*similarity);
    }
    let mut ranked = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let keyword = keyword_scores.get(index).copied().unwrap_or_default();
            let keyword_normalized = if max_keyword == 0 {
                0.0
            } else {
                f64::from(keyword) / f64::from(max_keyword)
            };
            let section_semantic = f64::from(
                section_similarities
                    .get(&block.id)
                    .copied()
                    .unwrap_or_default()
                    .clamp(0.0, 1.0),
            );
            let chunk_semantic = f64::from(
                chunk_scores
                    .get(block.id.as_str())
                    .copied()
                    .unwrap_or_default()
                    .clamp(0.0, 1.0),
            );
            let core = f64::from(CORE_PROJECT_SECTION_IDS.contains(&block.id.as_str()));
            (
                index,
                section_semantic * 0.30
                    + chunk_semantic * 0.30
                    + keyword_normalized * 0.25
                    + core * 0.15,
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    ranked
}

fn render_project_evidence(
    blocks: &[PlanningBlock],
    selected_chunks: &[ScoredProjectChunk],
    query: &str,
    max_chars: usize,
) -> (String, u16, u16) {
    let mut section_indexes = selected_chunks
        .iter()
        .map(|chunk| chunk.section_index)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    section_indexes.sort_unstable();

    let base_sections = render_project_navigation_bases(blocks, &section_indexes, max_chars);
    if base_sections.is_empty() {
        return select_project_context_by_section(blocks, query, max_chars);
    }
    let chosen_chunks = choose_project_evidence_chunks(selected_chunks, &base_sections, max_chars);
    render_project_evidence_sections(base_sections, selected_chunks, &chosen_chunks)
}

fn render_project_navigation_bases(
    blocks: &[PlanningBlock],
    section_indexes: &[usize],
    max_chars: usize,
) -> Vec<(usize, String)> {
    let mut base_sections = Vec::with_capacity(section_indexes.len());
    let mut remaining = max_chars;
    let total_sections = section_indexes.len();
    for (position, section_index) in section_indexes.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let Some(block) = blocks.get(*section_index) else {
            continue;
        };
        let brief =
            PlanningContextPlanner::project_section_brief(&block.content, MAX_PROJECT_BRIEF_CHARS);
        let prefix = format!("{}: ", block.id);
        let navigation = if brief.is_empty() {
            String::new()
        } else {
            format!("[节点导航] {brief}")
        };
        let remaining_sections = total_sections.saturating_sub(position).max(1);
        let allowance = remaining
            .saturating_div(remaining_sections)
            .min(MAX_PROJECT_EVIDENCE_SECTION_CHARS);
        if allowance <= prefix.chars().count() {
            break;
        }
        let navigation = if navigation
            .chars()
            .count()
            .saturating_add(prefix.chars().count())
            > allowance
        {
            navigation
                .chars()
                .take(allowance.saturating_sub(prefix.chars().count()))
                .collect()
        } else {
            navigation
        };
        let text = format!("{prefix}{navigation}");
        remaining = remaining.saturating_sub(text.chars().count().saturating_add(2));
        base_sections.push((*section_index, text));
    }
    base_sections
}

fn choose_project_evidence_chunks(
    selected_chunks: &[ScoredProjectChunk],
    base_sections: &[(usize, String)],
    max_chars: usize,
) -> HashSet<(usize, usize)> {
    let base_length = base_sections
        .iter()
        .map(|(_, text)| text.chars().count().saturating_add(2))
        .sum::<usize>();
    let mut evidence_budget = max_chars.saturating_sub(base_length);
    let mut ranked_chunks = selected_chunks.to_vec();
    ranked_chunks.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.section_index.cmp(&right.section_index))
            .then_with(|| left.chunk_index.cmp(&right.chunk_index))
    });
    let base_by_section = base_sections
        .iter()
        .map(|(section_index, _)| *section_index)
        .collect::<HashSet<_>>();
    let mut chosen_chunks = HashSet::new();
    let mut per_section_chars = HashMap::<usize, usize>::new();
    for chunk in ranked_chunks {
        if !base_by_section.contains(&chunk.section_index) {
            continue;
        }
        let marker = format!("[原文片段 {}] ", chunk.chunk_index + 1);
        let text_length = marker
            .chars()
            .count()
            .saturating_add(chunk.content.chars().count())
            .saturating_add(1);
        let section_chars = per_section_chars
            .get(&chunk.section_index)
            .copied()
            .unwrap_or_default();
        if text_length > evidence_budget
            || section_chars.saturating_add(text_length) > MAX_PROJECT_EVIDENCE_SECTION_CHARS
        {
            continue;
        }
        evidence_budget = evidence_budget.saturating_sub(text_length);
        per_section_chars.insert(
            chunk.section_index,
            section_chars.saturating_add(text_length),
        );
        chosen_chunks.insert((chunk.section_index, chunk.chunk_index));
    }
    chosen_chunks
}

fn render_project_evidence_sections(
    base_sections: Vec<(usize, String)>,
    selected_chunks: &[ScoredProjectChunk],
    chosen_chunks: &HashSet<(usize, usize)>,
) -> (String, u16, u16) {
    let mut grouped = HashMap::<usize, Vec<&ScoredProjectChunk>>::new();
    for chunk in selected_chunks {
        if chosen_chunks.contains(&(chunk.section_index, chunk.chunk_index)) {
            grouped.entry(chunk.section_index).or_default().push(chunk);
        }
    }
    for chunks in grouped.values_mut() {
        chunks.sort_by_key(|chunk| chunk.chunk_index);
    }

    let mut rendered = Vec::with_capacity(base_sections.len());
    let mut selected_chunks_count = 0_u16;
    for (section_index, base) in base_sections {
        let mut text = base;
        if let Some(chunks) = grouped.get(&section_index) {
            for chunk in chunks {
                text.push('\n');
                let _ = write!(
                    text,
                    "[原文片段 {}] {}",
                    chunk.chunk_index + 1,
                    chunk.content
                );
                selected_chunks_count = selected_chunks_count.saturating_add(1);
            }
        }
        rendered.push(text);
    }
    (
        rendered.join("\n\n"),
        u16::try_from(rendered.len()).unwrap_or(u16::MAX),
        selected_chunks_count,
    )
}

fn select_reference_context(
    blocks: &[PlanningBlock],
    query: &str,
    max_chars: usize,
    similarities: &HashMap<String, f32>,
) -> (String, u16) {
    if blocks.is_empty() || max_chars == 0 {
        return (String::new(), 0);
    }

    let keyword_scores = blocks
        .iter()
        .map(|block| relevance_score(query, block))
        .collect::<Vec<_>>();
    let ranked = if similarities.is_empty() {
        rank_reference_blocks_by_keyword(blocks, &keyword_scores)
    } else {
        rank_reference_blocks_hybrid(blocks, query, &keyword_scores, similarities)
    };

    let selection_limit = MAX_REFERENCE_BLOCKS
        .min((max_chars / MIN_BLOCK_BUDGET).max(1))
        .min(blocks.len());
    let mut selected_indexes = HashSet::new();
    selected_indexes.insert(0);
    for (index, _score, relevant) in ranked {
        if selected_indexes.len() >= selection_limit {
            break;
        }
        if relevant {
            selected_indexes.insert(index);
        }
    }
    let (rendered, selected_count) =
        render_reference_blocks(blocks, &selected_indexes, query, max_chars);
    if rendered.is_empty() {
        return (
            compact_fallback(&blocks[0].content, query, max_chars),
            u16::from(max_chars > 0),
        );
    }
    (rendered, selected_count)
}

fn rank_reference_blocks_by_keyword(
    blocks: &[PlanningBlock],
    keyword_scores: &[u32],
) -> Vec<(usize, f64, bool)> {
    let mut ranked = blocks
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let score = keyword_scores.get(index).copied().unwrap_or_default();
            (index, f64::from(score), score > 0)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    ranked
}

fn rank_reference_blocks_hybrid(
    blocks: &[PlanningBlock],
    query: &str,
    keyword_scores: &[u32],
    similarities: &HashMap<String, f32>,
) -> Vec<(usize, f64, bool)> {
    let max_keyword = keyword_scores.iter().copied().max().unwrap_or_default();
    let heading_scores = blocks
        .iter()
        .map(|block| heading_relevance_score(query, block))
        .collect::<Vec<_>>();
    let max_heading = heading_scores.iter().copied().max().unwrap_or_default();
    let last_index = u32::try_from(blocks.len().saturating_sub(1).max(1)).unwrap_or(u32::MAX);
    let mut ranked = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let keyword = keyword_scores.get(index).copied().unwrap_or_default();
            let keyword_normalized = if max_keyword == 0 {
                0.0
            } else {
                f64::from(keyword) / f64::from(max_keyword)
            };
            let heading = heading_scores.get(index).copied().unwrap_or_default();
            let heading_normalized = if max_heading == 0 {
                0.0
            } else {
                f64::from(heading) / f64::from(max_heading)
            };
            let index_number = u32::try_from(index).unwrap_or(u32::MAX);
            let position = 1.0 - (f64::from(index_number) / f64::from(last_index));
            let similarity = similarities.get(&block.id).copied();
            let semantic = f64::from(similarity.unwrap_or_default().clamp(0.0, 1.0));
            let score = semantic * 0.55
                + keyword_normalized * 0.30
                + heading_normalized * 0.10
                + position * 0.05;
            let relevant = similarity.is_some_and(|value| value >= 0.20) || keyword > 0;
            (index, score, relevant)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    ranked
}

fn select_semantic_candidate_indexes(
    blocks: &[PlanningBlock],
    query: &str,
    limit: usize,
) -> Vec<usize> {
    if blocks.is_empty() || limit == 0 {
        return Vec::new();
    }
    if blocks.len() <= limit {
        return (0..blocks.len()).collect();
    }

    let scores = blocks
        .iter()
        .map(|block| relevance_score(query, block))
        .collect::<Vec<_>>();
    let mut ranked = blocks
        .iter()
        .enumerate()
        .map(|(index, _)| (index, scores.get(index).copied().unwrap_or_default()))
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

    let mut selected = HashSet::new();
    selected.insert(0);
    let keyword_slots = limit.saturating_mul(2) / 3;
    for (index, _) in ranked.iter().take(keyword_slots) {
        selected.insert(*index);
    }

    let sample_slots = limit.saturating_sub(selected.len());
    if sample_slots > 0 {
        for sample in 0..sample_slots {
            let index = if sample_slots == 1 {
                blocks.len() / 2
            } else {
                sample.saturating_mul(blocks.len() - 1) / (sample_slots - 1)
            };
            selected.insert(index);
        }
    }
    for (index, _) in ranked {
        if selected.len() >= limit {
            break;
        }
        selected.insert(index);
    }

    let mut indexes = selected.into_iter().collect::<Vec<_>>();
    indexes.sort_unstable();
    indexes.truncate(limit);
    indexes
}

fn select_chunk_indexes(chunks: &[String], query: &str, limit: usize) -> Vec<usize> {
    if chunks.is_empty() || limit == 0 {
        return Vec::new();
    }
    if chunks.len() <= limit {
        return (0..chunks.len()).collect();
    }

    let mut ranked = chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| (index, content_relevance_score(query, chunk)))
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

    let mut selected = HashSet::new();
    selected.insert(0);
    let keyword_slots = limit.saturating_mul(2) / 3;
    for (index, _) in ranked.iter().take(keyword_slots) {
        selected.insert(*index);
    }

    let sample_slots = limit.saturating_sub(selected.len());
    if sample_slots > 0 {
        for sample in 0..sample_slots {
            let index = if sample_slots == 1 {
                chunks.len() / 2
            } else {
                sample.saturating_mul(chunks.len() - 1) / (sample_slots - 1)
            };
            selected.insert(index);
        }
    }
    for (index, _) in ranked {
        if selected.len() >= limit {
            break;
        }
        selected.insert(index);
    }

    let mut indexes = selected.into_iter().collect::<Vec<_>>();
    indexes.sort_unstable();
    indexes.truncate(limit);
    indexes
}

fn render_project_blocks(
    blocks: &[PlanningBlock],
    selected: &HashSet<usize>,
    query: &str,
    max_chars: usize,
) -> (String, u16) {
    let indexes = blocks
        .iter()
        .enumerate()
        .filter(|(index, _)| selected.contains(index))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut rendered = Vec::with_capacity(indexes.len());
    let mut remaining = max_chars;
    let mut included = 0_u16;
    for (position, index) in indexes.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let block = &blocks[*index];
        let remaining_blocks = indexes.len().saturating_sub(position).max(1);
        let allowance = remaining / remaining_blocks;
        let prefix = format!("{}: ", block.id);
        if allowance <= prefix.chars().count() {
            break;
        }
        let section_limit = MAX_PROJECT_SECTION_CHARS.min(allowance);
        let content = truncate_block(
            &block.content,
            query,
            section_limit.saturating_sub(prefix.chars().count()),
        );
        let text = format!("{prefix}{content}");
        remaining = remaining.saturating_sub(text.chars().count().saturating_add(2));
        rendered.push(text);
        included = included.saturating_add(1);
    }
    (rendered.join("\n\n"), included)
}

fn render_reference_blocks(
    blocks: &[PlanningBlock],
    selected: &HashSet<usize>,
    query: &str,
    max_chars: usize,
) -> (String, u16) {
    let indexes = blocks
        .iter()
        .enumerate()
        .filter(|(index, _)| selected.contains(index))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let omitted = blocks.len().saturating_sub(indexes.len());
    let omission_marker = if omitted > 0 {
        format!("\n[已按相关度省略 {omitted} 个文件片段]")
    } else {
        String::new()
    };
    let content_budget = max_chars.saturating_sub(omission_marker.chars().count());
    let mut rendered = Vec::with_capacity(indexes.len());
    let mut remaining = content_budget;
    let mut included = 0_u16;
    for (position, index) in indexes.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let block = &blocks[*index];
        let remaining_blocks = indexes.len().saturating_sub(position).max(1);
        let allowance = remaining / remaining_blocks;
        let prefix = format!("[文件片段 {}] ", position + 1);
        if allowance <= prefix.chars().count() {
            break;
        }
        let content = truncate_block(
            &block.content,
            query,
            allowance.saturating_sub(prefix.chars().count()),
        );
        let text = format!("{prefix}{content}");
        remaining = remaining.saturating_sub(text.chars().count().saturating_add(2));
        rendered.push(text);
        included = included.saturating_add(1);
    }
    if rendered.is_empty() {
        return (String::new(), 0);
    }
    let mut output = rendered.join("\n\n");
    if !omission_marker.is_empty()
        && output
            .chars()
            .count()
            .saturating_add(omission_marker.chars().count())
            <= max_chars
    {
        output.push_str(&omission_marker);
    }
    (output, included)
}

fn compact_fallback(value: &str, query: &str, max_chars: usize) -> String {
    truncate_block(value, query, max_chars)
}

fn truncate_block(value: &str, query: &str, max_chars: usize) -> String {
    let length = value.chars().count();
    if length <= max_chars {
        return value.to_owned();
    }
    if let Some(match_offset) = first_match_char_offset(value, query) {
        let overhead = 6;
        let window = max_chars.saturating_sub(overhead);
        let start = match_offset
            .saturating_sub(window / 3)
            .min(length.saturating_sub(window));
        let excerpt = value.chars().skip(start).take(window).collect::<String>();
        return format!(
            "{}{}{}",
            if start > 0 { "..." } else { "" },
            excerpt,
            if start.saturating_add(window) < length {
                "..."
            } else {
                ""
            }
        );
    }
    let marker_length = TRUNCATION_MARKER.chars().count();
    if max_chars <= marker_length {
        return TRUNCATION_MARKER.chars().take(max_chars).collect();
    }
    let kept = max_chars.saturating_sub(marker_length);
    let head_chars = kept.saturating_mul(2) / 3;
    let tail_chars = kept.saturating_sub(head_chars);
    let head = value.chars().take(head_chars).collect::<String>();
    let tail = value
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{TRUNCATION_MARKER}{tail}")
}

fn first_match_char_offset(value: &str, query: &str) -> Option<usize> {
    let lower_value = value.to_lowercase();
    let mut terms = query_terms(query);
    terms.sort_by_key(|term| std::cmp::Reverse(term.chars().count()));
    terms.into_iter().find_map(|term| {
        lower_value
            .find(&term)
            .map(|byte_offset| lower_value[..byte_offset].chars().count())
    })
}

fn relevance_score(query: &str, block: &PlanningBlock) -> u32 {
    heading_relevance_score(query, block)
        .saturating_add(content_relevance_score(query, &block.content))
}

fn heading_relevance_score(query: &str, block: &PlanningBlock) -> u32 {
    let terms = query_terms(query);
    if terms.is_empty() {
        return 0;
    }
    let heading = normalize_for_match(&block.heading);
    terms.into_iter().fold(0_u32, |score, term| {
        let weight = u32::try_from(term.chars().count().saturating_mul(term.chars().count()))
            .unwrap_or(u32::MAX);
        let heading_score = if heading.contains(&term) {
            weight.saturating_mul(2)
        } else {
            0
        };
        score.saturating_add(heading_score)
    })
}

fn content_relevance_score(query: &str, content: &str) -> u32 {
    let terms = query_terms(query);
    if terms.is_empty() {
        return 0;
    }
    let content = normalize_for_match(content);
    terms.into_iter().fold(0_u32, |score, term| {
        let weight = u32::try_from(term.chars().count().saturating_mul(term.chars().count()))
            .unwrap_or(u32::MAX);
        let content_score = if content.contains(&term) { weight } else { 0 };
        score.saturating_add(content_score)
    })
}

fn query_terms(query: &str) -> Vec<String> {
    let normalized = query
        .chars()
        .take(MAX_QUERY_CHARS)
        .filter(|character| !character.is_whitespace() && !character.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let characters = normalized.chars().collect::<Vec<_>>();
    let mut terms = HashSet::new();
    for size in 2..=4 {
        for window in characters.windows(size) {
            terms.insert(window.iter().collect::<String>());
        }
    }
    terms.into_iter().collect()
}

fn normalize_for_match(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && !character.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planning_plan_keeps_core_sections_under_a_small_budget() {
        let project = [
            "seed-premise: 主角在灾后城市寻找失踪姐姐。",
            "seed-genre-promise: 都市悬疑，持续推进谜团。",
            "engine-protagonist: 外在目标是找人，内在需求是接受失去。",
            "engine-antagonism: 对手掌握城市资源。",
            "engine-stakes: 失败会失去最后的家人线索。",
            "engine-ending: 主角接受真相并建立新的生活。",
            "seed-hook: 独特钩子",
            "frame-narrative: 第三人称有限视角",
        ]
        .join("\n");

        let plan = PlanningContextPlanner::plan(
            &project,
            "",
            "补全主角目标",
            PlanningContextMode::Generate,
            420,
            0,
        );

        for section_id in CORE_PROJECT_SECTION_IDS {
            assert!(
                plan.project_context.contains(&format!("{section_id}:")),
                "missing core section {section_id}"
            );
        }
        assert!(plan.project_context.chars().count() <= 420);
    }

    #[test]
    fn planning_plan_caps_individual_project_sections() {
        let long_section = "长期设定背景".repeat(1_000);
        let project = CORE_PROJECT_SECTION_IDS
            .iter()
            .map(|section_id| format!("{section_id}: {long_section}"))
            .collect::<Vec<_>>()
            .join("\n");

        let plan = PlanningContextPlanner::plan(
            &project,
            "",
            "补充当前节点",
            PlanningContextMode::Generate,
            100_000,
            0,
        );

        assert!(plan.project_context.contains("[片段已按预算截断]"));
        assert!(
            plan.project_context.chars().count()
                <= CORE_PROJECT_SECTION_IDS.len() * (MAX_PROJECT_SECTION_CHARS + 16)
        );
    }

    #[test]
    fn planning_plan_selects_relevant_reference_blocks_instead_of_full_file() {
        let reference = [
            "文件开篇设定城市长期停电。",
            "无关段落：王城港口以渔业闻名，拥有三家商会。",
            "主角林澈左臂受伤后无法长时间持剑。",
            "无关段落：北方学院每十年举办一次学术竞赛。",
            "林澈需要隐瞒伤口，否则会被对手发现。",
        ]
        .join("\n\n");

        let plan = PlanningContextPlanner::plan(
            "",
            &reference,
            "林澈 左臂受伤 隐瞒伤口",
            PlanningContextMode::Extract,
            0,
            300,
        );

        assert!(plan.reference_context.contains("林澈左臂受伤"));
        assert!(plan.reference_context.contains("隐瞒伤口"));
        assert!(!plan.reference_context.contains("三家商会"));
        assert!(plan.reference_context.contains("已按相关度省略"));
        assert!(plan.reference_context.chars().count() <= 300);
        assert!(plan.omitted_reference_blocks > 0);
    }

    #[test]
    fn planning_plan_chunks_a_single_long_file_line() {
        let unrelated = "无关背景".repeat(500);
        let relevant = "林澈左臂受伤后无法长时间持剑，并且必须隐瞒伤口。";
        let reference = format!("{unrelated}{relevant}{unrelated}");

        let plan = PlanningContextPlanner::plan(
            "",
            &reference,
            "林澈 左臂受伤 隐瞒伤口",
            PlanningContextMode::Extract,
            0,
            360,
        );

        assert!(plan.reference_context.contains("左臂受伤"));
        assert!(plan.reference_context.contains("隐瞒伤口"));
        assert!(plan.selected_reference_blocks >= 2);
        assert!(plan.reference_context.chars().count() <= 360);
    }

    #[test]
    fn planning_plan_uses_semantic_scores_when_keywords_do_not_overlap() {
        let reference = [
            "文件开篇设定城市长期停电。",
            "他每次靠近旧钟楼都会下意识遮住手腕，离开后才恢复平静。",
            "北方学院每十年举办一次学术竞赛。",
        ]
        .join("\n\n");
        let similarities = HashMap::from([("reference-2".to_owned(), 0.91_f32)]);

        let plan = PlanningContextPlanner::plan_with_reference_similarities(
            "",
            &reference,
            "创伤反应 隐藏身份 关键线索",
            PlanningContextMode::Extract,
            0,
            300,
            &similarities,
        );

        assert!(plan.reference_context.contains("旧钟楼"));
        assert!(!plan.reference_context.contains("学术竞赛"));
    }

    #[test]
    fn semantic_candidates_keep_document_coverage_outside_keyword_top_blocks() {
        let reference = (0..30)
            .map(|index| format!("第 {index} 段只有普通背景信息。"))
            .collect::<Vec<_>>()
            .join("\n\n");

        let candidates =
            PlanningContextPlanner::reference_semantic_candidates(&reference, "完全不同的查询", 8);

        assert_eq!(candidates.len(), 8);
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.id == "reference-30")
        );
    }

    #[test]
    fn project_chunks_respect_the_chunk_limit_and_keep_relevant_tail_content() {
        let content = format!(
            "{}{}{}",
            "无关背景。".repeat(180),
            "林澈左臂的旧伤使他无法长时间持剑。",
            "其他背景。".repeat(180)
        );
        let chunks = split_project_section_chunks(&content);

        assert!(chunks.len() > 1);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.chars().count() <= MAX_PROJECT_CHUNK_CHARS)
        );
        let candidates = PlanningContextPlanner::project_semantic_candidates(
            &[PlanningContextBlock {
                id: "seed-premise".to_owned(),
                heading: String::new(),
                content,
            }],
            "林澈 左臂 旧伤",
            3,
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.content.contains("旧伤"))
        );
    }

    #[test]
    fn project_chunk_similarities_render_briefs_and_raw_evidence_without_the_full_section() {
        let long_section = format!(
            "{}{}{}",
            "无关背景。".repeat(220),
            "林澈左臂的旧伤使他无法长时间持剑。",
            "其他背景。".repeat(220)
        );
        let chunks = split_project_section_chunks(&long_section);
        let relevant_index = chunks
            .iter()
            .position(|chunk| chunk.contains("旧伤"))
            .expect("relevant chunk");
        let project = [
            format!("seed-premise: {long_section}"),
            "seed-genre-promise: 都市悬疑，持续推进谜团。".to_owned(),
            "engine-protagonist: 主角需要遮掩自己的弱点。".to_owned(),
            "engine-antagonism: 对手会利用任何破绽。".to_owned(),
            "engine-stakes: 暴露弱点会失去调查资格。".to_owned(),
            "engine-ending: 主角学会主动面对创伤。".to_owned(),
        ]
        .join("\n");
        let similarities = HashMap::from([(
            format!("seed-premise#chunk-{}", relevant_index + 1),
            0.93_f32,
        )]);

        let plan = PlanningContextPlanner::plan_with_similarities(
            &project,
            "",
            "创伤反应 隐藏身份",
            PlanningContextMode::Extract,
            3_200,
            0,
            &HashMap::new(),
            &similarities,
            &HashMap::new(),
        );

        assert!(plan.project_context.contains("旧伤"));
        assert!(plan.project_context.contains("[节点导航]"));
        assert!(plan.selected_project_chunks > 0);
        assert!(plan.project_context.chars().count() <= 3_200);
        assert!(plan.project_context.chars().count() < project.chars().count());
    }
}
