use super::*;

pub(super) fn read_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelProfile> {
    let secret_ref: Option<String> = row.get(14)?;
    Ok(ModelProfile {
        id: parse_uuid(row.get::<_, String>(0)?, 0)?,
        name: row.get(1)?,
        provider: parse_provider(&row.get::<_, String>(2)?),
        capability: parse_capability(&row.get::<_, String>(3)?),
        base_url: row.get(4)?,
        model_id: row.get(5)?,
        context_window: row.get(6)?,
        max_output_tokens: row.get(7)?,
        privacy_level: parse_privacy(&row.get::<_, String>(8)?),
        timeout_seconds: row.get(9)?,
        retry_limit: row.get(10)?,
        input_price_micros_per_million: u64::try_from(row.get::<_, i64>(11)?.max(0)).unwrap_or(0),
        output_price_micros_per_million: u64::try_from(row.get::<_, i64>(12)?.max(0)).unwrap_or(0),
        price_currency: row.get(13)?,
        has_secret: secret_ref.is_some(),
        secret_ref,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub(super) struct UsageRunRow {
    pub(super) task_key: String,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) input_price: u64,
    pub(super) output_price: u64,
    pub(super) currency: String,
    pub(super) actual_cost_micros: Option<u64>,
    pub(super) date: Option<String>,
}

#[derive(Default)]
pub(super) struct UsageAggregate {
    pub(super) run_count: u64,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) estimated_cost_micros: Option<u64>,
}

impl UsageAggregate {
    pub(super) fn add(&mut self, row: &UsageRunRow) {
        self.run_count = self.run_count.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(row.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(row.output_tokens);
        if let Some(cost) = row.actual_cost_micros.or_else(|| {
            estimate_run_cost_micros(
                u32::try_from(row.input_tokens).unwrap_or(u32::MAX),
                u32::try_from(row.output_tokens).unwrap_or(u32::MAX),
                row.input_price,
                row.output_price,
            )
        }) {
            self.estimated_cost_micros =
                Some(self.estimated_cost_micros.unwrap_or(0).saturating_add(cost));
        }
    }

    pub(super) fn into_currency(self, currency: String) -> AiUsageCurrencySummary {
        AiUsageCurrencySummary {
            currency,
            run_count: u32::try_from(self.run_count).unwrap_or(u32::MAX),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            estimated_cost_micros: self.estimated_cost_micros,
        }
    }
}

#[derive(Default)]
pub(super) struct QualityAggregate {
    pub(super) proposals: u32,
    pub(super) accepted: u32,
    pub(super) rated: u32,
    pub(super) helpful: u32,
    pub(super) not_helpful: u32,
    pub(super) valid: u32,
    pub(super) warnings: u32,
    pub(super) needs_input: u32,
    pub(super) invalid: u32,
}

pub(super) fn estimate_run_cost_micros(
    input_tokens: u32,
    output_tokens: u32,
    input_price_micros_per_million: u64,
    output_price_micros_per_million: u64,
) -> Option<u64> {
    if input_price_micros_per_million == 0 && output_price_micros_per_million == 0 {
        return None;
    }
    let cost = u128::from(input_tokens) * u128::from(input_price_micros_per_million)
        + u128::from(output_tokens) * u128::from(output_price_micros_per_million);
    u64::try_from(cost / 1_000_000).ok()
}

pub(super) fn read_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProposal> {
    let review_purpose = match row.get::<_, String>(4)?.as_str() {
        "MANUSCRIPT" => ReviewPurpose::Manuscript,
        _ => ReviewPurpose::Admission,
    };
    Ok(AiProposal {
        id: parse_uuid(row.get::<_, String>(0)?, 0)?,
        task_id: parse_uuid(row.get::<_, String>(1)?, 1)?,
        chapter_id: parse_uuid(row.get::<_, String>(2)?, 2)?,
        action: parse_action(&row.get::<_, String>(3)?),
        review_purpose,
        target_revision_id: row
            .get::<_, Option<String>>(5)?
            .map(|value| parse_uuid(value, 5))
            .transpose()?,
        context_version: row.get(6)?,
        prompt_version: row.get(7)?,
        output_text: row.get(8)?,
        accepted_text: row.get(9)?,
        status: parse_proposal_status(&row.get::<_, String>(10)?),
        created_at: row.get(11)?,
        decided_at: row.get(12)?,
    })
}

pub(super) fn read_proposal_feedback(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<AiProposalFeedback> {
    Ok(AiProposalFeedback {
        proposal_id: parse_uuid(row.get::<_, String>(0)?, 0)?,
        rating: parse_feedback_rating(&row.get::<_, String>(1)?),
        note: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

pub(super) fn parse_uuid(value: String, column: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
pub(super) fn provider_str(value: ModelProvider) -> &'static str {
    match value {
        ModelProvider::SiliconFlow => "SILICON_FLOW",
        ModelProvider::DeepSeek => "DEEPSEEK",
        ModelProvider::OpenAi => "OPEN_AI",
        ModelProvider::OpenAiCompatible => "OPEN_AI_COMPATIBLE",
    }
}
pub(super) fn parse_provider(value: &str) -> ModelProvider {
    match value {
        "SILICON_FLOW" => ModelProvider::SiliconFlow,
        "DEEPSEEK" => ModelProvider::DeepSeek,
        "OPEN_AI" => ModelProvider::OpenAi,
        _ => ModelProvider::OpenAiCompatible,
    }
}
pub(super) fn capability_str(value: ModelCapability) -> &'static str {
    match value {
        ModelCapability::Chat => "CHAT",
        ModelCapability::Embedding => "EMBEDDING",
    }
}
pub(super) fn parse_capability(value: &str) -> ModelCapability {
    if value == "EMBEDDING" {
        ModelCapability::Embedding
    } else {
        ModelCapability::Chat
    }
}
pub(super) fn privacy_str(value: PrivacyLevel) -> &'static str {
    match value {
        PrivacyLevel::LocalOnly => "LOCAL_ONLY",
        PrivacyLevel::AllowCloud => "ALLOW_CLOUD",
    }
}
pub(super) fn parse_privacy(value: &str) -> PrivacyLevel {
    if value == "ALLOW_CLOUD" {
        PrivacyLevel::AllowCloud
    } else {
        PrivacyLevel::LocalOnly
    }
}
pub(super) fn feedback_rating_str(value: AiProposalFeedbackRating) -> &'static str {
    match value {
        AiProposalFeedbackRating::Helpful => "HELPFUL",
        AiProposalFeedbackRating::NotHelpful => "NOT_HELPFUL",
    }
}
pub(super) fn parse_feedback_rating(value: &str) -> AiProposalFeedbackRating {
    match value {
        "HELPFUL" => AiProposalFeedbackRating::Helpful,
        _ => AiProposalFeedbackRating::NotHelpful,
    }
}
pub(super) fn validate_ai_task_preference(
    preference: &AiTaskPreference,
    profiles: &[ModelProfile],
) -> Result<(), AiError> {
    if preference
        .temperature
        .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        || preference.max_output_tokens == Some(0)
        || preference
            .prompt
            .context
            .input_token_budget
            .is_some_and(|value| !(256..=1_000_000).contains(&value))
        || preference
            .prompt
            .system_prompt
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
        || preference
            .prompt
            .instruction_template
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
    {
        return Err(AiContractError::InvalidGenerationOptions.into());
    }
    if let Some(profile_id) = preference.profile_id {
        let profile = profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or(AiError::MissingProfile(profile_id))?;
        if profile.capability != ModelCapability::Chat {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
    }
    if let Some(fallback_profile_id) = preference.fallback_profile_id {
        if preference.profile_id == Some(fallback_profile_id) {
            return Err(AiContractError::InvalidGenerationOptions.into());
        }
        let fallback = profiles
            .iter()
            .find(|profile| profile.id == fallback_profile_id)
            .ok_or(AiError::MissingProfile(fallback_profile_id))?;
        if fallback.capability != ModelCapability::Chat {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
    }
    Ok(())
}
pub(super) fn parse_consistency_report(output_text: &str) -> AiConsistencyReport {
    let trimmed = output_text.trim();
    if let Ok(report) = serde_json::from_str::<AiConsistencyReport>(trimmed) {
        return report;
    }
    if trimmed.contains("[上下文不足]") {
        return AiConsistencyReport {
            verdict: AiConsistencyVerdict::NeedsInput,
            summary: first_report_line(trimmed)
                .unwrap_or_else(|| "正式设定不足，无法判断生成准入。".to_owned()),
            findings: Vec::new(),
            parse_warnings: Vec::new(),
        };
    }

    let mut summary = None;
    let mut findings = Vec::new();
    let mut parse_warnings = Vec::new();
    for raw_line in trimmed.lines() {
        let line = raw_line.trim().trim_start_matches(['-', '*']).trim();
        if line.is_empty() {
            continue;
        }
        let Some((severity, body)) = parse_consistency_finding_line(line) else {
            if summary.is_none() {
                summary = Some(
                    line.trim_start_matches("审核结论：")
                        .trim_start_matches("审核结论:")
                        .to_owned(),
                );
            }
            continue;
        };
        let parts = split_consistency_finding(body);
        if parts.is_empty() {
            parse_warnings.push(format!("忽略缺少问题内容的审核行：{line}"));
            continue;
        }
        if parts.len() < 3 {
            parse_warnings.push(format!("问题缺少“依据｜建议”字段：{}", parts[0]));
        }
        findings.push(AiConsistencyFinding {
            severity,
            problem: parts.first().cloned().unwrap_or_default(),
            evidence: parts.get(1).cloned().unwrap_or_default(),
            suggestion: parts.get(2..).unwrap_or_default().join("｜"),
        });
    }

    let verdict = if findings
        .iter()
        .any(|finding| finding.severity == AiConsistencySeverity::Blocker)
    {
        AiConsistencyVerdict::Blocked
    } else if !findings.is_empty() {
        AiConsistencyVerdict::Review
    } else if summary
        .as_deref()
        .is_some_and(|value| value.contains("未发现冲突") || value.contains("通过"))
    {
        AiConsistencyVerdict::Pass
    } else {
        AiConsistencyVerdict::Unparsed
    };
    AiConsistencyReport {
        verdict,
        summary: summary.unwrap_or_else(|| "审核报告未提供明确结论。".to_owned()),
        findings,
        parse_warnings,
    }
}

pub(super) fn first_report_line(output_text: &str) -> Option<String> {
    output_text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn parse_consistency_finding_line(line: &str) -> Option<(AiConsistencySeverity, &str)> {
    let rest = line.strip_prefix('[')?;
    let marker_end = rest.find(']')?;
    let severity = match rest[..marker_end].trim() {
        "阻断" | "阻断级" | "BLOCKER" | "blocker" => AiConsistencySeverity::Blocker,
        "严重" | "重要" | "MAJOR" | "major" => AiConsistencySeverity::Major,
        "一般" | "MINOR" | "minor" => AiConsistencySeverity::Minor,
        "提示" | "建议" | "INFO" | "info" => AiConsistencySeverity::Info,
        _ => return None,
    };
    Some((
        severity,
        rest[marker_end + 1..]
            .trim()
            .trim_start_matches([':', '：'])
            .trim(),
    ))
}

pub(super) fn split_consistency_finding(body: &str) -> Vec<String> {
    let separator = if body.contains('｜') {
        '｜'
    } else if body.contains('|') {
        '|'
    } else {
        return body
            .trim()
            .is_empty()
            .then(Vec::new)
            .unwrap_or_else(|| vec![body.trim().to_owned()]);
    };
    body.split(separator)
        .map(str::trim)
        .map(ToOwned::to_owned)
        .collect()
}

pub(super) fn validate_ai_output(action: AiAction, output_text: &str) -> AiOutputValidation {
    let trimmed = output_text.trim();
    let needs_input = trimmed.contains("[上下文不足]");
    let character_count = trimmed.chars().count();
    let paragraph_count = trimmed
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let mut messages = Vec::new();
    if needs_input {
        messages.push("模型没有生成可用结果，要求先补齐正式设定。".to_owned());
    } else if trimmed.is_empty() {
        messages.push("输出为空，不能形成候选。".to_owned());
    } else {
        if character_count < 20 {
            messages.push("输出明显过短，建议检查是否被模型提前截断。".to_owned());
        }
        if paragraph_count == 0 {
            messages.push("输出没有可识别的段落结构。".to_owned());
        }
        if trimmed.contains("```") {
            messages.push("正文候选包含 Markdown 代码围栏，应用前建议清理。".to_owned());
        }
        if [
            "好的",
            "当然",
            "以下是",
            "我会",
            "下面是",
            "作为AI",
            "作为 AI",
        ]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
        {
            messages.push("输出开头包含对话式说明，可能混入了模型元话语。".to_owned());
        }
        if trimmed.ends_with("...")
            || trimmed.ends_with('…')
            || trimmed.ends_with("（未完")
            || trimmed.ends_with("(未完")
        {
            messages.push("输出结尾像未完成内容，建议续写或重新生成。".to_owned());
        }
        if trimmed.starts_with('{') && trimmed.ends_with('}') && action != AiAction::Summarize {
            messages.push("正文候选看起来是 JSON 结构，与应用合同不一致。".to_owned());
        }
    }
    AiOutputValidation {
        status: if needs_input {
            "NEEDS_INPUT".to_owned()
        } else if trimmed.is_empty() {
            "INVALID".to_owned()
        } else if messages.is_empty() {
            "VALID".to_owned()
        } else {
            "WARNING".to_owned()
        },
        messages,
        character_count,
        paragraph_count,
        estimated_output_tokens: u32::try_from(character_count.div_ceil(4)).unwrap_or(u32::MAX),
    }
}
pub(super) fn action_str(value: AiAction) -> &'static str {
    match value {
        AiAction::Draft => "DRAFT",
        AiAction::Continue => "CONTINUE",
        AiAction::Rewrite => "REWRITE",
        AiAction::Polish => "POLISH",
        AiAction::Summarize => "SUMMARIZE",
        AiAction::ConsistencyCheck => "CONSISTENCY_CHECK",
    }
}
pub(super) fn parse_action(value: &str) -> AiAction {
    match value {
        "DRAFT" => AiAction::Draft,
        "REWRITE" => AiAction::Rewrite,
        "POLISH" => AiAction::Polish,
        "SUMMARIZE" => AiAction::Summarize,
        "CONSISTENCY_CHECK" => AiAction::ConsistencyCheck,
        _ => AiAction::Continue,
    }
}
pub(super) fn task_status_str(value: AiTaskStatus) -> &'static str {
    match value {
        AiTaskStatus::Running => "RUNNING",
        AiTaskStatus::Completed => "COMPLETED",
        AiTaskStatus::Failed => "FAILED",
        AiTaskStatus::Cancelled => "CANCELLED",
    }
}
pub(super) fn proposal_status_str(value: AiProposalStatus) -> &'static str {
    match value {
        AiProposalStatus::Pending => "PENDING",
        AiProposalStatus::Accepted => "ACCEPTED",
        AiProposalStatus::PartiallyAccepted => "PARTIALLY_ACCEPTED",
        AiProposalStatus::Rejected => "REJECTED",
    }
}
pub(super) fn parse_proposal_status(value: &str) -> AiProposalStatus {
    match value {
        "ACCEPTED" => AiProposalStatus::Accepted,
        "PARTIALLY_ACCEPTED" => AiProposalStatus::PartiallyAccepted,
        "REJECTED" => AiProposalStatus::Rejected,
        _ => AiProposalStatus::Pending,
    }
}
