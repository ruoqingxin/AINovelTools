use super::*;
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorDecisionInput {
    pub decision_id: Option<Uuid>,
    pub expected_version: i64,
    pub topic: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub content: String,
    pub status: String,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionMemory {
    pub decision: CoauthorDecision,
    pub aliases: Vec<String>,
    pub quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionsPage {
    pub memories: Vec<CoauthorDecisionMemory>,
    pub offset: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionRevision {
    pub decision: CoauthorDecision,
    pub quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionHistory {
    pub current: CoauthorDecisionMemory,
    pub revisions: Vec<CoauthorDecisionRevision>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionGuard {
    pub current: CoauthorDecision,
    /// Zero denotes an older decision inherited before this branch's version 1.
    pub referenced_version: i64,
    pub superseded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionContext {
    pub guards: Vec<CoauthorDecisionGuard>,
    pub has_more: bool,
}

pub(super) fn topic_key(topic: &str) -> String {
    topic
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn validate(content: &str, status: &str) -> Result<(), CoauthorError> {
    if content.trim().is_empty()
        || content.chars().count() > 5000
        || !["CHOSEN", "REJECTED", "OPEN", "WITHDRAWN"].contains(&status)
    {
        return Err(CoauthorError::Invalid("决定内容或状态无效。".into()));
    }
    Ok(())
}

impl Database {
    pub(crate) fn migrate_coauthor_decision_memory(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_decision_aliases(
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                alias_key TEXT NOT NULL, decision_id TEXT NOT NULL REFERENCES coauthor_decisions(id),
                label TEXT NOT NULL, PRIMARY KEY(session_id,alias_key,decision_id)
            );
            CREATE INDEX coauthor_decision_alias_owner ON coauthor_decision_aliases(decision_id);
            CREATE TABLE coauthor_decision_evidence(
                decision_id TEXT NOT NULL REFERENCES coauthor_decisions(id),
                version INTEGER NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(decision_id,version),
                FOREIGN KEY(decision_id,version) REFERENCES coauthor_decision_revisions(decision_id,version)
            );
            CREATE TABLE coauthor_decision_mentions(
                message_id TEXT NOT NULL REFERENCES discussion_messages(id),
                decision_id TEXT NOT NULL REFERENCES coauthor_decisions(id),
                version INTEGER NOT NULL CHECK(version>=0),
                PRIMARY KEY(message_id,decision_id,version)
            );
            CREATE INDEX coauthor_decision_mentions_owner ON coauthor_decision_mentions(decision_id);
            CREATE VIRTUAL TABLE coauthor_decision_fts USING fts5(
                decision_id UNINDEXED,session_id UNINDEXED,terms,tokenize='unicode61'
            );",
        )?;
        let mut stmt = tx.prepare("SELECT id,session_id,topic FROM coauthor_decisions")?;
        let decisions = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for (id, session, topic) in decisions {
            tx.execute(
                "INSERT INTO coauthor_decision_aliases VALUES(?1,?2,?3,?4)",
                rusqlite::params![session, topic_key(&topic), id, topic],
            )?;
            let mut stmt=tx.prepare("SELECT payload FROM coauthor_decision_revisions WHERE decision_id=?1 ORDER BY version")?;
            let revisions = stmt
                .query_map([&id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut terms = sources::coauthor_terms(&topic);
            for payload in revisions {
                let decision: CoauthorDecision =
                    serde_json::from_str(&payload).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                terms.extend(sources::coauthor_terms(&decision.content));
                tx.execute(
                    "INSERT OR IGNORE INTO coauthor_decision_mentions
                     SELECT id,?1,?2 FROM discussion_messages WHERE id=?3 AND session_id=?4",
                    rusqlite::params![
                        id,
                        decision.version,
                        decision.source_message_id.to_string(),
                        session
                    ],
                )?;
            }
            tx.execute(
                "INSERT INTO coauthor_decision_fts VALUES(?1,?2,?3)",
                rusqlite::params![id, session, terms.into_iter().collect::<Vec<_>>().join(" ")],
            )?;
        }
        tx.execute_batch(
            "INSERT OR IGNORE INTO coauthor_decision_mentions
             SELECT output.id,m.decision_id,m.version FROM coauthor_decision_mentions m
             JOIN coauthor_runs r ON r.user_message_id=m.message_id
             JOIN discussion_messages output ON output.session_id=r.session_id AND output.context_version='coauthor:' || r.id;
             INSERT INTO schema_migrations(version,name) VALUES(57,'coauthor_decision_memory');",
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn decision(&self, session: Uuid, id: Uuid) -> Result<CoauthorDecision, CoauthorError> {
        self.connection
            .query_row(
                "SELECT r.payload FROM coauthor_decisions d JOIN coauthor_decision_revisions r
             ON r.decision_id=d.id AND r.version=d.version WHERE d.id=?1 AND d.session_id=?2",
                rusqlite::params![id.to_string(), session.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(CoauthorError::NotFound)
            .and_then(decode)
    }

    pub(super) fn decision_memory(
        &self,
        session: Uuid,
        id: Uuid,
    ) -> Result<CoauthorDecisionMemory, CoauthorError> {
        let decision = self.decision(session, id)?;
        let mut stmt=self.connection.prepare(
            "SELECT label FROM coauthor_decision_aliases WHERE session_id=?1 AND decision_id=?2 ORDER BY alias_key")?;
        let aliases = stmt
            .query_map(
                rusqlite::params![session.to_string(), id.to_string()],
                |row| row.get(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let quote = self
            .connection
            .query_row(
                "SELECT quote FROM coauthor_decision_evidence WHERE decision_id=?1 AND version=?2",
                rusqlite::params![id.to_string(), decision.version],
                |row| row.get(0),
            )
            .optional()?;
        Ok(CoauthorDecisionMemory {
            decision,
            aliases,
            quote,
        })
    }

    fn index_decision(
        &self,
        session: Uuid,
        decision: &CoauthorDecision,
        aliases: &[String],
    ) -> Result<(), CoauthorError> {
        let old: Option<String> = self
            .connection
            .query_row(
                "SELECT terms FROM coauthor_decision_fts WHERE decision_id=?1",
                [decision.id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let mut terms = old
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        terms.extend(sources::coauthor_terms(&format!(
            "{}\n{}",
            decision.topic, decision.content
        )));
        for alias in aliases {
            terms.extend(sources::coauthor_terms(alias));
        }
        self.connection.execute(
            "DELETE FROM coauthor_decision_fts WHERE decision_id=?1",
            [decision.id.to_string()],
        )?;
        self.connection.execute(
            "INSERT INTO coauthor_decision_fts VALUES(?1,?2,?3)",
            rusqlite::params![
                decision.id.to_string(),
                session.to_string(),
                terms.into_iter().collect::<Vec<_>>().join(" ")
            ],
        )?;
        Ok(())
    }

    pub(super) fn write_decision(
        &self,
        session: Uuid,
        decision: &CoauthorDecision,
        quote: &str,
        aliases: &[String],
    ) -> Result<(), CoauthorError> {
        self.connection.execute(
            "INSERT INTO coauthor_decisions(id,session_id,topic,content,status,source_message_id,version)
             VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET
             content=excluded.content,status=excluded.status,source_message_id=excluded.source_message_id,version=excluded.version",
            rusqlite::params![decision.id.to_string(),session.to_string(),decision.topic,decision.content,decision.status,
                decision.source_message_id.to_string(),decision.version])?;
        for label in aliases {
            self.connection.execute(
                "INSERT OR IGNORE INTO coauthor_decision_aliases VALUES(?1,?2,?3,?4)",
                rusqlite::params![
                    session.to_string(),
                    topic_key(label),
                    decision.id.to_string(),
                    label
                ],
            )?;
        }
        self.connection.execute(
            "INSERT INTO coauthor_decision_revisions VALUES(?1,?2,?3)",
            rusqlite::params![decision.id.to_string(), decision.version, encode(decision)?],
        )?;
        self.connection.execute(
            "INSERT INTO coauthor_decision_evidence VALUES(?1,?2,?3)",
            rusqlite::params![decision.id.to_string(), decision.version, quote],
        )?;
        self.connection.execute(
            "INSERT INTO coauthor_decision_mentions VALUES(?1,?2,?3)",
            rusqlite::params![
                decision.source_message_id.to_string(),
                decision.id.to_string(),
                decision.version
            ],
        )?;
        let mut searchable = aliases.to_vec();
        searchable.push(quote.into());
        self.index_decision(session, decision, &searchable)
    }

    pub(super) fn message_decision_context(
        &self,
        session: Uuid,
        message: Uuid,
    ) -> Result<Option<CoauthorDecisionContext>, CoauthorError> {
        let mut stmt = self.connection.prepare(
            "SELECT m.decision_id,MIN(m.version) FROM coauthor_decision_mentions m
             JOIN coauthor_decisions d ON d.id=m.decision_id
             JOIN discussion_messages text ON text.id=m.message_id
             WHERE m.message_id=?1 AND d.session_id=?2 AND text.session_id=?2
             GROUP BY m.decision_id ORDER BY m.decision_id LIMIT 17",
        )?;
        let references = stmt
            .query_map(
                rusqlite::params![message.to_string(), session.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        if references.is_empty() {
            return Ok(None);
        }
        let has_more = references.len() > 16;
        let guards = references
            .into_iter()
            .take(16)
            .map(|(id, version)| {
                let current =
                    self.decision(session, id.parse().map_err(|_| CoauthorError::NotFound)?)?;
                Ok(CoauthorDecisionGuard {
                    superseded: version < current.version,
                    current,
                    referenced_version: version,
                })
            })
            .collect::<Result<Vec<_>, CoauthorError>>()?;
        Ok(Some(CoauthorDecisionContext { guards, has_more }))
    }

    pub(super) fn link_run_decisions(&self, session: Uuid, run: Uuid) -> Result<(), CoauthorError> {
        self.connection.execute(
            "INSERT OR IGNORE INTO coauthor_decision_mentions
             SELECT output.id,m.decision_id,m.version FROM coauthor_runs r
             JOIN coauthor_decision_mentions m ON m.message_id=r.user_message_id
             JOIN coauthor_decisions d ON d.id=m.decision_id AND d.session_id=r.session_id
             JOIN discussion_messages output ON output.session_id=r.session_id AND output.context_version='coauthor:' || r.id
             WHERE r.id=?1 AND r.session_id=?2",
            rusqlite::params![run.to_string(),session.to_string()])?;
        Ok(())
    }

    pub(super) fn fork_decision_memory(
        &self,
        session: Uuid,
        previous: &CoauthorDecision,
        copied: &CoauthorDecision,
        inherited: &HashMap<String, String>,
    ) -> Result<(), CoauthorError> {
        self.connection.execute(
            "INSERT INTO coauthor_decision_aliases SELECT ?1,alias_key,?2,label FROM coauthor_decision_aliases WHERE decision_id=?3",
            rusqlite::params![session.to_string(),copied.id.to_string(),previous.id.to_string()])?;
        self.connection.execute(
            "INSERT INTO coauthor_decision_fts SELECT ?1,?2,terms FROM coauthor_decision_fts WHERE decision_id=?3",
            rusqlite::params![copied.id.to_string(),session.to_string(),previous.id.to_string()])?;
        self.connection.execute(
            "INSERT INTO coauthor_decision_evidence SELECT ?1,1,quote FROM coauthor_decision_evidence WHERE decision_id=?2 AND version=?3",
            rusqlite::params![copied.id.to_string(),previous.id.to_string(),previous.version])?;
        let mut stmt = self.connection.prepare(
            "SELECT message_id,version FROM coauthor_decision_mentions WHERE decision_id=?1",
        )?;
        let mentions = stmt
            .query_map([previous.id.to_string()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (message, version) in mentions {
            let target = inherited.get(&message).ok_or(CoauthorError::NotFound)?;
            self.connection.execute(
                "INSERT OR IGNORE INTO coauthor_decision_mentions VALUES(?1,?2,?3)",
                rusqlite::params![
                    target,
                    copied.id.to_string(),
                    i64::from(version == previous.version)
                ],
            )?;
        }
        Ok(())
    }
}

impl ProjectManager {
    pub fn set_coauthor_decision(
        &mut self,
        scope: &CoauthorScope,
        run: Uuid,
        input: CoauthorDecisionInput,
    ) -> Result<CoauthorDecision, CoauthorError> {
        if !self.coauthor_run_active(scope, run)? {
            return Err(CoauthorError::Conflict);
        }
        validate(&input.content, &input.status)?;
        let aliases = std::iter::once(input.topic.clone())
            .chain(input.aliases)
            .collect::<Vec<_>>();
        if aliases.len() > 9
            || aliases
                .iter()
                .any(|label| topic_key(label).is_empty() || label.chars().count() > 200)
            || input.quote.trim().is_empty()
            || input.quote.chars().count() > 2000
            || input.expected_version < 0
        {
            return Err(CoauthorError::Invalid(
                "决定须有明确主题、至多8个别名、准确作者原话及版本。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let (message,text):(String,String)=tx.query_row(
            "SELECT m.id,m.content FROM coauthor_runs r JOIN discussion_messages m ON m.id=r.user_message_id
             WHERE r.id=?1 AND r.session_id=?2 AND r.status='RUNNING' AND m.session_id=?2 AND m.role='USER'",
            rusqlite::params![run.to_string(),scope.session_id.to_string()],|row|Ok((row.get(0)?,row.get(1)?)))?;
        if !text.contains(&input.quote) {
            return Err(CoauthorError::Invalid(
                "决定缺少本轮作者原话依据，未记录。".into(),
            ));
        }
        let previous = input
            .decision_id
            .map(|id| db.decision(scope.session_id, id))
            .transpose()?;
        if previous.as_ref().map_or(0, |d| d.version) != input.expected_version {
            return Err(CoauthorError::Conflict);
        }
        for alias in &aliases {
            let collision:bool=tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM coauthor_decision_aliases WHERE session_id=?1 AND alias_key=?2 AND decision_id<>?3)
                 AND NOT EXISTS(SELECT 1 FROM coauthor_decision_aliases WHERE session_id=?1 AND alias_key=?2 AND decision_id=?3)",
                rusqlite::params![scope.session_id.to_string(),topic_key(alias),input.decision_id.map(|id|id.to_string()).unwrap_or_default()],
                |row|row.get(0))?;
            if collision {
                return Err(CoauthorError::Invalid("主题或别名已关联其他决定；请查询最新决定并用准确decisionId和版本修改，不另建同名记忆。".into()));
            }
        }
        let decision = CoauthorDecision {
            id: previous.as_ref().map_or_else(Uuid::new_v4, |d| d.id),
            topic: previous
                .as_ref()
                .map_or_else(|| input.topic.trim().into(), |d| d.topic.clone()),
            version: input
                .expected_version
                .checked_add(1)
                .ok_or(CoauthorError::Conflict)?,
            content: input.content,
            status: input.status,
            source_message_id: message.parse().map_err(|_| CoauthorError::NotFound)?,
        };
        db.write_decision(scope.session_id, &decision, &input.quote, &aliases)?;
        tx.commit()?;
        Ok(decision)
    }

    pub fn correct_coauthor_decision(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
        content: &str,
        status: &str,
    ) -> Result<CoauthorDecision, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        validate(content, status)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let previous = db.decision(scope.session_id, id)?;
        if previous.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        let message = Uuid::new_v4();
        let updated = CoauthorDecision {
            version: expected_version
                .checked_add(1)
                .ok_or(CoauthorError::Conflict)?,
            content: content.into(),
            status: status.into(),
            source_message_id: message,
            ..previous
        };
        tx.execute(
            "INSERT INTO discussion_messages(id,session_id,role,content) VALUES(?1,?2,'USER',?3)",
            rusqlite::params![
                message.to_string(),
                scope.session_id.to_string(),
                format!(
                    "作者纠正讨论决定「{}」：{} [{}]",
                    updated.topic, content, status
                )
            ],
        )?;
        db.write_decision(scope.session_id, &updated, content, &[])?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn search_coauthor_decisions(
        &self,
        scope: &CoauthorScope,
        query: &str,
        offset: u32,
    ) -> Result<CoauthorDecisionsPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if query.chars().count() > 2000 {
            return Err(CoauthorError::Invalid(
                "决定查询过长，请分主题查询。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let terms = sources::coauthor_terms(query);
        let expression = terms
            .iter()
            .take(96)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let sql = if query.trim().is_empty() {
            "SELECT decision_id FROM coauthor_decision_fts WHERE session_id=?1 ORDER BY rowid DESC LIMIT 17 OFFSET ?3"
        } else if expression.is_empty() {
            "SELECT decision_id FROM coauthor_decision_aliases WHERE session_id=?1 AND alias_key=?2 ORDER BY decision_id LIMIT 17 OFFSET ?3"
        } else {
            "WITH hits AS MATERIALIZED (
                SELECT decision_id,rank AS score FROM coauthor_decision_fts
                WHERE session_id=?1 AND coauthor_decision_fts MATCH ?2
                UNION ALL SELECT decision_id,-1e30 FROM coauthor_decision_aliases WHERE session_id=?1 AND alias_key=?4)
             SELECT decision_id FROM hits GROUP BY decision_id ORDER BY MIN(score),decision_id LIMIT 17 OFFSET ?3"
        };
        let use_fts = !query.trim().is_empty() && !expression.is_empty();
        let parameter = if expression.is_empty() {
            topic_key(query)
        } else {
            expression
        };
        let mut stmt = tx.prepare(sql)?;
        let mut parameters = vec![
            rusqlite::types::Value::from(scope.session_id.to_string()),
            parameter.into(),
            i64::from(offset).into(),
        ];
        if use_fts {
            parameters.push(topic_key(query).into());
        }
        let ids = stmt
            .query_map(rusqlite::params_from_iter(parameters), |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = ids.len() > 16;
        let memories = ids
            .into_iter()
            .take(16)
            .map(|id| {
                db.decision_memory(
                    scope.session_id,
                    id.parse().map_err(|_| CoauthorError::NotFound)?,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        tx.commit()?;
        Ok(CoauthorDecisionsPage {
            memories,
            offset,
            has_more,
        })
    }

    pub fn list_coauthor_decision_history(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
        before_version: Option<i64>,
    ) -> Result<CoauthorDecisionHistory, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let current = db.decision_memory(scope.session_id, id)?;
        let mut stmt=tx.prepare(
            "SELECT r.payload,e.quote FROM coauthor_decision_revisions r LEFT JOIN coauthor_decision_evidence e
             ON e.decision_id=r.decision_id AND e.version=r.version
             WHERE r.decision_id=?1 AND (?2 IS NULL OR r.version<?2) ORDER BY r.version DESC LIMIT 21")?;
        let mut revisions = stmt
            .query_map(rusqlite::params![id.to_string(), before_version], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .map(|row| {
                let (payload, quote) = row?;
                Ok(CoauthorDecisionRevision {
                    decision: decode(payload)?,
                    quote,
                })
            })
            .collect::<Result<Vec<_>, CoauthorError>>()?;
        let has_more = revisions.len() > 20;
        revisions.truncate(20);
        drop(stmt);
        tx.commit()?;
        Ok(CoauthorDecisionHistory {
            current,
            revisions,
            has_more,
        })
    }

    pub fn coauthor_message_decision_context(
        &self,
        scope: &CoauthorScope,
        message: Uuid,
    ) -> Result<Option<CoauthorDecisionContext>, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database
            .message_decision_context(scope.session_id, message)
    }
}

#[cfg(test)]
mod tests;
