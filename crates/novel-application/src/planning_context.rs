use std::collections::HashSet;

pub const PLANNING_PROMPT_VERSION: &str = "planning-v3";

const CORE_PROJECT_SECTION_IDS: [&str; 6] = [
    "seed-premise",
    "seed-genre-promise",
    "engine-protagonist",
    "engine-antagonism",
    "engine-stakes",
    "engine-ending",
];
const MAX_PROJECT_SECTIONS: usize = 12;
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
    pub selected_reference_blocks: u16,
    pub omitted_reference_blocks: u16,
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
        let project_blocks = parse_project_context(project_context);
        let reference_blocks = parse_reference_context(reference_content);
        let (project_context, selected_project_sections) =
            select_project_context(&project_blocks, query, max_project_chars);
        let reference_limit = if mode == PlanningContextMode::Generate {
            max_reference_chars.min(max_project_chars / 4)
        } else {
            max_reference_chars
        };
        let (rendered_reference, selected_reference_blocks) =
            select_reference_context(&reference_blocks, query, reference_limit);

        PlanningContextPlan {
            project_context,
            reference_context: rendered_reference,
            selected_project_sections,
            selected_reference_blocks,
            omitted_reference_blocks: u16::try_from(
                reference_blocks
                    .len()
                    .saturating_sub(usize::from(selected_reference_blocks)),
            )
            .unwrap_or(u16::MAX),
        }
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
) -> (String, u16) {
    if blocks.is_empty() || max_chars == 0 {
        return (String::new(), 0);
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
    render_project_blocks(blocks, &selected_indexes, query, max_chars)
}

fn select_reference_context(
    blocks: &[PlanningBlock],
    query: &str,
    max_chars: usize,
) -> (String, u16) {
    if blocks.is_empty() || max_chars == 0 {
        return (String::new(), 0);
    }

    let mut ranked = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (index, relevance_score(query, block)))
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

    let selection_limit = MAX_REFERENCE_BLOCKS
        .min((max_chars / MIN_BLOCK_BUDGET).max(1))
        .min(blocks.len());
    let mut selected_indexes = HashSet::new();
    selected_indexes.insert(0);
    for (index, score) in ranked {
        if selected_indexes.len() >= selection_limit {
            break;
        }
        if score > 0 || selected_indexes.is_empty() {
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
    let terms = query_terms(query);
    if terms.is_empty() {
        return 0;
    }
    let heading = normalize_for_match(&block.heading);
    let content = normalize_for_match(&block.content);
    terms.into_iter().fold(0_u32, |score, term| {
        let weight = u32::try_from(term.chars().count().saturating_mul(term.chars().count()))
            .unwrap_or(u32::MAX);
        let content_score = if content.contains(&term) { weight } else { 0 };
        let heading_score = if heading.contains(&term) {
            weight.saturating_mul(2)
        } else {
            0
        };
        score
            .saturating_add(content_score)
            .saturating_add(heading_score)
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
}
