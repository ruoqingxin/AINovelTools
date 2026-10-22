use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorSourceCheckInput {
    pub title: String,
    pub query: String,
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSourceCheck {
    pub id: Uuid,
    pub title: String,
    pub query: String,
    pub kinds: Vec<String>,
    pub total: usize,
    pub read: usize,
    pub sent: usize,
    pub reviewed: usize,
    pub relevant: usize,
    pub uncertain: usize,
    pub stale: usize,
    pub added: usize,
    pub pending_index_updates: usize,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorCheckEntry {
    pub key: String,
    pub revision: String,
    pub title: String,
    pub total_chars: Option<usize>,
    pub read_chars: usize,
    pub sent_chars: usize,
    pub sent_complete: bool,
    pub next_offset: usize,
    pub stale: bool,
    pub assessment: Option<String>,
    pub reason: String,
    pub quote: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorCheckPage {
    pub check: CoauthorSourceCheck,
    pub entries: Vec<CoauthorCheckEntry>,
    pub offset: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChecksPage {
    pub checks: Vec<CoauthorSourceCheck>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorCheckRead {
    pub check_id: Uuid,
    pub read_id: Uuid,
    #[serde(flatten)]
    pub source: CoauthorSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorCheckAssessment {
    pub check_id: Uuid,
    pub key: String,
    pub revision: String,
    pub assessment: String,
    pub reason: String,
    pub quote: String,
}

fn ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = vec![];
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| last.1 >= start) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}

fn count(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<usize> {
    usize::try_from(row.get::<_, i64>(index)?).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn optional_count(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<usize>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| usize::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

fn sql_count(value: usize) -> Result<i64, CoauthorError> {
    i64::try_from(value)
        .map_err(|_| CoauthorError::Invalid("读取范围超出数据库支持的长度。".into()))
}

impl Database {
    pub(crate) fn migrate_coauthor_source_checks(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS coauthor_sources_kind ON coauthor_sources(kind,source_key);
            CREATE TABLE coauthor_source_checks (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                title TEXT NOT NULL, query TEXT NOT NULL, kinds TEXT NOT NULL CHECK(json_valid(kinds)),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX coauthor_source_checks_session ON coauthor_source_checks(session_id);
            CREATE TABLE coauthor_check_entries (
                check_id TEXT NOT NULL REFERENCES coauthor_source_checks(id),
                source_key TEXT NOT NULL, revision TEXT NOT NULL, title TEXT NOT NULL,
                total_chars INTEGER CHECK(total_chars>=0),
                read_chars INTEGER NOT NULL DEFAULT 0 CHECK(read_chars>=0),
                sent_chars INTEGER NOT NULL DEFAULT 0 CHECK(sent_chars>=0),
                next_offset INTEGER NOT NULL DEFAULT 0 CHECK(next_offset>=0),
                read_complete INTEGER NOT NULL DEFAULT 0 CHECK(read_complete IN (0,1)),
                sent_complete INTEGER NOT NULL DEFAULT 0 CHECK(sent_complete IN (0,1)),
                assessment TEXT CHECK(assessment IN ('RELEVANT','IRRELEVANT','UNCERTAIN')),
                reason TEXT NOT NULL DEFAULT '', quote TEXT NOT NULL DEFAULT '', last_error TEXT,
                PRIMARY KEY(check_id,source_key)
            );
            CREATE TABLE coauthor_check_reads (
                id TEXT PRIMARY KEY, check_id TEXT NOT NULL, source_key TEXT NOT NULL,
                run_id TEXT NOT NULL REFERENCES coauthor_runs(id),
                start INTEGER NOT NULL CHECK(start>=0), end INTEGER NOT NULL CHECK(end>=start),
                sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)),
                FOREIGN KEY(check_id,source_key) REFERENCES coauthor_check_entries(check_id,source_key)
            );
            CREATE INDEX coauthor_check_reads_entry ON coauthor_check_reads(check_id,source_key);
            INSERT INTO schema_migrations(version,name) VALUES (55,'coauthor_source_checks');",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn load_source_check(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
    ) -> Result<CoauthorSourceCheck, CoauthorError> {
        let (title, query, kinds): (String, String, String) = self.connection.query_row(
            "SELECT title,query,kinds FROM coauthor_source_checks WHERE id=?1 AND session_id=?2",
            rusqlite::params![id.to_string(), scope.session_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?.ok_or(CoauthorError::NotFound)?;
        let mut check = CoauthorSourceCheck {
            id,
            title,
            query,
            kinds: decode(kinds.clone())?,
            total: 0,
            read: 0,
            sent: 0,
            reviewed: 0,
            relevant: 0,
            uncertain: 0,
            stale: 0,
            added: 0,
            pending_index_updates: 0,
            complete: false,
        };
        // All progress queries use identities and compact ranges, never book text.
        (check.total,check.read,check.sent,check.reviewed,check.relevant,check.uncertain,check.stale) =
            self.connection.query_row(
            "WITH entries AS (
                SELECT e.*,s.revision IS NULL OR s.revision<>e.revision OR EXISTS(
                    SELECT 1 FROM coauthor_source_queue q WHERE q.kind=substr(e.source_key,1,instr(e.source_key,':')-1)
                    AND q.source_id=substr(e.source_key,instr(e.source_key,':')+1)) AS stale
                FROM coauthor_check_entries e LEFT JOIN coauthor_sources s ON s.source_key=e.source_key WHERE e.check_id=?1)
             SELECT COUNT(*),COALESCE(SUM(read_complete AND NOT stale),0),COALESCE(SUM(sent_complete AND NOT stale),0),
                COALESCE(SUM(assessment IS NOT NULL AND NOT stale),0),COALESCE(SUM(assessment='RELEVANT' AND NOT stale),0),
                COALESCE(SUM(assessment='UNCERTAIN' AND NOT stale),0),COALESCE(SUM(stale),0) FROM entries",
            [id.to_string()], |row| Ok((count(row,0)?,count(row,1)?,count(row,2)?,count(row,3)?,count(row,4)?,count(row,5)?,count(row,6)?)))?;
        check.added = self.connection.query_row(
            "SELECT COUNT(*) FROM coauthor_sources s WHERE s.kind IN (SELECT value FROM json_each(?2))
             AND NOT EXISTS(SELECT 1 FROM coauthor_check_entries e WHERE e.check_id=?1 AND e.source_key=s.source_key)",
            rusqlite::params![id.to_string(), kinds], |row| count(row,0),
        )?;
        check.pending_index_updates = self.connection.query_row(
            "SELECT COUNT(*) FROM coauthor_source_queue WHERE kind IN (SELECT value FROM json_each(?1))",
            [&kinds], |row| count(row,0),
        )?;
        check.complete = check.total > 0
            && check.reviewed == check.total
            && check.sent == check.total
            && check.uncertain == 0
            && check.stale == 0
            && check.added == 0
            && check.pending_index_updates == 0;
        Ok(check)
    }

    fn check_ranges(&self, id: Uuid, key: &str) -> Result<(usize, usize, usize), CoauthorError> {
        let mut stmt = self.connection.prepare(
            "SELECT start,end,sent FROM coauthor_check_reads WHERE check_id=?1 AND source_key=?2",
        )?;
        let reads = stmt
            .query_map(rusqlite::params![id.to_string(), key], |row| {
                Ok((count(row, 0)?, count(row, 1)?, row.get::<_, bool>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let all = ranges(reads.iter().map(|(start, end, _)| (*start, *end)).collect());
        let sent = ranges(
            reads
                .iter()
                .filter(|(_, _, sent)| *sent)
                .map(|(start, end, _)| (*start, *end))
                .collect(),
        );
        Ok((
            all.iter().map(|(a, b)| b - a).sum(),
            sent.iter().map(|(a, b)| b - a).sum(),
            sent.first()
                .filter(|(start, _)| *start == 0)
                .map_or(0, |(_, end)| *end),
        ))
    }

    fn check_entry_revision(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
        key: &str,
    ) -> Result<String, CoauthorError> {
        self.connection.query_row(
            "SELECT e.revision FROM coauthor_check_entries e JOIN coauthor_source_checks c ON c.id=e.check_id
             WHERE c.id=?1 AND c.session_id=?2 AND e.source_key=?3",
            rusqlite::params![id.to_string(),scope.session_id.to_string(),key], |row| row.get(0),
        ).optional()?.ok_or(CoauthorError::NotFound)
    }

    fn refresh_check_progress(&self, id: Uuid, key: &str) -> Result<(), CoauthorError> {
        let (read, sent, next) = self.check_ranges(id, key)?;
        self.connection.execute(
            "UPDATE coauthor_check_entries SET read_chars=?3,sent_chars=?4,next_offset=?5,
                read_complete=(total_chars IS NOT NULL AND total_chars=?3),
                sent_complete=(total_chars IS NOT NULL AND total_chars=?4 AND EXISTS(
                    SELECT 1 FROM coauthor_check_reads WHERE check_id=?1 AND source_key=?2 AND sent=1))
             WHERE check_id=?1 AND source_key=?2",
            rusqlite::params![id.to_string(),key,sql_count(read)?,sql_count(sent)?,sql_count(next)?])?;
        Ok(())
    }
}

impl ProjectManager {
    pub fn create_coauthor_source_check(
        &mut self,
        scope: &CoauthorScope,
        input: CoauthorSourceCheckInput,
    ) -> Result<CoauthorCheckPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let mut kinds = input.kinds;
        kinds.sort();
        kinds.dedup();
        if input.title.trim().is_empty()
            || input.title.chars().count() > 200
            || input.query.trim().is_empty()
            || input.query.chars().count() > 2000
            || kinds.is_empty()
            || kinds
                .iter()
                .any(|kind| !matches!(kind.as_str(), "ENTITY" | "PLAN" | "MANUSCRIPT"))
        {
            return Err(CoauthorError::Invalid(
                "查证须有明确问题、标题和正文/规划/设定范围。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        db.sync_coauthor_sources()?;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let kinds = encode(&kinds)?;
        let pending: usize = tx.query_row(
            "SELECT COUNT(*) FROM coauthor_source_queue WHERE kind IN (SELECT value FROM json_each(?1))",
            [&kinds], |row| count(row,0),
        )?;
        if pending > 0 {
            return Err(CoauthorError::Invalid(format!(
                "所选范围还有 {pending} 项索引等待更新，请继续更新后重试；尚未创建不完整的范围清单。"
            )));
        }
        let id = Uuid::new_v4();
        tx.execute("INSERT INTO coauthor_source_checks(id,session_id,title,query,kinds) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![id.to_string(),scope.session_id.to_string(),input.title,input.query,kinds])?;
        tx.execute("INSERT INTO coauthor_check_entries(check_id,source_key,revision,title)
            SELECT ?1,source_key,revision,title FROM coauthor_sources WHERE kind IN (SELECT value FROM json_each(?2))",
            rusqlite::params![id.to_string(),kinds])?;
        tx.commit()?;
        self.get_coauthor_source_check(scope, id, 0)
    }

    pub fn list_coauthor_source_checks(
        &self,
        scope: &CoauthorScope,
        offset: u32,
    ) -> Result<CoauthorChecksPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let mut stmt = tx.prepare("SELECT id FROM coauthor_source_checks WHERE session_id=?1 ORDER BY rowid DESC LIMIT 11 OFFSET ?2")?;
        let ids = stmt
            .query_map(
                rusqlite::params![scope.session_id.to_string(), offset],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = ids.len() > 10;
        let checks = ids
            .into_iter()
            .take(10)
            .map(|id| db.load_source_check(scope, id.parse().map_err(|_| CoauthorError::NotFound)?))
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        tx.commit()?;
        Ok(CoauthorChecksPage { checks, has_more })
    }

    pub fn get_coauthor_source_check(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
        offset: u32,
    ) -> Result<CoauthorCheckPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let check = db.load_source_check(scope, id)?;
        let mut stmt = tx.prepare(
            "SELECT e.source_key,e.revision,e.title,e.total_chars,e.assessment,e.reason,e.quote,e.last_error,
                s.revision IS NULL OR s.revision<>e.revision OR EXISTS(
                    SELECT 1 FROM coauthor_source_queue q WHERE q.kind=substr(e.source_key,1,instr(e.source_key,':')-1)
                    AND q.source_id=substr(e.source_key,instr(e.source_key,':')+1)),
                e.read_chars,e.sent_chars,e.next_offset,e.sent_complete
             FROM coauthor_check_entries e LEFT JOIN coauthor_sources s ON s.source_key=e.source_key
             WHERE e.check_id=?1 ORDER BY e.source_key LIMIT 21 OFFSET ?2",
        )?;
        let mut entries = stmt
            .query_map(rusqlite::params![id.to_string(), offset], |row| {
                Ok(CoauthorCheckEntry {
                    key: row.get(0)?,
                    revision: row.get(1)?,
                    title: row.get(2)?,
                    total_chars: optional_count(row, 3)?,
                    assessment: row.get(4)?,
                    reason: row.get(5)?,
                    quote: row.get(6)?,
                    last_error: row.get(7)?,
                    stale: row.get(8)?,
                    read_chars: count(row, 9)?,
                    sent_chars: count(row, 10)?,
                    next_offset: count(row, 11)?,
                    sent_complete: row.get(12)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = entries.len() > 20;
        entries.truncate(20);
        drop(stmt);
        tx.commit()?;
        Ok(CoauthorCheckPage {
            check,
            entries,
            offset,
            has_more,
        })
    }

    pub fn read_coauthor_check_source(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        id: Uuid,
        key: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CoauthorCheckRead, CoauthorError> {
        if !self.coauthor_run_active(scope, run_id)? {
            return Err(CoauthorError::Conflict);
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let revision = db.check_entry_revision(scope, id, key)?;
        let source = match self.read_coauthor_source(scope, key, &revision, offset, limit) {
            Ok(source) => source,
            Err(error) => {
                db.connection.execute("UPDATE coauthor_check_entries SET last_error=?3 WHERE check_id=?1 AND source_key=?2",
                    rusqlite::params![id.to_string(),key,error.to_string()])?;
                return Err(error);
            }
        };
        let read_id = Uuid::new_v4();
        let tx = db.connection.unchecked_transaction()?;
        tx.execute("UPDATE coauthor_check_entries SET total_chars=?3,last_error=NULL WHERE check_id=?1 AND source_key=?2",
            rusqlite::params![id.to_string(),key,sql_count(source.total_chars)?])?;
        tx.execute("INSERT INTO coauthor_check_reads(id,check_id,source_key,run_id,start,end) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![read_id.to_string(),id.to_string(),key,run_id.to_string(),sql_count(offset)?,sql_count(offset+source.content.chars().count())?])?;
        db.refresh_check_progress(id, key)?;
        tx.commit()?;
        Ok(CoauthorCheckRead {
            check_id: id,
            read_id,
            source,
        })
    }

    /// Only the runner acknowledges tool results after a successful provider turn.
    pub fn acknowledge_coauthor_check_reads(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        ids: &[Uuid],
    ) -> Result<(), CoauthorError> {
        if !self.coauthor_run_active(scope, run_id)? {
            return Err(CoauthorError::Conflict);
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        for id in ids {
            if tx.execute(
                "UPDATE coauthor_check_reads SET sent=1 WHERE id=?1 AND run_id=?2 AND check_id IN
                (SELECT id FROM coauthor_source_checks WHERE session_id=?3)",
                rusqlite::params![
                    id.to_string(),
                    run_id.to_string(),
                    scope.session_id.to_string()
                ],
            )? != 1
            {
                return Err(CoauthorError::NotFound);
            }
            let (check_id, key): (String, String) = tx.query_row(
                "SELECT check_id,source_key FROM coauthor_check_reads WHERE id=?1",
                [id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            db.refresh_check_progress(
                check_id.parse().map_err(|_| CoauthorError::NotFound)?,
                &key,
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn assess_coauthor_check_source(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        input: CoauthorCheckAssessment,
    ) -> Result<CoauthorCheckPage, CoauthorError> {
        if !self.coauthor_run_active(scope, run_id)? {
            return Err(CoauthorError::Conflict);
        }
        if !matches!(
            input.assessment.as_str(),
            "RELEVANT" | "IRRELEVANT" | "UNCERTAIN"
        ) || input.reason.trim().is_empty()
            || input.reason.chars().count() > 2000
            || input.quote.chars().count() > 2000
            || (input.assessment == "RELEVANT" && input.quote.trim().is_empty())
        {
            return Err(CoauthorError::Invalid(
                "查证判断需要明确状态和理由；相关判断还须有准确原文引句。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let revision = db.check_entry_revision(scope, input.check_id, &input.key)?;
        if revision != input.revision {
            return Err(CoauthorError::Conflict);
        }
        let source = db
            .coauthor_source(&input.key)?
            .ok_or(CoauthorError::NotFound)?;
        if source.revision != revision {
            return Err(CoauthorError::Conflict);
        }
        // Unknown (never read) is different from an explicitly read empty source.
        let (total,sent): (Option<usize>,bool) = tx.query_row(
            "SELECT total_chars,sent_complete FROM coauthor_check_entries WHERE check_id=?1 AND source_key=?2",
            rusqlite::params![input.check_id.to_string(),input.key], |row| Ok((optional_count(row,0)?,row.get(1)?)))?;
        if total != Some(source.total_chars) || !sent {
            return Err(CoauthorError::Invalid(
                "须先完整接收该资料所有原文范围，不能仅凭命中或部分页标记已判断。".into(),
            ));
        }
        if !input.quote.is_empty() && !source.content.contains(&input.quote) {
            return Err(CoauthorError::Invalid(
                "查证引句不在对应修订原文中。".into(),
            ));
        }
        tx.execute(
            "UPDATE coauthor_check_entries SET assessment=?3,reason=?4,quote=?5
            WHERE check_id=?1 AND source_key=?2",
            rusqlite::params![
                input.check_id.to_string(),
                input.key,
                input.assessment,
                input.reason,
                input.quote
            ],
        )?;
        tx.commit()?;
        self.get_coauthor_source_check(scope, input.check_id, 0)
    }
}

#[cfg(test)]
mod tests;
