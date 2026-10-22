use super::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorCheckNoteInput {
    pub check_id: Uuid,
    pub key: String,
    pub revision: String,
    pub start: usize,
    pub end: usize,
    pub expected_version: i64,
    pub analysis: String,
    pub questions: String,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorCheckNote {
    pub id: Uuid,
    pub run_id: Uuid,
    pub start: usize,
    pub end: usize,
    pub version: i64,
    pub analysis: String,
    pub questions: String,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorCheckNotesPage {
    pub check_id: Uuid,
    pub key: String,
    pub revision: String,
    pub stale: bool,
    pub notes: Vec<CoauthorCheckNote>,
    pub total_notes: usize,
    pub noted_chars: usize,
    pub offset: u32,
    pub has_more: bool,
}

impl Database {
    pub(crate) fn migrate_coauthor_check_notes(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_check_notes (
                id TEXT PRIMARY KEY, check_id TEXT NOT NULL, source_key TEXT NOT NULL,
                run_id TEXT NOT NULL REFERENCES coauthor_runs(id),
                start INTEGER NOT NULL CHECK(start>=0), end INTEGER NOT NULL CHECK(end>=start),
                version INTEGER NOT NULL CHECK(version>0),
                analysis TEXT NOT NULL, questions TEXT NOT NULL, quote TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                FOREIGN KEY(check_id,source_key) REFERENCES coauthor_check_entries(check_id,source_key),
                UNIQUE(check_id,source_key,start,end,version)
            );
            INSERT INTO schema_migrations(version,name) VALUES (56,'coauthor_check_notes');",
        )?;
        tx.commit()?;
        Ok(())
    }
}

impl ProjectManager {
    pub fn get_coauthor_check_notes(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
        key: &str,
        offset: u32,
    ) -> Result<CoauthorCheckNotesPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let revision = db.check_entry_revision(scope, id, key)?;
        let stale = tx.query_row(
            "SELECT s.revision IS NULL OR s.revision<>e.revision OR EXISTS(
                SELECT 1 FROM coauthor_source_queue q
                WHERE q.kind=substr(e.source_key,1,instr(e.source_key,':')-1)
                AND q.source_id=substr(e.source_key,instr(e.source_key,':')+1))
             FROM coauthor_check_entries e LEFT JOIN coauthor_sources s ON s.source_key=e.source_key
             WHERE e.check_id=?1 AND e.source_key=?2",
            rusqlite::params![id.to_string(), key],
            |row| row.get(0),
        )?;
        // Compact ranges suffice for coverage; note text and original text are paged separately.
        let mut statement = tx.prepare(
            "SELECT start,end FROM coauthor_check_notes
             WHERE check_id=?1 AND source_key=?2 AND version=1 ORDER BY start,end",
        )?;
        let spans = statement
            .query_map(rusqlite::params![id.to_string(), key], |row| {
                Ok((count(row, 0)?, count(row, 1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let total_notes = spans.len();
        let noted_chars = ranges(spans).iter().map(|(a, b)| b - a).sum();
        drop(statement);
        let mut statement = tx.prepare(
            "SELECT n.id,n.run_id,n.start,n.end,n.version,n.analysis,n.questions,n.quote
             FROM coauthor_check_notes n WHERE n.check_id=?1 AND n.source_key=?2
             AND NOT EXISTS(SELECT 1 FROM coauthor_check_notes newer
                WHERE newer.check_id=n.check_id AND newer.source_key=n.source_key
                AND newer.start=n.start AND newer.end=n.end AND newer.version>n.version)
             ORDER BY n.start,n.end LIMIT 6 OFFSET ?3",
        )?;
        let mut notes = statement
            .query_map(rusqlite::params![id.to_string(), key, offset], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    count(row, 2)?,
                    count(row, 3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .map(|row| {
                let (id, run_id, start, end, version, analysis, questions, quote) = row?;
                Ok(CoauthorCheckNote {
                    id: id.parse().map_err(|_| CoauthorError::NotFound)?,
                    run_id: run_id.parse().map_err(|_| CoauthorError::NotFound)?,
                    start,
                    end,
                    version,
                    analysis,
                    questions,
                    quote,
                })
            })
            .collect::<Result<Vec<_>, CoauthorError>>()?;
        let has_more = notes.len() > 5;
        notes.truncate(5);
        drop(statement);
        tx.commit()?;
        Ok(CoauthorCheckNotesPage {
            check_id: id,
            key: key.into(),
            revision,
            stale,
            notes,
            total_notes,
            noted_chars,
            offset,
            has_more,
        })
    }

    pub fn save_coauthor_check_note(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        input: CoauthorCheckNoteInput,
    ) -> Result<CoauthorCheckNote, CoauthorError> {
        if !self.coauthor_run_active(scope, run_id)? {
            return Err(CoauthorError::Conflict);
        }
        if input.start > input.end
            || input.end - input.start > 12000
            || input.expected_version < 0
            || input.analysis.trim().is_empty()
            || input.analysis.chars().count() > 1000
            || input.questions.chars().count() > 600
            || input.quote.chars().count() > 500
        {
            return Err(CoauthorError::Invalid("分段笔记须有不超过12000字的准确范围和简明分析；分析/未决问题/引句上限为1000/600/500字。".into()));
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
        let revision = db.check_entry_revision(scope, input.check_id, &input.key)?;
        let source = db
            .coauthor_source(&input.key)?
            .ok_or(CoauthorError::NotFound)?;
        if revision != input.revision || source.revision != revision {
            return Err(CoauthorError::Conflict);
        }
        if input.end > source.total_chars || (input.start == input.end && source.total_chars != 0) {
            return Err(CoauthorError::Invalid(
                "分段笔记范围为空或超出原文。".into(),
            ));
        }
        let mut statement = tx.prepare(
            "SELECT start,end FROM coauthor_check_reads
             WHERE check_id=?1 AND source_key=?2 AND run_id=?3 AND sent=1",
        )?;
        let delivered = ranges(
            statement
                .query_map(
                    rusqlite::params![input.check_id.to_string(), input.key, run_id.to_string()],
                    |row| Ok((count(row, 0)?, count(row, 1)?)),
                )?
                .collect::<Result<Vec<_>, _>>()?,
        );
        if !delivered
            .iter()
            .any(|(a, b)| *a <= input.start && *b >= input.end)
        {
            return Err(CoauthorError::Invalid(
                "须先在本轮完整收到笔记对应的原文范围；旧进度、旧笔记和未送达结果不能替代。".into(),
            ));
        }
        drop(statement);
        let fragment: String = source
            .content
            .chars()
            .skip(input.start)
            .take(input.end - input.start)
            .collect();
        if (source.total_chars > 0 && input.quote.trim().is_empty())
            || !fragment.contains(&input.quote)
        {
            return Err(CoauthorError::Invalid(
                "分段笔记须有对应字符范围内的准确原文引句。".into(),
            ));
        }
        let current: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version),0) FROM coauthor_check_notes
             WHERE check_id=?1 AND source_key=?2 AND start=?3 AND end=?4",
            rusqlite::params![
                input.check_id.to_string(),
                input.key,
                sql_count(input.start)?,
                sql_count(input.end)?
            ],
            |row| row.get(0),
        )?;
        if current != input.expected_version {
            return Err(CoauthorError::Conflict);
        }
        // Different overlapping segments would leave two competing current analyses.
        if current==0 && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM coauthor_check_notes WHERE check_id=?1 AND source_key=?2
             AND start<?4 AND end>?3)",
            rusqlite::params![input.check_id.to_string(),input.key,sql_count(input.start)?,sql_count(input.end)?],
            |row| row.get::<_,bool>(0),
        )? {
            return Err(CoauthorError::Invalid("笔记范围与现有分段重叠；请按原范围和最新版本修订，或记录尚未覆盖的范围。".into()));
        }
        let note = CoauthorCheckNote {
            id: Uuid::new_v4(),
            run_id,
            start: input.start,
            end: input.end,
            version: current.checked_add(1).ok_or(CoauthorError::Conflict)?,
            analysis: input.analysis,
            questions: input.questions,
            quote: input.quote,
        };
        tx.execute(
            "INSERT INTO coauthor_check_notes(id,check_id,source_key,run_id,start,end,version,analysis,questions,quote)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![note.id.to_string(),input.check_id.to_string(),input.key,run_id.to_string(),
                sql_count(note.start)?,sql_count(note.end)?,note.version,note.analysis,note.questions,note.quote],
        )?;
        tx.commit()?;
        Ok(note)
    }
}

#[cfg(test)]
mod tests;
