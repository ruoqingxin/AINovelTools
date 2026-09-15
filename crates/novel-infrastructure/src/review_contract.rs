use super::*;
use sha2::{Digest, Sha256};

impl ProjectManager {
    pub fn chapter_contract(
        &mut self,
        chapter_id: Uuid,
    ) -> Result<Option<ChapterContract>, ProjectError> {
        let source_section_id = format!("plan-node:{chapter_id}");
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        let sections = session.database.list_planning_sections()?;
        let Some(section) = sections
            .into_iter()
            .find(|section| section.id == source_section_id)
        else {
            return Ok(None);
        };
        if section.content.trim().is_empty() {
            return Ok(None);
        }
        let confirmed = matches!(
            section.story_state,
            PlanningStoryState::Confirmed | PlanningStoryState::Locked
        );
        let source_revision = format!(
            "sha256:{:x}",
            Sha256::digest(format!("{confirmed}\n{}", section.content).as_bytes())
        );
        if let Some(cached) = session.database.chapter_contract_cache(chapter_id)?
            && cached.source_revision == source_revision
            && cached.confirmed == confirmed
        {
            return Ok(Some(cached));
        }
        let contract = parse_chapter_contract(
            chapter_id,
            &source_section_id,
            source_revision,
            confirmed,
            &section.content,
        );
        session.database.save_chapter_contract_cache(&contract)?;
        Ok(Some(contract))
    }
}

#[must_use]
pub fn parse_chapter_contract(
    chapter_id: Uuid,
    source_section_id: &str,
    source_revision: String,
    confirmed: bool,
    content: &str,
) -> ChapterContract {
    let mut contract = ChapterContract {
        chapter_id,
        source_section_id: source_section_id.to_owned(),
        source_revision,
        confirmed,
        required_events: Vec::new(),
        forbidden_events: Vec::new(),
        allowed_characters: Vec::new(),
        time_windows: Vec::new(),
        stage_boundaries: Vec::new(),
    };
    for raw_line in content.lines().flat_map(|line| line.split('。')) {
        let line = clean_contract_line(raw_line);
        if line.is_empty() {
            continue;
        }
        if let Some((label, value)) = line.split_once(['：', ':']) {
            let label = normalize_contract_label(label);
            let values = split_contract_values(value);
            if label.contains("时间") {
                push_unique(&mut contract.time_windows, values);
                continue;
            }
            if label.contains("禁止") || label.contains("不得") || label.contains("严禁") {
                push_unique(&mut contract.forbidden_events, values);
                continue;
            }
            if label.contains("阶段")
                || label.contains("境界")
                || label.contains("修为")
                || label.contains("突破")
            {
                push_unique(&mut contract.stage_boundaries, values);
                continue;
            }
            if label.contains("允许") || label.contains("出场") || label.contains("人物") {
                push_unique(&mut contract.allowed_characters, values);
                continue;
            }
            if label.contains("必须") || label.contains("要求") || label.contains("事件") {
                push_unique(&mut contract.required_events, values);
                continue;
            }
        }
        if is_stage_boundary(&line) {
            push_unique(&mut contract.stage_boundaries, vec![line]);
            continue;
        }
        if let Some(fragment) = extract_after_marker(
            &line,
            &["不得", "禁止", "严禁", "不能", "不允许"],
            &["发生", "出现", "完成", "安排"],
        ) {
            push_unique(&mut contract.forbidden_events, vec![fragment]);
            continue;
        }
        if let Some(fragment) = extract_after_marker(
            &line,
            &["必须", "需要", "应当", "要求"],
            &["发生", "出现", "完成", "包含", "安排"],
        ) {
            push_unique(&mut contract.required_events, vec![fragment]);
            continue;
        }
        if let Some(fragment) =
            extract_after_marker(&line, &["允许", "仅允许"], &["出场", "出现", "参与"])
        {
            push_unique(
                &mut contract.allowed_characters,
                split_contract_values(&fragment),
            );
            continue;
        }
        if let Some(fragment) =
            extract_after_marker(&line, &["时间窗口", "本章时间", "故事时间"], &[])
        {
            push_unique(&mut contract.time_windows, vec![fragment]);
        }
    }
    contract
}

fn clean_contract_line(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['-', '*', '•'])
        .trim_start_matches(|character: char| character.is_ascii_digit())
        .trim_start_matches(['.', '、', ')', '）'])
        .trim()
        .trim_matches(['“', '”', '"'])
        .trim()
        .to_owned()
}

