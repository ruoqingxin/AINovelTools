use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSourceFollowup {
    pub seed_key: String,
    pub seed_revision: String,
    pub query: String,
    pub shared_terms: Vec<String>,
    pub candidate_limit: usize,
    pub result: CoauthorSearchPage,
}

impl ProjectManager {
    pub fn coauthor_source_followup(
        &self,
        scope: &CoauthorScope,
        query: &str,
        primary: &CoauthorSearchPage,
    ) -> Result<Option<CoauthorSourceFollowup>, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if !matches!(primary.execution, CoauthorSearchExecution::ReturnedPage)
            || primary.hits.len() != 1
            || primary.has_more
            || primary.pending_index_updates != 0
        {
            return Ok(None);
        }
        let seed = &primary.hits[0];
        if seed.kind != "ENTITY" {
            return Ok(None);
        }
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        // Keep seed identity, term frequencies and candidate revision in one read snapshot.
        let _snapshot = db.connection.unchecked_transaction()?;
        let current = self.read_coauthor_source(scope, &seed.key, &seed.revision, 0, 1)?;
        let pending_sources: i64 = db.connection.query_row(
            "SELECT count(*) FROM coauthor_source_queue WHERE kind<>'MESSAGE'", [], |row| row.get(0),
        )?;
        if pending_sources != 0 {
            return Ok(None);
        }
        let record: Option<(String, String)> = db.connection.query_row(
            "SELECT r.aliases_json,r.description FROM entities e JOIN entity_revisions r ON r.id=e.current_revision_id
             WHERE e.id=?1 AND e.project_id=?2 AND e.entity_type='CONCEPT' AND e.lifecycle_status='ACTIVE'",
            rusqlite::params![seed.key.strip_prefix("ENTITY:").ok_or(CoauthorError::NotFound)?, scope.project_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((aliases, description)) = record else { return Ok(None) };
        let aliases: Vec<String> = serde_json::from_str(&aliases)
            .map_err(|_| CoauthorError::Invalid("来源别名无法解析，未执行关联补查。".into()))?;
        let lower = query.to_lowercase();
        if std::iter::once(&current.title).chain(aliases.iter()).any(|name| {
            name.chars().count() >= 2 && lower.contains(&name.to_lowercase())
        }) {
            return Ok(None);
        }
        let total: i64 = db.connection.query_row(
            "SELECT count(*) FROM entities WHERE project_id=?1 AND entity_type='CONCEPT' AND lifecycle_status='ACTIVE'",
            [scope.project_id.to_string()], |row| row.get(0),
        )?;
        let excerpt = novel_application::DiscussionRelevance::new(query).excerpt(&description, 600);
        let mut shared = Vec::new();
        // Only index lookups for a bounded seed excerpt, never a corpus text scan.
        let mut frequency = db.connection.prepare(
            "SELECT count(*) FROM coauthor_fts f JOIN coauthor_sources s ON s.source_key=f.source_key
             JOIN entities e ON s.source_key='ENTITY:' || e.id
             WHERE coauthor_fts MATCH ?1 AND e.project_id=?2
             AND e.entity_type='CONCEPT' AND e.lifecycle_status='ACTIVE'",
        )?;
        for term in coauthor_terms(&excerpt).into_iter().take(64) {
            let count: i64 = frequency.query_row(
                rusqlite::params![format!("\"{}\"", term.replace('"', "\"\"")), scope.project_id.to_string()],
                |row| row.get(0),
            )?;
            if count >= 2 && count <= (total / 2).max(2) {
                shared.push((count, term));
            }
        }
        shared.sort();
        shared.truncate(12);
        if shared.len() < 3 {
            return Ok(None);
        }
        let expression = shared.iter().map(|(_, term)| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>().join(" OR ");
        let mut stmt = db.connection.prepare(
            "SELECT s.source_key,s.revision,f.terms FROM coauthor_fts f
             JOIN coauthor_sources s ON s.source_key=f.source_key
             JOIN entities e ON s.source_key='ENTITY:' || e.id
             WHERE coauthor_fts MATCH ?1 AND s.source_key<>?2 AND e.project_id=?3
             AND e.entity_type='CONCEPT' AND e.lifecycle_status='ACTIVE'
             ORDER BY rank,s.source_key LIMIT 16",
        )?;
        let candidates = stmt.query_map(
            rusqlite::params![expression, seed.key, scope.project_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )?.collect::<Result<Vec<_>, _>>()?;
        let mut ranked = candidates.into_iter().filter_map(|(key, revision, terms)| {
            let terms = terms.split_whitespace().collect::<BTreeSet<_>>();
            let matches = shared.iter().filter(|(_, term)| terms.contains(term.as_str())).collect::<Vec<_>>();
            (matches.len() >= 3).then(|| {
                let weight = matches.iter().map(|(count, _)| 10_000 / count).sum::<i64>();
                (weight, key, revision)
            })
        }).collect::<Vec<_>>();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let Some((_, key, revision)) = ranked.into_iter().next() else { return Ok(None) };
        let terms = shared.into_iter().map(|(_, term)| term).collect::<Vec<_>>();
        let generated_query = terms.join(" ");
        let mut candidate = self.read_coauthor_source(scope, &key, &revision, 0, 12_000)?;
        candidate.content = novel_application::DiscussionRelevance::new(&generated_query).excerpt(&candidate.content, 600);
        Ok(Some(CoauthorSourceFollowup {
            seed_key: current.key, seed_revision: current.revision,
            query: expression, shared_terms: terms, candidate_limit: 16,
            result: CoauthorSearchPage {
                execution: CoauthorSearchExecution::ReturnedPage, hits: vec![candidate],
                has_more: false, pending_index_updates: db.coauthor_pending_updates()?,
                coverage: "仅从单个弱词面候选的当前片段生成共有词项，在至多16份概念候选中补充1份；本操作不提供分页，不是语义判定、精读或查全。仍须按需检索并读取原文条件。".into(),
            },
        }))
    }
}

#[cfg(test)]
mod tests;
