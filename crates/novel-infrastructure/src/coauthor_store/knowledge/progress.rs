use super::*;
use crate::coauthor_store::source_checks::{count, optional_count, ranges, sql_count};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorEvidenceProgressEntry {
    pub anchor: CoauthorKnowledgeAnchor,
    pub total_chars: Option<usize>,
    pub read_chars: usize,
    pub sent_chars: usize,
    pub next_offset: usize,
    pub read_complete: bool,
    pub sent_complete: bool,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorEvidenceProgress {
    pub id: Option<Uuid>,
    pub knowledge_key: String,
    pub knowledge_revision: String,
    pub title: String,
    pub listed_anchors: usize,
    pub total_anchors: usize,
    pub validated_anchors: usize,
    pub read_anchors: usize,
    pub sent_anchors: usize,
    pub stale: bool,
    pub needs_review: bool,
    pub all_evidence_sent: bool,
    pub entries: Vec<CoauthorEvidenceProgressEntry>,
    pub offset: usize,
    pub next_offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorEvidenceRead {
    pub read_id: Uuid,
    #[serde(flatten)]
    pub evidence: CoauthorKnowledgeEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorEvidenceCheckSummary {
    pub knowledge_key: String,
    pub knowledge_revision: String,
    pub title: String,
    pub total_anchors: usize,
    pub validated_anchors: usize,
    pub read_anchors: usize,
    pub sent_anchors: usize,
    pub stale: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorEvidenceChecksPage {
    pub checks: Vec<CoauthorEvidenceCheckSummary>,
    pub has_more: bool,
}

impl Database {
    pub(crate) fn migrate_coauthor_evidence_progress(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_evidence_checks (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                source_key TEXT NOT NULL, revision TEXT NOT NULL, title TEXT NOT NULL,
                knowledge_status TEXT NOT NULL, listed_anchors INTEGER NOT NULL CHECK(listed_anchors>=0),
                UNIQUE(session_id,source_key,revision)
             );
             CREATE TABLE coauthor_evidence_entries (
                check_id TEXT NOT NULL REFERENCES coauthor_evidence_checks(id),
                anchor_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
                anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
                total_chars INTEGER CHECK(total_chars>0),
                read_chars INTEGER NOT NULL DEFAULT 0 CHECK(read_chars>=0),
                sent_chars INTEGER NOT NULL DEFAULT 0 CHECK(sent_chars>=0),
                next_offset INTEGER NOT NULL DEFAULT 0 CHECK(next_offset>=0),
                PRIMARY KEY(check_id,anchor_id)
             );
             CREATE INDEX coauthor_evidence_entries_page ON coauthor_evidence_entries(check_id,ordinal);
             CREATE TABLE coauthor_evidence_reads (
                id TEXT PRIMARY KEY, check_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
                run_id TEXT NOT NULL REFERENCES coauthor_runs(id),
                start INTEGER NOT NULL CHECK(start>=0), end INTEGER NOT NULL CHECK(end>=start),
                sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)),
                FOREIGN KEY(check_id,anchor_id) REFERENCES coauthor_evidence_entries(check_id,anchor_id)
             );
             CREATE INDEX coauthor_evidence_reads_entry ON coauthor_evidence_reads(check_id,anchor_id);
             INSERT INTO schema_migrations(version,name) VALUES(62,'coauthor_evidence_progress');",
        )?;
        tx.commit()?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn drop_coauthor_evidence_progress_fixture(&self) {
        self.connection.execute_batch(
            "DROP TABLE coauthor_evidence_reads; DROP TABLE coauthor_evidence_entries; DROP TABLE coauthor_evidence_checks;",
        ).unwrap();
    }

    fn evidence_check_id(&self, scope: &CoauthorScope, key: &str, revision: &str) -> Result<Option<Uuid>, CoauthorError> {
        Ok(self.connection.query_row(
            "SELECT id FROM coauthor_evidence_checks WHERE session_id=?1 AND source_key=?2 AND revision=?3",
            rusqlite::params![scope.session_id.to_string(),key,revision],
            |row| super::super::super::manuscript_source_store::row_uuid(row,0),
        ).optional()?)
    }

    fn ensure_evidence_check(&self, scope: &CoauthorScope, source: &CoauthorSource) -> Result<Uuid, CoauthorError> {
        if let Some(id) = self.evidence_check_id(scope, &source.key, &source.revision)? {
            return Ok(id);
        }
        let context = source.knowledge_context.as_ref().ok_or(CoauthorError::NotFound)?;
        let ids = self.coauthor_knowledge_anchor_ids(scope.project_id, &source.key)?;
        let (anchors, _) = self.knowledge_anchors(scope.project_id, &ids)?;
        let id = Uuid::new_v4();
        self.connection.execute(
            "INSERT INTO coauthor_evidence_checks VALUES(?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![id.to_string(),scope.session_id.to_string(),source.key,source.revision,
                source.title,context.status,sql_count(ids.len())?],
        )?;
        let mut seen = BTreeSet::new();
        for (ordinal, anchor) in anchors.into_iter().enumerate() {
            if seen.insert(anchor.id) {
                self.connection.execute(
                    "INSERT INTO coauthor_evidence_entries(check_id,anchor_id,ordinal,anchor_json) VALUES(?1,?2,?3,?4)",
                    rusqlite::params![id.to_string(),anchor.id.to_string(),sql_count(ordinal)?,encode(&anchor)?],
                )?;
            }
        }
        Ok(id)
    }

    fn refresh_evidence_progress(&self, id: Uuid, anchor: Uuid) -> Result<(), CoauthorError> {
        let mut stmt = self.connection.prepare(
            "SELECT start,end,sent FROM coauthor_evidence_reads WHERE check_id=?1 AND anchor_id=?2",
        )?;
        let reads = stmt.query_map(rusqlite::params![id.to_string(),anchor.to_string()],
            |row| Ok((count(row,0)?,count(row,1)?,row.get::<_,bool>(2)?)))?
            .collect::<Result<Vec<_>,_>>()?;
        let read = ranges(reads.iter().map(|(start,end,_)| (*start,*end)).collect());
        let sent = ranges(reads.iter().filter(|(_,_,sent)| *sent).map(|(start,end,_)| (*start,*end)).collect());
        let read_chars: usize = read.iter().map(|(start,end)| end-start).sum();
        let sent_chars: usize = sent.iter().map(|(start,end)| end-start).sum();
        let next = sent.first().filter(|(start,_)| *start==0).map_or(0,|(_,end)| *end);
        self.connection.execute(
            "UPDATE coauthor_evidence_entries SET read_chars=?3,sent_chars=?4,next_offset=?5 WHERE check_id=?1 AND anchor_id=?2",
            rusqlite::params![id.to_string(),anchor.to_string(),sql_count(read_chars)?,sql_count(sent_chars)?,sql_count(next)?],
        )?;
        Ok(())
    }
}

impl ProjectManager {
    pub fn list_coauthor_evidence_checks(
        &self, scope: &CoauthorScope, offset: usize,
    ) -> Result<CoauthorEvidenceChecksPage, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let _snapshot = db.connection.unchecked_transaction()?;
        self.validate_coauthor_scope(scope)?;
        let mut stmt = db.connection.prepare(
            "SELECT c.id,c.source_key,c.revision,c.title,
                s.revision IS NULL OR s.revision<>c.revision OR EXISTS(
                    SELECT 1 FROM coauthor_source_queue q
                    WHERE q.kind=substr(c.source_key,1,instr(c.source_key,':')-1)
                    AND q.source_id=substr(c.source_key,instr(c.source_key,':')+1))
             FROM coauthor_evidence_checks c LEFT JOIN coauthor_sources s ON s.source_key=c.source_key
             WHERE c.session_id=?1 ORDER BY c.rowid DESC LIMIT 11 OFFSET ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![scope.session_id.to_string(),sql_count(offset)?],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,
                row.get::<_,String>(3)?,row.get::<_,bool>(4)?)))?
            .collect::<Result<Vec<_>,_>>()?;
        let has_more = rows.len()>10;
        let mut checks = Vec::new();
        for (id,key,revision,title,stale) in rows.into_iter().take(10) {
            let (total,validated,read,sent) = db.connection.query_row(
                "SELECT COUNT(*),COALESCE(SUM(total_chars IS NOT NULL),0),
                    COALESCE(SUM(read_chars=total_chars),0),COALESCE(SUM(sent_chars=total_chars),0)
                 FROM coauthor_evidence_entries WHERE check_id=?1", [id],
                |row| Ok((count(row,0)?,count(row,1)?,count(row,2)?,count(row,3)?)),
            )?;
            checks.push(CoauthorEvidenceCheckSummary {
                knowledge_key:key,knowledge_revision:revision,title,total_anchors:total,
                validated_anchors:validated,read_anchors:read,sent_anchors:sent,stale,
            });
        }
        Ok(CoauthorEvidenceChecksPage { checks,has_more })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn read_coauthor_knowledge_evidence_for_run(
        &mut self, scope: &CoauthorScope, run: Uuid, key: &str, revision: &str,
        anchor: Uuid, offset: usize, limit: usize,
    ) -> Result<CoauthorEvidenceRead, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let tx = db.connection.unchecked_transaction()?;
        if !self.coauthor_run_active(scope, run)? {
            return Err(CoauthorError::Conflict);
        }
        let evidence = self.load_coauthor_knowledge_evidence(scope, key, revision, anchor, offset, limit)?;
        let source = self.read_coauthor_source(scope, key, revision, 0, 1)?;
        let check = db.ensure_evidence_check(scope, &source)?;
        let read_id = Uuid::new_v4();
        if tx.execute(
            "UPDATE coauthor_evidence_entries SET total_chars=?3 WHERE check_id=?1 AND anchor_id=?2
             AND (total_chars IS NULL OR total_chars=?3)",
            rusqlite::params![check.to_string(),anchor.to_string(),sql_count(evidence.total_chars)?],
        )? != 1 {
            return Err(CoauthorError::Conflict);
        }
        tx.execute(
            "INSERT INTO coauthor_evidence_reads(id,check_id,anchor_id,run_id,start,end) VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![read_id.to_string(),check.to_string(),anchor.to_string(),run.to_string(),
                sql_count(evidence.offset)?,sql_count(evidence.next_offset)?],
        )?;
        db.refresh_evidence_progress(check, anchor)?;
        tx.commit()?;
        Ok(CoauthorEvidenceRead { read_id, evidence })
    }

    /// Only the runner calls this after a successful provider turn containing these receipts.
    pub fn acknowledge_coauthor_evidence_reads(
        &mut self, scope: &CoauthorScope, run: Uuid, ids: &[Uuid],
    ) -> Result<(), CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let tx = db.connection.unchecked_transaction()?;
        if !self.coauthor_run_active(scope, run)? {
            return Err(CoauthorError::Conflict);
        }
        let mut entries = BTreeSet::new();
        for id in ids {
            if tx.execute(
                "UPDATE coauthor_evidence_reads SET sent=1 WHERE id=?1 AND run_id=?2 AND check_id IN
                 (SELECT id FROM coauthor_evidence_checks WHERE session_id=?3)",
                rusqlite::params![id.to_string(),run.to_string(),scope.session_id.to_string()],
            )? != 1 {
                return Err(CoauthorError::NotFound);
            }
            let entry = tx.query_row(
                "SELECT check_id,anchor_id FROM coauthor_evidence_reads WHERE id=?1", [id.to_string()],
                |row| Ok((super::super::super::manuscript_source_store::row_uuid(row,0)?,
                    super::super::super::manuscript_source_store::row_uuid(row,1)?)),
            )?;
            entries.insert(entry);
        }
        for (check, anchor) in entries {
            db.refresh_evidence_progress(check, anchor)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn coauthor_knowledge_evidence_progress(
        &self, scope: &CoauthorScope, key: &str, revision: &str, offset: usize,
    ) -> Result<CoauthorEvidenceProgress, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let _snapshot = db.connection.unchecked_transaction()?;
        self.validate_coauthor_scope(scope)?;
        if !matches!(key.split_once(':').map(|(kind,_)|kind), Some("FACT"|"RELATION")) {
            return Err(CoauthorError::Invalid("证据进度需要事实或关系的准确身份与修订。".into()));
        }
        let id = db.evidence_check_id(scope, key, revision)?;
        let current = db.coauthor_source(key)?.filter(|source| source.knowledge_context.as_ref()
            .is_some_and(|context|context.project_id==scope.project_id));
        let stale = current.as_ref().is_none_or(|source|source.revision!=revision);
        let needs_review = stale || current.as_ref().and_then(|source|source.knowledge_context.as_ref())
            .is_none_or(|context|context.status!="CURRENT");
        if let Some(id) = id {
            let (title,listed): (String,usize) = db.connection.query_row(
                "SELECT title,listed_anchors FROM coauthor_evidence_checks WHERE id=?1", [id.to_string()],
                |row| Ok((row.get(0)?,count(row,1)?)),
            )?;
            let (total,validated,read,sent) = db.connection.query_row(
                "SELECT COUNT(*),COALESCE(SUM(total_chars IS NOT NULL),0),
                    COALESCE(SUM(read_chars=total_chars),0),COALESCE(SUM(sent_chars=total_chars),0)
                 FROM coauthor_evidence_entries WHERE check_id=?1", [id.to_string()],
                |row| Ok((count(row,0)?,count(row,1)?,count(row,2)?,count(row,3)?)),
            )?;
            if offset>total { return Err(CoauthorError::Invalid("证据进度位置超出范围。".into())); }
            let mut stmt = db.connection.prepare(
                "SELECT anchor_json,total_chars,read_chars,sent_chars,next_offset
                 FROM coauthor_evidence_entries WHERE check_id=?1 ORDER BY ordinal LIMIT 16 OFFSET ?2",
            )?;
            let entries = stmt.query_map(rusqlite::params![id.to_string(),sql_count(offset)?], |row| {
                Ok((row.get::<_,String>(0)?,optional_count(row,1)?,count(row,2)?,count(row,3)?,count(row,4)?))
            })?.map(|row| {
                let (json,total_chars,read_chars,sent_chars,next_offset) = row?;
                Ok(CoauthorEvidenceProgressEntry {
                    anchor: decode(json)?, total_chars, read_chars, sent_chars, next_offset,
                    read_complete: total_chars==Some(read_chars), sent_complete: total_chars==Some(sent_chars),
                })
            }).collect::<Result<Vec<_>,CoauthorError>>()?;
            let next_offset = offset+entries.len();
            return Ok(CoauthorEvidenceProgress {
                id:Some(id),knowledge_key:key.into(),knowledge_revision:revision.into(),title,
                listed_anchors:listed,total_anchors:total,validated_anchors:validated,read_anchors:read,
                sent_anchors:sent,stale,needs_review,all_evidence_sent:total>0 && sent==total && !needs_review,
                entries,offset,next_offset,
            });
        }
        if stale { return Err(CoauthorError::Conflict); }
        let source = current.ok_or(CoauthorError::NotFound)?;
        let ids = db.coauthor_knowledge_anchor_ids(scope.project_id,key)?;
        let (anchors,_) = db.knowledge_anchors(scope.project_id,&ids)?;
        let mut seen = BTreeSet::new();
        let anchors: Vec<_> = anchors.into_iter().filter(|anchor|seen.insert(anchor.id)).collect();
        let total = anchors.len();
        if offset>total { return Err(CoauthorError::Invalid("证据进度位置超出范围。".into())); }
        let entries: Vec<_> = anchors.into_iter().skip(offset).take(16).map(|anchor|CoauthorEvidenceProgressEntry {
            anchor,total_chars:None,read_chars:0,sent_chars:0,next_offset:0,read_complete:false,sent_complete:false,
        }).collect();
        Ok(CoauthorEvidenceProgress {
            id:None,knowledge_key:key.into(),knowledge_revision:revision.into(),title:source.title,
            listed_anchors:ids.len(),total_anchors:total,validated_anchors:0,read_anchors:0,sent_anchors:0,
            stale:false,needs_review,all_evidence_sent:false,next_offset:offset+entries.len(),entries,offset,
        })
    }
}
