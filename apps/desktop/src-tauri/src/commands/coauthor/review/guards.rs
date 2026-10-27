use super::{Basis, Issue, IssueKind, reply};
use serde_json::{Value, json};

fn contextual(text: &str) -> bool {
    ["建议", "提案", "假设", "如果", "可以改", "新增", "不等于", "并非", "并不",
        "不意味着", "不代表", "不能推出", "不能推导", "不应", "错误", "误读",
        "并未", "不是", "没有禁止", "不禁止", "不能断言", "不必",
        "认为", "以为", "他说", "她说", "我倾向", "我希望", "我觉得",
        "仅作对照", "只是对照", "对照方案", "？", "?"]
        .iter().any(|word| text.contains(word))
        || text.trim_start().starts_with(['“', '"', '「', '>'])
}

pub(super) fn uncovered_claims(content: &str, bases: &[Basis]) -> Vec<String> {
    if bases.iter().any(|basis| basis.kind == "SOURCE" && basis.text.contains("抄本")) { return Vec::new(); }
    content.split_inclusive(['。', '！', '？', '\n']).map(str::trim)
        .filter(|sentence| !contextual(sentence))
        .filter(|sentence| ["抄本错了前半段", "抄本确定出错"].iter().any(|claim| sentence.contains(claim)))
        .take(4).map(String::from).collect()
}

// Only literal author selection plus unambiguous program-delivered headings.
// Unknown formatting stays whole-message evidence; never infer a plan from a preserved line.
pub(super) fn selected_continuation(request: &str, continuation: &Value) -> Option<Basis> {
    if !["换第二个方案", "选第二个方案", "按第二个方案"].iter().any(|choice| request.contains(choice))
        || reply::required_mode(request, true) != Some("CONTINUATION")
        || continuation["truncated"] != false
        || ["不要第二个", "不选第二个", "不是第二个", "不换第二个"].iter().any(|negative| request.contains(negative))
    { return None; }
    let text = continuation["text"].as_str()?;
    let heading = |line: &str, name: &str| {
        let line = line.trim();
        (line.starts_with(&format!("**{name}")) && line.ends_with("**"))
            || line.starts_with(&format!("## {name}"))
    };
    let first = text.lines().filter(|line| heading(line, "方案一")).count();
    let second = text.lines().filter(|line| heading(line, "方案二")).count();
    if first != 1 || second != 1 { return None; }
    let mut lines = text.split_inclusive('\n');
    lines.find(|line| heading(line, "方案一"))?;
    lines.find(|line| heading(line, "方案二"))?;
    let selected = lines.take_while(|line| {
        let line = line.trim();
        !(line.starts_with("**方案") || line.starts_with("## ") || line.starts_with("两个方案")
            || line == "---")
    }).collect::<String>();
    if selected.trim().chars().count() < 8 { return None; }
    Some(Basis { id:"continuation-selected".into(), kind:"CONTINUATION_SELECTION", text:selected,
        metadata:json!({"method":"LITERAL_SECOND_PLAN_HEADING","messageId":continuation["messageId"],
            "reference":continuation["reference"],"notAuthorDecision":true}) })
}

