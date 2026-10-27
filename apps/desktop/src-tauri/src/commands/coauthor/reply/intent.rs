// Deliberately narrow: only direct, unquoted writing commands establish a program
// requirement. Questions, examples and hypothetical instructions remain discussion.
pub(in super::super) fn requested_review(request: &str) -> bool {
    let verbs = ["复核你的回答", "复核本次回答", "检查回复的一致性", "先审核再展示", "严格复核"];
    let mut requested = false;
    for clause in command_clauses(request) {
        if cancelled_command(&clause, &verbs) { requested = false; }
        requested |= direct_command(&clause, &verbs);
    }
    requested
}

pub(in super::super) fn required_mode(request: &str, has_previous: bool) -> Option<&'static str> {
    let clauses = command_clauses(request);
    let reprint_verbs = ["重贴整合全文", "重贴全文", "整合全文", "重发全文", "完整重贴", "全文重贴"];
    let continuation_verbs = ["继续写", "接着写", "往下写", "续写"];
    let mut reprint = false;
    let mut continuation = false;
    for clause in clauses {
        if cancelled_command(&clause, &reprint_verbs) { reprint = false; }
        if cancelled_command(&clause, &continuation_verbs) || cancelled_command(&clause, &["写正文"]) {
            continuation = false;
        }
        reprint |= direct_command(&clause, &reprint_verbs);
        continuation |= direct_command(&clause, &continuation_verbs);
    }
    if reprint {
        return Some("REPRINT");
    }
    if has_previous && continuation {
        return Some("CONTINUATION");
    }
    None
}

fn cancelled_command(clause: &str, verbs: &[&str]) -> bool {
    let clause = clause.trim().trim_start_matches("请").trim_start_matches("先");
    ["不要", "不必", "无需", "别"].iter().any(|negative| {
        clause.strip_prefix(negative).is_some_and(|rest| verbs.iter().any(|verb| rest.starts_with(verb)))
    })
}

fn direct_command(clause: &str, verbs: &[&str]) -> bool {
    if clause.contains(['?', '？']) {
        return false;
    }
    verbs.iter().any(|verb| {
        let Some((prefix, suffix)) = clause.split_once(verb) else { return false; };
        let prefix = prefix.trim();
        let suffix = suffix.trim();
        let excluded = ["不", "别", "没", "如果", "假如", "讨论", "解释", "如何", "怎么",
            "是否", "能否", "应该", "建议", "示例", "例子", "引用", "台词", "说", "问",
            "翻译", "评价", "比较", "分析", "总结", "概述", "说明", "举例"];
        let direct_prefix = prefix.is_empty() || ["请", "再", "先", "现在", "直接", "帮我",
            "给我", "麻烦", "就", "只", "然后", "换", "按", "沿", "从", "接", "以", "把", "将"]
            .iter().any(|start| prefix.starts_with(start));
        direct_prefix && !excluded.iter().any(|word| prefix.contains(word))
            && !["法", "方法", "的", "吗", "呢", "会", "是否", "应该", "如何", "怎么",
                "问题", "时", "建议", "方案", "作", "不是", "并非", "只是", "仅为", "这几个字"]
                .iter().any(|word| suffix.starts_with(word))
    })
}

fn command_clauses(request: &str) -> Vec<String> {
    let mut clauses = Vec::new();
    let mut clause = String::new();
    let mut fenced = false;
    let mut closing = Vec::new();
    for line in request.lines() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || line.starts_with('>') {
            continue;
        }
        for ch in line.chars() {
            if let Some(expected) = closing.last() {
                if ch == *expected {
                    closing.pop();
                }
                continue;
            }
            let close = match ch {
                '“' => Some('”'), '‘' => Some('’'), '「' => Some('」'), '『' => Some('』'),
                '"' | '\'' | '`' => Some(ch),
                _ => None,
            };
            if let Some(close) = close {
                closing.push(close);
                clause.push(' ');
            } else if ['，', ',', '。', '.', '！', '!', '；', ';'].contains(&ch) {
                clauses.push(std::mem::take(&mut clause));
            } else {
                clause.push(ch);
            }
        }
        if closing.is_empty() {
            clauses.push(std::mem::take(&mut clause));
        }
    }
    clauses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_review_requires_an_explicit_unquoted_current_command() {
        for request in ["请复核你的回答。", "继续写，先审核再展示。", "请严格复核。"] {
            assert!(requested_review(request), "{request}");
        }
        for request in ["先核对原文再讨论。", "继续写。", "不要严格复核。",
            "如果严格复核会怎样？", "请解释“先审核再展示”的意思。",
            "> 严格复核\n仅讨论。", "```text\n严格复核\n```",
            "严格复核，请不要严格复核。"] {
            assert!(!requested_review(request), "{request}");
        }
        assert!(requested_review("不必严格复核。现在严格复核。"));
    }

    #[test]
    fn direct_commands_are_not_inferred_from_discussion_negation_quotes_or_questions() {
        for request in [
            "换第二个方案继续写，但保留她将铜匣推回桌角这句，不重列路线。",
            "继续写，只给新情节。", "请沿第二案往下写。", "从门打开后接着写。",
        ] {
            assert_eq!(required_mode(request, true), Some("CONTINUATION"), "{request}");
            assert_eq!(required_mode(request, false), None, "Initial drafting has no AI anchor.");
        }
        for request in [
            "不要继续写。", "先别续写。", "讨论如何续写。", "请解释继续写的方法。",
            "如果继续写，会怎样？", "能继续写吗？", "请继续写的方法分析。", "继续写建议有哪些？",
            "角色说：“继续写。”", "请解释“继续写”的意思。",
            "> 继续写。\n只解释这句话。",
            "```text\n继续写\n```\n解释示例。", "不必重贴全文。", "讨论整合全文的方法。",
            "“旧文跨行\n继续写。”\n只讨论。",
            "先继续写，先不要写正文。", "先重贴全文，请不要重贴全文。",
            "请翻译续写一词。", "续写不是本轮任务。", "重贴全文只是举例。",
            "请把继续写这几个字翻译成英文。",
        ] {
            assert_eq!(required_mode(request, true), None, "{request}");
        }
        assert_eq!(required_mode("请继续写，然后整合全文。", true), Some("REPRINT"));
        assert_eq!(required_mode("请重贴整合全文。", false), Some("REPRINT"));
        assert_eq!(required_mode("不要继续写。现在继续写。", true), Some("CONTINUATION"));
    }
}
