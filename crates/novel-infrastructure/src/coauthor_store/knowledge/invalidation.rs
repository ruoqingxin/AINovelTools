use super::*;

impl Database {
    pub(crate) fn migrate_coauthor_knowledge_checks(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_knowledge_anchor_refs (
                kind TEXT NOT NULL CHECK(kind IN ('FACT','RELATION')),
                source_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
                PRIMARY KEY(kind,source_id,anchor_id)
             );
             CREATE INDEX coauthor_knowledge_refs_anchor
                ON coauthor_knowledge_anchor_refs(anchor_id,kind,source_id);
             CREATE INDEX coauthor_evidence_chapter ON evidence_anchors(chapter_id,id);
             CREATE TABLE coauthor_knowledge_index_status (
                source_key TEXT PRIMARY KEY, status TEXT NOT NULL
                    CHECK(status IN ('CURRENT','NEEDS_REVIEW'))
             );
             INSERT OR IGNORE INTO coauthor_knowledge_anchor_refs
                SELECT 'FACT',f.knowledge_id,a.value FROM facts f,json_each(f.evidence_anchor_ids_json) a;
             INSERT OR IGNORE INTO coauthor_knowledge_anchor_refs
                SELECT 'RELATION',r.id,a.value FROM relations r,json_each(r.evidence_anchor_ids_json) a;
             CREATE TRIGGER coauthor_knowledge_queue_relations AFTER INSERT ON coauthor_source_queue
                WHEN NEW.kind='FACT' BEGIN
                INSERT OR IGNORE INTO coauthor_source_queue
                    SELECT 'RELATION',r.id FROM (
                        SELECT id FROM relations WHERE from_knowledge_id=NEW.source_id
                        UNION SELECT id FROM relations WHERE to_knowledge_id=NEW.source_id
                    ) r WHERE NOT EXISTS(SELECT 1 FROM coauthor_source_queue q
                        WHERE q.kind='RELATION' AND q.source_id=r.id);
             END;",
        )?;
        // Native versions are immutable. Keep historical anchor associations conservatively:
        // an old anchor may enqueue its owner, but cannot change its current revision or verdict.
        for (table, kind, id) in [("facts", "FACT", "knowledge_id"), ("relations", "RELATION", "id")] {
            tx.execute_batch(&format!(
                "CREATE TRIGGER coauthor_knowledge_refs_{table} AFTER INSERT ON {table} BEGIN
                    INSERT OR IGNORE INTO coauthor_knowledge_anchor_refs
                        SELECT '{kind}',NEW.{id},a.value FROM json_each(NEW.evidence_anchor_ids_json) a
                        WHERE NOT EXISTS(SELECT 1 FROM coauthor_knowledge_anchor_refs r
                            WHERE r.kind='{kind}' AND r.source_id=NEW.{id} AND r.anchor_id=a.value);
                 END;"
            ))?;
        }
        for (event, record) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            tx.execute_batch(&format!(
                "CREATE TRIGGER coauthor_knowledge_evidence_{event} AFTER {event} ON evidence_anchors BEGIN
                    INSERT OR IGNORE INTO coauthor_source_queue
                        SELECT r.kind,r.source_id FROM coauthor_knowledge_anchor_refs r
                        WHERE r.anchor_id={record}.id AND NOT EXISTS(
                            SELECT 1 FROM coauthor_source_queue q
                            WHERE q.kind=r.kind AND q.source_id=r.source_id);
                 END;"
            ))?;
            for (table, chapter, event_clause) in [
                ("manuscript_revisions", "chapter_id", event),
                ("plan_nodes", "id", if event == "UPDATE" { "UPDATE OF archived" } else { event }),
            ] {
                tx.execute_batch(&format!(
                    "CREATE TRIGGER coauthor_knowledge_{table}_{event}
                     AFTER {event_clause} ON {table} BEGIN
                        INSERT OR IGNORE INTO coauthor_source_queue
                            SELECT DISTINCT r.kind,r.source_id FROM evidence_anchors a
                            JOIN coauthor_knowledge_anchor_refs r ON r.anchor_id=a.id
                            WHERE a.chapter_id={record}.{chapter} AND NOT EXISTS(
                                SELECT 1 FROM coauthor_source_queue q
                                WHERE q.kind=r.kind AND q.source_id=r.source_id);
                     END;"
                ))?;
            }
        }
        tx.execute_batch(
            "INSERT OR IGNORE INTO coauthor_source_queue SELECT 'FACT',knowledge_id FROM fact_current_versions;
             INSERT OR IGNORE INTO coauthor_source_queue SELECT 'RELATION',id FROM relations;
             INSERT INTO schema_migrations(version,name) VALUES(60,'coauthor_knowledge_checks');",
        )?;
        tx.commit()?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn drop_coauthor_knowledge_checks_fixture(&self) {
        self.connection.execute_batch("DROP TABLE coauthor_decision_consumers; DROP TABLE coauthor_changeset_dependency_coverage;
            DROP TABLE coauthor_branch_decision_adoptions; DROP TABLE coauthor_branch_merges;").unwrap();
        self.drop_coauthor_evidence_progress_fixture();
        let triggers = self.connection.prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'coauthor_knowledge_%'",
        ).unwrap().query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        for trigger in triggers {
            self.connection.execute_batch(&format!("DROP TRIGGER \"{}\"", trigger.replace('"', "\"\""))).unwrap();
        }
        self.connection.execute_batch(
            "DROP TABLE coauthor_knowledge_anchor_refs; DROP TABLE coauthor_knowledge_index_status;
             DROP INDEX coauthor_evidence_chapter;",
        ).unwrap();
    }
}