fn normalize_contract_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn split_contract_values(value: &str) -> Vec<String> {
    value
        .split(['、', ',', '，', '；', ';', '|'])
        .map(|item| {
            item.trim()
                .trim_start_matches(['：', ':'])
                .trim_end_matches(['。', '.'])
                .trim()
                .to_owned()
        })
        .filter(|item| !item.is_empty())
        .collect()
}

fn extract_after_marker(value: &str, markers: &[&str], strip_prefixes: &[&str]) -> Option<String> {
    let (index, marker) = markers
        .iter()
        .filter_map(|marker| value.find(marker).map(|index| (index, *marker)))
        .min_by_key(|(index, _)| *index)?;
    let mut fragment = value[index + marker.len()..]
        .trim()
        .trim_start_matches(['：', ':', '，', ','])
        .to_owned();
    for prefix in strip_prefixes {
        if let Some(stripped) = fragment.strip_prefix(prefix) {
            fragment = stripped.trim().to_owned();
            break;
        }
    }
    let fragment = fragment.trim().trim_end_matches(['。', '.']).trim();
    (!fragment.is_empty()).then(|| fragment.to_owned())
}

fn is_stage_boundary(value: &str) -> bool {
    ["阶段", "境界", "修为", "突破"]
        .iter()
        .any(|marker| value.contains(marker))
        && ["不得", "禁止", "严禁", "不能", "不允许"]
            .iter()
            .any(|marker| value.contains(marker))
}

fn push_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        let value = value.trim();
        if value.is_empty() || target.iter().any(|existing| existing == value) {
            continue;
        }
        target.push(value.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_confirmed_contract_fields_from_free_text() {
        let chapter_id = Uuid::new_v4();
        let contract = parse_chapter_contract(
            chapter_id,
            "plan-node:test",
            "sha256:test".to_owned(),
            true,
            "必须事件：守门冲突、城门对峙\n\
             禁止事件：揭露师兄真实叛变原因\n\
             允许人物：林澈、苏晚\n\
             时间窗口：当夜\n\
             阶段边界：不得突破筑基",
        );

        assert_eq!(
            contract.required_events,
            vec!["守门冲突".to_owned(), "城门对峙".to_owned()]
        );
        assert_eq!(
            contract.forbidden_events,
            vec!["揭露师兄真实叛变原因".to_owned()]
        );
        assert_eq!(
            contract.allowed_characters,
            vec!["林澈".to_owned(), "苏晚".to_owned()]
        );
        assert_eq!(contract.time_windows, vec!["当夜".to_owned()]);
        assert_eq!(contract.stage_boundaries, vec!["不得突破筑基".to_owned()]);
    }

    #[test]
    fn caches_the_contract_until_the_confirmed_execution_card_changes() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-chapter-contract-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "章节合同测试").expect("create");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第一章".to_owned())
            .expect("chapter");
        let section_id = format!("plan-node:{}", chapter.id);
        manager
            .save_planning_section(PlanningSection {
                id: section_id.clone(),
                content: "必须事件：守门冲突".to_owned(),
                pending_content: String::new(),
                story_state: PlanningStoryState::Confirmed,
                rationale: String::new(),
                consequence: String::new(),
                references: Vec::new(),
                updated_at: String::new(),
            })
            .expect("save initial contract");

        let initial = manager
            .chapter_contract(chapter.id)
            .expect("initial contract")
            .expect("contract");
        let cached = manager
            .chapter_contract(chapter.id)
            .expect("cached contract")
            .expect("contract");
        assert_eq!(initial.source_revision, cached.source_revision);
        assert_eq!(initial.required_events, vec!["守门冲突".to_owned()]);

        manager
            .save_planning_section(PlanningSection {
                id: section_id,
                content: "必须事件：城门对峙".to_owned(),
                pending_content: String::new(),
                story_state: PlanningStoryState::Confirmed,
                rationale: String::new(),
                consequence: String::new(),
                references: Vec::new(),
                updated_at: String::new(),
            })
            .expect("update contract");
        let updated = manager
            .chapter_contract(chapter.id)
            .expect("updated contract")
            .expect("contract");
        assert_ne!(initial.source_revision, updated.source_revision);
        assert_eq!(updated.required_events, vec!["城门对峙".to_owned()]);
    }
}
