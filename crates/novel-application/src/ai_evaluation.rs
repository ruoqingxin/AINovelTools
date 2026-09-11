use serde::{Deserialize, Serialize};

const BASELINE_SAMPLES: &str = include_str!("../fixtures/ai-eval-baseline.jsonl");

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiEvaluationTask {
    WorkDesign,
    Outline,
    VolumePlanning,
    ChapterSplit,
    Writing,
    KnowledgeExtraction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEvaluationInput {
    pub instruction: String,
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEvaluationSample {
    pub id: String,
    pub task_key: AiEvaluationTask,
    pub purpose: String,
    pub input: AiEvaluationInput,
    pub expected_all: Vec<String>,
    pub forbidden_any: Vec<String>,
    pub min_characters: usize,
    pub max_characters: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEvaluationScore {
    pub sample_id: String,
    pub passed: bool,
    pub required_hits: usize,
    pub required_total: usize,
    pub forbidden_hits: usize,
    pub character_count: usize,
    pub length_ok: bool,
}

/// Loads the checked-in, desensitized AI evaluation baseline.
///
/// # Errors
///
/// Returns a JSON error when a JSONL row does not match [`AiEvaluationSample`].
pub fn load_ai_evaluation_samples() -> Result<Vec<AiEvaluationSample>, serde_json::Error> {
    BASELINE_SAMPLES
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect()
}

#[must_use]
pub fn score_ai_evaluation_sample(
    sample: &AiEvaluationSample,
    candidate: &str,
) -> AiEvaluationScore {
    let normalized = candidate.to_lowercase();
    let required_hits = sample
        .expected_all
        .iter()
        .filter(|expected| normalized.contains(&expected.to_lowercase()))
        .count();
    let forbidden_hits = sample
        .forbidden_any
        .iter()
        .filter(|forbidden| normalized.contains(&forbidden.to_lowercase()))
        .count();
    let character_count = candidate.chars().count();
    let length_ok =
        character_count >= sample.min_characters && character_count <= sample.max_characters;
    AiEvaluationScore {
        sample_id: sample.id.clone(),
        passed: required_hits == sample.expected_all.len() && forbidden_hits == 0 && length_ok,
        required_hits,
        required_total: sample.expected_all.len(),
        forbidden_hits,
        character_count,
        length_ok,
    }
}

#[cfg(test)]
mod tests {
    use super::{AiEvaluationTask, load_ai_evaluation_samples, score_ai_evaluation_sample};

    #[test]
    fn baseline_samples_cover_all_six_tasks_and_are_unique() {
        let samples = load_ai_evaluation_samples().expect("valid baseline jsonl");
        assert_eq!(samples.len(), 6);
        assert_eq!(
            samples
                .iter()
                .map(|sample| &sample.id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            6
        );
        assert!(
            samples
                .iter()
                .any(|sample| sample.task_key == AiEvaluationTask::WorkDesign)
        );
        assert!(
            samples
                .iter()
                .any(|sample| sample.task_key == AiEvaluationTask::Outline)
        );
        assert!(
            samples
                .iter()
                .any(|sample| sample.task_key == AiEvaluationTask::VolumePlanning)
        );
        assert!(
            samples
                .iter()
                .any(|sample| sample.task_key == AiEvaluationTask::ChapterSplit)
        );
        assert!(
            samples
                .iter()
                .any(|sample| sample.task_key == AiEvaluationTask::Writing)
        );
        assert!(
            samples
                .iter()
                .any(|sample| sample.task_key == AiEvaluationTask::KnowledgeExtraction)
        );
    }

    #[test]
    fn baseline_scores_distinguish_contract_passing_and_failing_outputs() {
        for sample in load_ai_evaluation_samples().expect("valid baseline jsonl") {
            let passing = format!(
                "{}{}",
                sample.expected_all.join("；"),
                "。补充说明保持候选可审核。".repeat(6)
            );
            assert!(
                score_ai_evaluation_sample(&sample, &passing).passed,
                "expected passing candidate for {}",
                sample.id
            );

            let failing = sample.forbidden_any[0].repeat(8);
            assert!(
                !score_ai_evaluation_sample(&sample, &failing).passed,
                "expected forbidden candidate to fail for {}",
                sample.id
            );
        }
    }
}
