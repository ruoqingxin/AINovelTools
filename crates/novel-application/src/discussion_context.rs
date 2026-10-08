use std::collections::HashSet;

/// Lightweight lexical retrieval; no embedding request or summary generation.
pub struct DiscussionRelevance {
    query: String,
    terms: HashSet<String>,
}

impl DiscussionRelevance {
    #[must_use]
    pub fn new(query: &str) -> Self {
        let query = query.to_lowercase();
        let mut terms = HashSet::new();
        for word in query.split(|c: char| !c.is_alphanumeric()) {
            if terms.len() >= 128 {
                break;
            }
            if word.is_ascii() {
                if word.len() >= 3 && !["the", "and", "this", "that", "with"].contains(&word) {
                    terms.insert(word.to_owned());
                }
            } else {
                let chars = word.chars().collect::<Vec<_>>();
                for pair in chars.windows(2) {
                    if terms.len() >= 128 {
                        break;
                    }
                    let term = pair.iter().collect::<String>();
                    if ![
                        "一个", "这个", "那个", "可以", "什么", "怎么", "讨论", "构思", "设定",
                        "我们", "一下", "继续",
                    ]
                    .contains(&term.as_str())
                    {
                        terms.insert(term);
                    }
                }
            }
        }
        Self { query, terms }
    }

    #[must_use]
    pub fn names_score(&self, names: &[&str]) -> u16 {
        u16::from(names.iter().any(|name| {
            let name = name.trim().to_lowercase();
            name.chars().count() >= 2 && self.query.contains(&name)
        })) * 7_000
    }

    #[must_use]
    pub fn score(&self, value: &str) -> u16 {
        let value = value.to_lowercase();
        let hits = self
            .terms
            .iter()
            .filter(|term| value.contains(term.as_str()))
            .count();
        u16::try_from(hits.min(10) * 300).unwrap_or(3_000)
    }

    /// Keeps a lead and relevant source excerpts, never a model-written summary.
    #[must_use]
    pub fn excerpt(&self, value: &str, limit: usize) -> String {
        const MARKER: &str = "\n[相关片段，完整原文已保存]\n";
        let value = value.trim();
        let chars = value.chars().collect::<Vec<_>>();
        if chars.len() <= limit {
            return value.to_owned();
        }
        if limit <= MARKER.chars().count() {
            return MARKER.chars().take(limit).collect();
        }
        let available = limit - MARKER.chars().count();
        let lead = available.min(120);
        let window = available.saturating_sub(lead);
        let mut best_start = chars.len().saturating_sub(window);
        let mut best_score = 0;
        for start in (lead..chars.len()).step_by(200) {
            let end = (start + window).min(chars.len());
            let score = self.score(&chars[start..end].iter().collect::<String>());
            if score > best_score {
                best_score = score;
                best_start = start;
            }
        }
        let end = (best_start + window).min(chars.len());
        format!(
            "{}{MARKER}{}",
            chars[..lead].iter().collect::<String>(),
            chars[best_start..end].iter().collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_matching_does_not_reward_repeated_single_characters_or_generic_followups() {
        let query = DiscussionRelevance::new("继续讨论这个设定");
        assert_eq!(query.score("完全无关的军队历史"), 0);
        let query = DiscussionRelevance::new("魂灯的寿元代价");
        assert_eq!(query.score(&"魂".repeat(5_000)), 0);
        assert!(query.score("使用魂灯消耗寿元") >= 600);
        assert_eq!(query.names_score(&["魂灯"]), 7_000);
    }

    #[test]
    fn excerpts_find_relevant_rules_beyond_a_long_intro_and_respect_unicode_limits() {
        let query = DiscussionRelevance::new("寿元代价");
        let content = format!(
            "背景简介{}每次使用扣除寿元，代价不可转嫁。{}",
            "风景".repeat(3_000),
            "尾声".repeat(300)
        );
        let excerpt = query.excerpt(&content, 600);
        assert!(excerpt.starts_with("背景简介"));
        assert!(excerpt.contains("代价不可转嫁"));
        assert!(excerpt.contains("完整原文已保存"));
        assert!(excerpt.chars().count() <= 600);
        assert!(query.excerpt(&content, 5).chars().count() <= 5);
    }
}