// Deliberately limited Chinese scope alarms, not a general semantic classifier.
pub(super) fn inspect(content: &str, request: &str, args: &reply::Reply, bases: &[Basis]) -> Vec<Issue> {
    let mut issues = Vec::new();
    if args.is_continuation()
        && !["重写", "回到", "倒叙", "改写"].iter().any(|word| request.contains(word))
    {
        for basis in bases.iter().filter(|basis| basis.kind == "CONTINUATION_SELECTION") {
            for actor in ["她", "他"] {
                let answered = format!("{actor}说进来。");
                let unanswered = format!("{actor}这才发现自己一直没应声");
                if basis.text.matches(&answered).count() == 1 && content.contains(&unanswered) {
                    issues.push(Issue { kind:IssueKind::EvidenceConflict, candidate_quote:unanswered,
                        basis_id:basis.id.clone(), basis_quote:answered,
                        reason:"明确选定的承接段已经应声，候选却断言此前一直没有应声；不能机械改写情节，须定向修订。".into() });
                }
            }
        }
    }
    if !args.allows_local_repair()
        || ["新增", "改规则", "重新设计", "新体系", "修改规则"].iter().any(|word| request.contains(word))
    { return issues; }
    for paragraph in content.split_inclusive(['。', '！', '？', '\n']).map(str::trim).filter(|line| !line.is_empty()) {
        let paragraph = paragraph.split_once("据此").map_or(paragraph, |(claim, _)| claim);
        if paragraph.chars().count() > 1000 || contextual(paragraph) { continue; }
        for basis in bases.iter().filter(|basis| basis.kind == "CURRENT_DECISION"
            && basis.metadata["status"] == "CHOSEN"
            && basis.text.contains("承诺代价") && basis.text.contains("仅作对照"))
        {
            if paragraph.contains("上一层割舍情绪")
                && !["混合", "沿用旧", "重新采用"].iter().any(|word| request.contains(word))
            {
                issues.push(Issue { kind:IssueKind::EvidenceConflict, candidate_quote:paragraph.into(),
                    basis_id:basis.id.clone(), basis_quote:basis.text.clone(),
                    reason:"当前决定仅以旧情绪规则作对照，候选又把它作为本分支上一层的既定前提。".into() });
            }
        }
        for basis in bases.iter().filter(|basis| basis.kind == "SOURCE") {
            if ["不要恢复", "不许恢复", "禁止恢复", "不能恢复", "不得恢复", "不要重新取回",
                "一人一生", "每人一生", "终身一次"].iter().any(|constraint| request.contains(constraint))
            { continue; }
            if bases.iter().any(|other| other.kind == "CURRENT_DECISION" && other.metadata["status"] == "CHOSEN"
                && ["记忆", "情绪", "铜匣"].iter().any(|word| other.text.contains(word)))
            { continue; }
            for clause in basis.text.split_inclusive(['。', '\n', '；']) {
                let clause = clause.trim();
                if !(4..=1000).contains(&clause.chars().count()) { continue; }
                let recovery = (clause.contains("记忆") && ["记忆", "想起来", "信息"].iter().any(|word| paragraph.contains(word)))
                    || (clause.contains("情绪") && paragraph.contains("情绪"));
                let reason = if recovery && clause.contains("不得无条件") && clause.contains("全部")
                    && (paragraph.contains("不能白给、不能一次全还")
                        || (paragraph.contains("任何形式") && paragraph.contains("不能") && (paragraph.contains("想起来")
                            || paragraph.contains("恢复") || paragraph.contains("取回")))
                        || paragraph.contains("不能让信息真的回到"))
                {
                    Some("原文禁止的是带限定条件的恢复，候选把合取或有限禁止扩大为独立/全面禁止。")
                } else if clause.contains("铜匣") && clause.contains("仅能启用一次")
                    && paragraph.contains("铜匣") && paragraph.contains("一生")
                    && (paragraph.contains("一次") || paragraph.contains("一回"))
                    && ["等于", "意味着", "也就是说"].iter().any(|word| paragraph.contains(word))
                    && !bases.iter().any(|other| other.kind == "SOURCE" && other.text.contains("铜匣")
                        && ["每人", "一生", "终身"].iter().any(|word| other.text.contains(word)))
                {
                    Some("原文限定铜匣的启用次数，未给出每人终身取回机会的次数；储存也不等于取回。")
                } else { None };
                if let Some(reason) = reason {
                    if !issues.iter().any(|issue: &Issue| issue.candidate_quote == paragraph) {
                        issues.push(Issue { kind:IssueKind::EvidenceConflict, candidate_quote:paragraph.into(),
                            basis_id:basis.id.clone(), basis_quote:clause.into(), reason:reason.into() });
                    }
                    break;
                }
            }
            if issues.len() >= 4 { return issues; }
        }
    }
    issues
}

pub(super) fn repair(content: &str, args: &reply::Reply, issues: &[Issue]) -> Option<(String, Value)> {
    if !args.allows_local_repair() || issues.len() != 1 { return None; }
    let issue = &issues[0];
    let old = &issue.candidate_quote;
    // Never replace story prose, connected arguments, proposals, quotations, or multiple spans.
    if old.chars().count() > 180 || contextual(old) || content.matches(old).count() != 1
        || !["原规则", "现行规则", "按原规则", "铜匣"].iter().any(|prefix| old.starts_with(prefix))
        || ["因此", "所以", "据此", "由此", "上述", "这个限制", "这一限制", "前提",
            "否则", "只要", "他", "她", "它", "“", "”", "\"", "「", "」"]
            .iter().any(|word| content.contains(word))
        || !content.lines().any(|line| line.trim() == old)
    { return None; }
    let new = format!("已读规则原文：{}", issue.basis_quote);
    // One direct splice, no normalization or mechanical narrative substitutions.
    let repaired = content.replacen(old, &new, 1);
    Some((repaired, json!({"method":"EXACT_SOURCE_PARAGRAPH","before":old,"after":new,
        "basisId":issue.basis_id,"basisQuote":issue.basis_quote,
        "authorTextModified":false,"requiresHardValidation":true,"requiresModelReview":true})))
}
