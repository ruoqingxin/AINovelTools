//! Application use cases and infrastructure ports.

use novel_domain::{AiAction, AiContractError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const PROMPT_VERSION: &str = "r3-writing-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssembleContextInput {
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub action: AiAction,
    pub chapter_title: String,
    pub chapter_plan: String,
    pub document_json: String,
    pub selection: Option<String>,
    pub instruction: Option<String>,
    pub input_token_budget: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackage {
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub action: AiAction,
    pub context_version: String,
    pub prompt_version: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub estimated_input_tokens: u32,
    pub truncated: bool,
    pub entity_source_status: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContextError {
    #[error(transparent)]
    Contract(#[from] AiContractError),
    #[error("document JSON is invalid: {0}")]
    InvalidDocument(String),
    #[error("input token budget must be at least 256")]
    BudgetTooSmall,
}

pub struct ContextAssembler;

impl ContextAssembler {
    /// Builds the smallest sufficient, versioned prompt package for an AI task.
    ///
    /// # Errors
    ///
    /// Returns [`ContextError`] when the document is invalid, the input budget
    /// is too small, or an action that requires a selection has no selection.
    pub fn assemble(input: &AssembleContextInput) -> Result<ContextPackage, ContextError> {
        if input.input_token_budget < 256 {
            return Err(ContextError::BudgetTooSmall);
        }
        let selection = input.selection.as_deref().unwrap_or("").trim();
        if input.action.requires_selection() && selection.is_empty() {
            return Err(AiContractError::SelectionRequired.into());
        }
        let document = document_text(&input.document_json)?;
        let action_contract = match input.action {
            AiAction::Continue => "从当前正文结尾继续写作。只输出新增正文，不复述已有内容。",
            AiAction::Rewrite => "重写选区。只输出替换选区的新正文。",
            AiAction::Polish => "润色选区，保持事实、视角和情节不变。只输出润色后的正文。",
            AiAction::Summarize => "总结当前章节。只输出简洁、可供后续上下文使用的章节摘要。",
        };
        let system_prompt = "你是长篇小说创作服务。严格服从任务合同；不得把推测写成既定事实；信息不足时保持保守；输出中不要解释过程。".to_owned();
        let mut sections = vec![
            format!(
                "[任务合同]\n动作：{action_contract}\n章节：{}",
                input.chapter_title.trim()
            ),
            format!(
                "[用户补充要求]\n{}",
                input.instruction.as_deref().unwrap_or("无").trim()
            ),
            format!("[章节规划 P2]\n{}", input.chapter_plan.trim()),
            format!("[选区 P0]\n{}", selection),
            format!("[当前正文 P4]\n{document}"),
            "[相关实体]\nR4 尚未启用实体库，本次没有实体来源。不得自行声称已读取项目设定库。"
                .to_owned(),
        ];
        let character_budget = usize::try_from(input.input_token_budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(4);
        let mut truncated = false;
        let fixed_len = system_prompt.chars().count();
        let mut remaining = character_budget.saturating_sub(fixed_len);
        for section in &mut sections {
            let length = section.chars().count();
            if length > remaining {
                *section = section.chars().take(remaining).collect();
                section.push_str("\n[已按 TokenBudget 截断]");
                truncated = true;
                remaining = 0;
            } else {
                remaining -= length;
            }
        }
        let user_prompt = sections.join("\n\n");
        let canonical = serde_json::json!({
            "chapterId": input.chapter_id,
            "targetRevisionId": input.target_revision_id,
            "action": input.action,
            "promptVersion": PROMPT_VERSION,
            "system": system_prompt,
            "user": user_prompt,
        });
        let context_version = format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()));
        let estimated_input_tokens = u32::try_from(
            (system_prompt.chars().count() + user_prompt.chars().count()).div_ceil(4),
        )
        .unwrap_or(u32::MAX);
        Ok(ContextPackage {
            chapter_id: input.chapter_id,
            target_revision_id: input.target_revision_id,
            action: input.action,
            context_version,
            prompt_version: PROMPT_VERSION.to_owned(),
            system_prompt,
            user_prompt,
            estimated_input_tokens,
            truncated,
            entity_source_status: "R4_NOT_AVAILABLE".to_owned(),
        })
    }
}

fn document_text(document_json: &str) -> Result<String, ContextError> {
    let value: serde_json::Value = serde_json::from_str(document_json)
        .map_err(|error| ContextError::InvalidDocument(error.to_string()))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
        return Err(ContextError::InvalidDocument(
            "root type must be doc".to_owned(),
        ));
    }
    let mut output = Vec::new();
    collect_document_text(&value, &mut output);
    Ok(output.concat().trim().to_owned())
}

fn collect_document_text(value: &serde_json::Value, output: &mut Vec<String>) {
    if value.get("type").and_then(serde_json::Value::as_str) == Some("text")
        && let Some(text) = value.get("text").and_then(serde_json::Value::as_str)
    {
        output.push(text.to_owned());
    }
    if let Some(children) = value.get("content").and_then(serde_json::Value::as_array) {
        for child in children {
            collect_document_text(child, output);
        }
        if value.get("type").and_then(serde_json::Value::as_str) == Some("paragraph") {
            output.push("\n".to_owned());
        }
    }
}

/// Returns the ordered layers currently linked into the application core.
#[must_use]
pub fn linked_layers() -> [&'static str; 2] {
    [novel_domain::layer_name(), "application"]
}

#[cfg(test)]
mod tests {
    #[test]
    fn application_depends_on_domain() {
        assert_eq!(super::linked_layers(), ["domain", "application"]);
    }

    #[test]
    fn context_versions_are_stable_and_selection_is_enforced() {
        let input = super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: None,
            action: novel_domain::AiAction::Continue,
            chapter_title: "第一章".into(),
            chapter_plan: "主角抵达车站".into(),
            document_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"雨停了。"}]}]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 2048,
        };
        let first = super::ContextAssembler::assemble(&input).expect("assemble");
        let second = super::ContextAssembler::assemble(&input).expect("assemble again");
        assert_eq!(first.context_version, second.context_version);
        let mut rewrite = input;
        rewrite.action = novel_domain::AiAction::Rewrite;
        assert!(matches!(
            super::ContextAssembler::assemble(&rewrite),
            Err(super::ContextError::Contract(
                novel_domain::AiContractError::SelectionRequired
            ))
        ));
    }
}
