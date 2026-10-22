use super::*;

impl Database {
    pub(crate) fn migrate_coauthor(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS coauthor_documents (
                session_id TEXT PRIMARY KEY REFERENCES discussion_sessions(id),
                version INTEGER NOT NULL CHECK(version > 0),
                payload TEXT NOT NULL CHECK(json_valid(payload))
            );
            CREATE TABLE IF NOT EXISTS coauthor_document_revisions (
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                version INTEGER NOT NULL,
                payload TEXT NOT NULL CHECK(json_valid(payload)),
                PRIMARY KEY(session_id, version)
            );
            CREATE TABLE IF NOT EXISTS coauthor_decisions (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                topic TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('CHOSEN','REJECTED','OPEN','WITHDRAWN')),
                source_message_id TEXT NOT NULL REFERENCES discussion_messages(id),
                version INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS coauthor_decisions_session ON coauthor_decisions(session_id, topic);
            CREATE TABLE IF NOT EXISTS coauthor_decision_revisions (
                decision_id TEXT NOT NULL, version INTEGER NOT NULL,
                payload TEXT NOT NULL CHECK(json_valid(payload)),
                PRIMARY KEY(decision_id, version)
            );
            CREATE TABLE IF NOT EXISTS coauthor_runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                user_message_id TEXT NOT NULL REFERENCES discussion_messages(id),
                status TEXT NOT NULL,
                document_version INTEGER NOT NULL,
                output TEXT NOT NULL DEFAULT '',
                audit TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(audit)),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS coauthor_runs_session ON coauthor_runs(session_id, created_at);
            CREATE TABLE IF NOT EXISTS coauthor_cancellations (
                run_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id)
            );
            CREATE TABLE IF NOT EXISTS coauthor_publications (
                session_id TEXT NOT NULL, document_version INTEGER NOT NULL,
                source_key TEXT NOT NULL, PRIMARY KEY(session_id,document_version)
            );
            CREATE TABLE IF NOT EXISTS coauthor_branches (
                session_id TEXT PRIMARY KEY REFERENCES discussion_sessions(id),
                parent_session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                parent_document_version INTEGER NOT NULL
            );
            ",
        )?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS coauthor_source_queue (
                kind TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(kind, source_id)
            );
            CREATE TABLE IF NOT EXISTS coauthor_sources (
                source_key TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                revision TEXT NOT NULL,
                content TEXT NOT NULL,
                session_id TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS coauthor_fts USING fts5(
                source_key UNINDEXED, terms, tokenize='unicode61'
            );
            INSERT OR IGNORE INTO coauthor_source_queue SELECT 'ENTITY', id FROM entities;
            INSERT OR IGNORE INTO coauthor_source_queue SELECT 'PLAN', id FROM planning_sections;
            INSERT OR IGNORE INTO coauthor_source_queue SELECT 'MANUSCRIPT', id FROM chapters;
            INSERT OR IGNORE INTO coauthor_source_queue SELECT 'CARD', id FROM writing_cards;
            INSERT OR IGNORE INTO coauthor_source_queue SELECT 'MESSAGE', id FROM discussion_messages;
            INSERT OR IGNORE INTO coauthor_source_queue SELECT 'SUMMARY', id FROM summary_materials;",
        )?;
        // Triggers enqueue identities only. Reading and tokenizing unchanged books
        // is never part of a normal conversation turn.
        for (table, kind, key) in [
            ("entities", "ENTITY", "id"),
            ("author_settings", "ENTITY", "entity_id"),
            ("planning_sections", "PLAN", "id"),
            ("manuscript_revisions", "MANUSCRIPT", "chapter_id"),
            ("writing_cards", "CARD", "id"),
            ("discussion_messages", "MESSAGE", "id"),
            ("summary_materials", "SUMMARY", "id"),
        ] {
            for (event, record) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
                tx.execute_batch(&format!(
                    "CREATE TRIGGER IF NOT EXISTS coauthor_dirty_{table}_{event}
                     AFTER {event} ON {table} BEGIN
                     INSERT INTO coauthor_source_queue SELECT '{kind}', {record}.{key}
                     WHERE NOT EXISTS(SELECT 1 FROM coauthor_source_queue
                        WHERE kind='{kind}' AND source_id={record}.{key});
                     END;"
                ))?;
            }
        }
        tx.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS coauthor_dirty_plan_update AFTER UPDATE ON plan_nodes BEGIN
                INSERT INTO coauthor_source_queue SELECT 'MANUSCRIPT', NEW.id
                    WHERE NOT EXISTS(SELECT 1 FROM coauthor_source_queue WHERE kind='MANUSCRIPT' AND source_id=NEW.id);
                INSERT INTO coauthor_source_queue SELECT 'PLAN', 'plan-node:' || NEW.id
                    WHERE NOT EXISTS(SELECT 1 FROM coauthor_source_queue WHERE kind='PLAN' AND source_id='plan-node:' || NEW.id);
            END;
            INSERT INTO schema_migrations (version, name) VALUES (52, 'coauthor_workspace');",
        )?;
        tx.commit()?;
        Ok(())
    }
}
