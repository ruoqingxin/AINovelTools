use super::*;

impl Database {
    /// Opens or creates a SQLite database at `path` and applies the schema.
    ///
    /// # Errors
    ///
    /// Returns [`DatabaseError`] when the directory, SQLite connection, or
    /// migration cannot be initialized.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| DatabaseError::MissingParent(path.to_path_buf()))?;
        } else {
            return Err(DatabaseError::MissingParent(path.to_path_buf()));
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    /// Creates an isolated in-memory SQLite database for app bootstrap and tests.
    ///
    /// # Errors
    ///
    /// Returns [`DatabaseError`] when SQLite cannot initialize or migrate the
    /// connection.
    pub fn in_memory() -> Result<Self, DatabaseError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, DatabaseError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5000)?;
        let database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&self) -> Result<(), DatabaseError> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
            )
            .map_err(DatabaseError::from)?;
        let applied: Option<i64> =
            self.connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, Option<i64>>(0)
                })?;
        if applied.unwrap_or(0) < 1 {
            self.connection.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (1, 'initial_core')",
                [],
            )?;
        }
        if applied.unwrap_or(0) < 2 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS plan_nodes (
                    id TEXT PRIMARY KEY NOT NULL,
                    parent_id TEXT REFERENCES plan_nodes(id),
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_plan_nodes_parent_order
                    ON plan_nodes(parent_id, sort_order, created_at);
                INSERT INTO schema_migrations (version, name) VALUES (2, 'plan_nodes');",
            )?;
        }
        if applied.unwrap_or(0) < 3 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS plan_node_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    node_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    revision INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    archived INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(node_id, revision)
                );
                INSERT INTO schema_migrations (version, name) VALUES (3, 'plan_node_revisions');",
            )?;
        }
        if applied.unwrap_or(0) < 4 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS manuscript_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    parent_revision_id TEXT REFERENCES manuscript_revisions(id),
                    document_json TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    creation_reason TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    document_schema_version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_manuscript_revisions_chapter
                    ON manuscript_revisions(chapter_id, created_at);
                INSERT INTO schema_migrations (version, name) VALUES (4, 'manuscript_revisions');",
            )?;
        }
        if applied.unwrap_or(0) < 5 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS plan_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    node_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    revision INTEGER NOT NULL,
                    parent_revision_id TEXT REFERENCES plan_revisions(id),
                    title TEXT NOT NULL,
                    archived INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(node_id, revision)
                );
                CREATE TABLE IF NOT EXISTS recovery_logs (
                    id TEXT PRIMARY KEY NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    document_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE TRIGGER IF NOT EXISTS prevent_manuscript_revision_update
                    BEFORE UPDATE ON manuscript_revisions BEGIN SELECT RAISE(ABORT, 'immutable manuscript revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_manuscript_revision_delete
                    BEFORE DELETE ON manuscript_revisions BEGIN SELECT RAISE(ABORT, 'immutable manuscript revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_plan_revision_update
                    BEFORE UPDATE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'immutable plan revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_plan_revision_delete
                    BEFORE DELETE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'immutable plan revision'); END;
                INSERT INTO schema_migrations (version, name) VALUES (5, 'immutable_revisions_and_recovery');",
            )?;
        }
        if applied.unwrap_or(0) < 6 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS chapters (
                    id TEXT PRIMARY KEY NOT NULL,
                    plan_node_id TEXT NOT NULL UNIQUE REFERENCES plan_nodes(id),
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                INSERT OR IGNORE INTO chapters (id, plan_node_id, title)
                    SELECT id, id, title FROM plan_nodes WHERE kind = 'CHAPTER';
                INSERT INTO schema_migrations (version, name) VALUES (6, 'separate_chapter_entities');",
            )?;
        }
        if applied.unwrap_or(0) < 7 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS model_profiles (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    context_window INTEGER NOT NULL,
                    max_output_tokens INTEGER NOT NULL,
                    privacy_level TEXT NOT NULL,
                    timeout_seconds INTEGER NOT NULL,
                    retry_limit INTEGER NOT NULL,
                    secret_ref TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE TABLE IF NOT EXISTS ai_tasks (
                    id TEXT PRIMARY KEY NOT NULL,
                    profile_id TEXT NOT NULL REFERENCES model_profiles(id),
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    action TEXT NOT NULL,
                    target_revision_id TEXT REFERENCES manuscript_revisions(id),
                    context_version TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    finished_at TEXT
                );
                CREATE TABLE IF NOT EXISTS ai_proposals (
                    id TEXT PRIMARY KEY NOT NULL,
                    task_id TEXT NOT NULL UNIQUE REFERENCES ai_tasks(id),
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    action TEXT NOT NULL,
                    target_revision_id TEXT REFERENCES manuscript_revisions(id),
                    context_version TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    output_text TEXT NOT NULL,
                    accepted_text TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    decided_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_ai_proposals_chapter_created
                    ON ai_proposals(chapter_id, created_at DESC);
                CREATE TRIGGER IF NOT EXISTS prevent_ai_proposal_identity_update
                    BEFORE UPDATE OF task_id, chapter_id, action, target_revision_id, context_version, prompt_version, output_text, created_at
                    ON ai_proposals BEGIN SELECT RAISE(ABORT, 'immutable ai proposal identity'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_ai_proposal_delete
                    BEFORE DELETE ON ai_proposals BEGIN SELECT RAISE(ABORT, 'immutable ai proposal'); END;
                INSERT INTO schema_migrations (version, name) VALUES (7, 'r3_ai_creation_loop');",
            )?;
        }
        if applied.unwrap_or(0) < 8 {
            self.connection.execute_batch(
                "ALTER TABLE model_profiles ADD COLUMN capability TEXT NOT NULL DEFAULT 'CHAT';
                UPDATE model_profiles SET capability = 'EMBEDDING' WHERE provider = 'SILICON_FLOW';
                INSERT INTO schema_migrations (version, name) VALUES (8, 'model_capabilities');",
            )?;
        }
        if applied.unwrap_or(0) < 9 {
            self.connection.execute_batch(
                "ALTER TABLE ai_tasks ADD COLUMN task_contract_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(task_contract_json));
                ALTER TABLE ai_tasks ADD COLUMN context_section_audit_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context_section_audit_json));
                INSERT INTO schema_migrations (version, name) VALUES (9, 'ai_task_contract_audit');",
            )?;
        }
        if applied.unwrap_or(0) < 10 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS project_settings (
                    project_id TEXT PRIMARY KEY NOT NULL DEFAULT 'current',
                    writing_style TEXT NOT NULL DEFAULT '',
                    privacy_level TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
                    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                INSERT OR IGNORE INTO project_settings (project_id) VALUES ('current');
                INSERT INTO schema_migrations (version, name) VALUES (10, 'r4_project_settings_baseline');",
            )?;
        }
        if applied.unwrap_or(0) < 11 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    entity_type TEXT NOT NULL CHECK(entity_type IN ('CHARACTER','LOCATION','FACTION','ITEM','CONCEPT')),
                    lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle_status IN ('ACTIVE','ARCHIVED')),
                    current_revision_id TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_entities_project_type_status
                    ON entities(project_id, entity_type, lifecycle_status, updated_at DESC);
                CREATE TABLE IF NOT EXISTS entity_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    entity_id TEXT NOT NULL REFERENCES entities(id),
                    revision INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases_json)),
                    description TEXT NOT NULL DEFAULT '',
                    fixed_attributes_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fixed_attributes_json) AND json_type(fixed_attributes_json) = 'object'),
                    tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
                    base_revision_id TEXT REFERENCES entity_revisions(id),
                    source_version TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(entity_id, revision)
                );
                CREATE INDEX IF NOT EXISTS idx_entity_revisions_entity_created
                    ON entity_revisions(entity_id, revision DESC, created_at DESC);
                CREATE TRIGGER IF NOT EXISTS prevent_entity_revision_update
                    BEFORE UPDATE ON entity_revisions BEGIN SELECT RAISE(ABORT, 'immutable entity revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_entity_revision_delete
                    BEFORE DELETE ON entity_revisions BEGIN SELECT RAISE(ABORT, 'immutable entity revision'); END;
                INSERT INTO schema_migrations (version, name) VALUES (11, 'r4_story_bible_entities');",
            )?;
        }
        if applied.unwrap_or(0) < 12 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS summary_materials (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('CHAPTER','CHARACTER','SETTING')),
                    precision TEXT NOT NULL CHECK(precision IN ('L0','L1','L2','L3','L4','L5')),
                    source_id TEXT,
                    source_version TEXT,
                    content TEXT NOT NULL,
                    generation_mode TEXT NOT NULL DEFAULT 'MANUAL',
                    lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE',
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(project_id, kind, precision, source_id)
                );
                CREATE TABLE IF NOT EXISTS writing_cards (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    card_type TEXT NOT NULL CHECK(card_type IN ('STYLE_RULE','TECHNIQUE')),
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source_version TEXT,
                    scope TEXT NOT NULL DEFAULT 'PROJECT',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_summary_materials_project ON summary_materials(project_id, kind, precision);
                CREATE INDEX IF NOT EXISTS idx_writing_cards_project ON writing_cards(project_id, card_type, enabled, sort_order);
                INSERT INTO schema_migrations (version, name) VALUES (12, 'r4_summary_and_writing_cards');",
            )?;
        }
        if applied.unwrap_or(0) < 13 {
            self.connection.execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                    object_type UNINDEXED,
                    object_id UNINDEXED,
                    project_id UNINDEXED,
                    source_version UNINDEXED,
                    content,
                    tokenize = 'trigram'
                );
                INSERT INTO schema_migrations (version, name) VALUES (13, 'r4_fts5_projection');",
            )?;
        }
        if applied.unwrap_or(0) < 14 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY NOT NULL,
                    job_type TEXT NOT NULL CHECK(job_type IN ('BACKUP','RESTORE_VERIFY','HEALTH_SCAN','REBUILD_SEARCH_INDEX')),
                    payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
                    status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
                    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    error_summary TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at);
                INSERT INTO schema_migrations (version, name) VALUES (14, 'r4_persistent_jobs');",
            )?;
        }
        if applied.unwrap_or(0) < 15 {
            // R4 reliability artifacts live outside SQLite; this migration
            // closes the schema ledger for the already-implemented backup,
            // health, recovery, and diagnostics contract.
            self.connection.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (15, 'r4_backup_health_diagnostics')",
                [],
            )?;
        }
        if applied.unwrap_or(0) < 16 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS knowledge_candidates (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    proposal_id TEXT REFERENCES ai_proposals(id),
                    knowledge_id TEXT NOT NULL,
                    knowledge_version INTEGER NOT NULL CHECK(knowledge_version > 0),
                    subject TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object TEXT NOT NULL,
                    source_revision_id TEXT NOT NULL REFERENCES manuscript_revisions(id),
                    evidence_anchor_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_anchor_ids_json)),
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    candidate_status TEXT NOT NULL CHECK(candidate_status IN ('PENDING','NEEDS_REVIEW','APPROVED','REJECTED','FINALIZED')),
                    review_decision TEXT CHECK(review_decision IS NULL OR review_decision IN ('APPROVE','REJECT','NEEDS_REVIEW')),
                    reviewer TEXT,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_project_chapter_status
                    ON knowledge_candidates(project_id, chapter_id, candidate_status, updated_at DESC);
                INSERT INTO schema_migrations (version, name) VALUES (16, 'r5_knowledge_candidates');",
            )?;
        }
        if applied.unwrap_or(0) < 17 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS evidence_anchors (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    source_revision_id TEXT NOT NULL REFERENCES manuscript_revisions(id),
                    block_id TEXT NOT NULL,
                    start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
                    end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
                    source_version TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_evidence_anchors_source
                    ON evidence_anchors(project_id, chapter_id, source_revision_id, lifecycle_status);
                CREATE TRIGGER IF NOT EXISTS prevent_evidence_anchor_identity_update
                    BEFORE UPDATE OF id, project_id, chapter_id, source_revision_id, block_id, start_offset, end_offset, source_version, source_hash, created_at
                    ON evidence_anchors BEGIN SELECT RAISE(ABORT, 'immutable evidence anchor identity'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_evidence_anchor_delete
                    BEFORE DELETE ON evidence_anchors BEGIN SELECT RAISE(ABORT, 'immutable evidence anchor'); END;
                INSERT INTO schema_migrations (version, name) VALUES (17, 'r5_evidence_anchors');",
            )?;
        }
        if applied.unwrap_or(0) < 18 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS facts (
                    knowledge_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    knowledge_version INTEGER NOT NULL CHECK(knowledge_version > 0),
                    subject TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object TEXT NOT NULL,
                    source_revision_id TEXT NOT NULL REFERENCES manuscript_revisions(id),
                    evidence_anchor_ids_json TEXT NOT NULL CHECK(json_valid(evidence_anchor_ids_json)),
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    PRIMARY KEY(knowledge_id, knowledge_version)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_current_version
                    ON facts(knowledge_id) WHERE lifecycle_status = 'ACTIVE';
                CREATE INDEX IF NOT EXISTS idx_facts_project_status
                    ON facts(project_id, lifecycle_status, updated_at DESC);
                CREATE TRIGGER IF NOT EXISTS prevent_fact_update
                    BEFORE UPDATE ON facts BEGIN SELECT RAISE(ABORT, 'immutable fact version'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_fact_delete
                    BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT, 'immutable fact version'); END;
                INSERT INTO schema_migrations (version, name) VALUES (18, 'r5_facts');",
            )?;
        }
        if applied.unwrap_or(0) < 19 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS change_sets (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    source_revision_id TEXT NOT NULL REFERENCES manuscript_revisions(id),
                    status TEXT NOT NULL CHECK(status IN ('DRAFT','IN_REVIEW','BLOCKED','FINALIZED','REJECTED')),
                    candidate_ids_json TEXT NOT NULL CHECK(json_valid(candidate_ids_json)),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE TABLE IF NOT EXISTS change_set_items (
                    id TEXT PRIMARY KEY NOT NULL,
                    change_set_id TEXT NOT NULL REFERENCES change_sets(id),
                    candidate_id TEXT NOT NULL REFERENCES knowledge_candidates(id),
                    decision TEXT CHECK(decision IS NULL OR decision IN ('APPROVE','REJECT','NEEDS_REVIEW')),
                    conflict_code TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(change_set_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS knowledge_audit_records (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    change_set_id TEXT REFERENCES change_sets(id),
                    candidate_id TEXT REFERENCES knowledge_candidates(id),
                    action TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE TABLE IF NOT EXISTS knowledge_outbox_events (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    aggregate_type TEXT NOT NULL,
                    aggregate_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
                    published_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_change_sets_project_chapter_status
                    ON change_sets(project_id, chapter_id, status, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_knowledge_audit_project_created
                    ON knowledge_audit_records(project_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_unpublished
                    ON knowledge_outbox_events(published_at, created_at);
                CREATE TRIGGER IF NOT EXISTS prevent_change_set_identity_update
                    BEFORE UPDATE OF id, project_id, chapter_id, source_revision_id, created_at
                    ON change_sets BEGIN SELECT RAISE(ABORT, 'immutable change set identity'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_knowledge_audit_update
                    BEFORE UPDATE ON knowledge_audit_records BEGIN SELECT RAISE(ABORT, 'immutable knowledge audit'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_knowledge_audit_delete
                    BEFORE DELETE ON knowledge_audit_records BEGIN SELECT RAISE(ABORT, 'immutable knowledge audit'); END;
                INSERT INTO schema_migrations (version, name) VALUES (19, 'r5_change_sets_audit_outbox');",
            )?;
        }
        if applied.unwrap_or(0) < 20 {
            self.connection.execute_batch(
                "DROP INDEX IF EXISTS idx_facts_current_version;
                CREATE TABLE IF NOT EXISTS fact_current_versions (
                    knowledge_id TEXT PRIMARY KEY NOT NULL,
                    knowledge_version INTEGER NOT NULL,
                    UNIQUE(knowledge_id, knowledge_version)
                );
                INSERT INTO schema_migrations (version, name) VALUES (20, 'r5_fact_current_pointer');",
            )?;
        }
        if applied.unwrap_or(0) < 21 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS knowledge_versions (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK(version > 0),
                    fact_refs_json TEXT NOT NULL CHECK(json_valid(fact_refs_json)),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(project_id, version)
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_versions_project
                    ON knowledge_versions(project_id, version DESC);
                INSERT INTO schema_migrations (version, name) VALUES (21, 'r5_knowledge_versions');",
            )?;
        }
        if applied.unwrap_or(0) < 22 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS world_states (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL,
                    knowledge_version_id TEXT NOT NULL REFERENCES knowledge_versions(id),
                    entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(project_id, knowledge_version_id)
                );
                CREATE INDEX IF NOT EXISTS idx_world_states_project_created
                    ON world_states(project_id, created_at DESC);
                INSERT INTO schema_migrations (version, name) VALUES (22, 'r5_world_state_projection');",
            )?;
        }
        if applied.unwrap_or(0) < 23 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS relations (
                    id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    relation_version INTEGER NOT NULL CHECK(relation_version > 0),
                    from_knowledge_id TEXT NOT NULL,
                    to_knowledge_id TEXT NOT NULL,
                    relation_type TEXT NOT NULL,
                    evidence_anchor_ids_json TEXT NOT NULL CHECK(json_valid(evidence_anchor_ids_json)),
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    PRIMARY KEY(id, relation_version)
                );
                CREATE TRIGGER IF NOT EXISTS prevent_relation_update
                    BEFORE UPDATE ON relations BEGIN SELECT RAISE(ABORT, 'immutable relation version'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_relation_delete
                    BEFORE DELETE ON relations BEGIN SELECT RAISE(ABORT, 'immutable relation version'); END;
                INSERT INTO schema_migrations (version, name) VALUES (23, 'r5_relations');",
            )?;
        }
        if applied.unwrap_or(0) < 24 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS events (
                    id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    event_version INTEGER NOT NULL CHECK(event_version > 0),
                    name TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    participant_fact_ids_json TEXT NOT NULL CHECK(json_valid(participant_fact_ids_json)),
                    evidence_anchor_ids_json TEXT NOT NULL CHECK(json_valid(evidence_anchor_ids_json)),
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    PRIMARY KEY(id, event_version)
                );
                CREATE TRIGGER IF NOT EXISTS prevent_event_update
                    BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable event version'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_event_delete
                    BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable event version'); END;
                INSERT INTO schema_migrations (version, name) VALUES (24, 'r5_events');",
            )?;
        }
        if applied.unwrap_or(0) < 25 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS beliefs (
                    id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    belief_version INTEGER NOT NULL CHECK(belief_version > 0),
                    holder_knowledge_id TEXT NOT NULL,
                    proposition TEXT NOT NULL,
                    evidence_anchor_ids_json TEXT NOT NULL CHECK(json_valid(evidence_anchor_ids_json)),
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    PRIMARY KEY(id, belief_version)
                );
                CREATE TRIGGER IF NOT EXISTS prevent_belief_update
                    BEFORE UPDATE ON beliefs BEGIN SELECT RAISE(ABORT, 'immutable belief version'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_belief_delete
                    BEFORE DELETE ON beliefs BEGIN SELECT RAISE(ABORT, 'immutable belief version'); END;
                INSERT INTO schema_migrations (version, name) VALUES (25, 'r5_beliefs');",
            )?;
        }
        if applied.unwrap_or(0) < 26 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS foreshadowings (
                    id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    foreshadowing_version INTEGER NOT NULL CHECK(foreshadowing_version > 0),
                    title TEXT NOT NULL,
                    target_chapter_id TEXT REFERENCES chapters(id),
                    status TEXT NOT NULL,
                    evidence_anchor_ids_json TEXT NOT NULL CHECK(json_valid(evidence_anchor_ids_json)),
                    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('ACTIVE','NEEDS_REVIEW','ARCHIVED')),
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    PRIMARY KEY(id, foreshadowing_version)
                );
                CREATE TRIGGER IF NOT EXISTS prevent_foreshadowing_update
                    BEFORE UPDATE ON foreshadowings BEGIN SELECT RAISE(ABORT, 'immutable foreshadowing version'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_foreshadowing_delete
                    BEFORE DELETE ON foreshadowings BEGIN SELECT RAISE(ABORT, 'immutable foreshadowing version'); END;
                INSERT INTO schema_migrations (version, name) VALUES (26, 'r5_foreshadowings');",
            )?;
        }
        Ok(())
    }

    pub(super) fn list_plan_nodes(&self) -> Result<Vec<PlanNode>, DatabaseError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, parent_id, kind, title, sort_order, archived, revision
             FROM plan_nodes ORDER BY COALESCE(parent_id, ''), sort_order, created_at",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement.query_map([], |row| {
            let kind = match row.get::<_, String>(2)?.as_str() {
                "WORK_DESIGN" => PlanNodeKind::WorkDesign,
                "OUTLINE" => PlanNodeKind::Outline,
                "VOLUME" => PlanNodeKind::Volume,
                "CHAPTER" => PlanNodeKind::Chapter,
                "SCENE" => PlanNodeKind::Scene,
                _ => PlanNodeKind::Outline,
            };
            let id = Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let parent_id = row
                .get::<_, Option<String>>(1)?
                .map(|value| {
                    Uuid::parse_str(&value).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?;
            Ok(PlanNode {
                id,
                parent_id,
                kind,
                title: row.get(3)?,
                sort_order: row.get(4)?,
                archived: row.get::<_, i64>(5)? == 1,
                revision: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn create_plan_node(
        &mut self,
        parent_id: Option<Uuid>,
        kind: PlanNodeKind,
        title: String,
    ) -> Result<PlanNode, PlanError> {
        if let Some(parent) = parent_id {
            let parent_kind: Option<String> = self
                .connection
                .query_row(
                    "SELECT kind FROM plan_nodes WHERE id = ?1 AND archived = 0",
                    [parent.to_string()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DatabaseError::from)?;
            let parent_kind = parent_kind.ok_or(PlanError::MissingParent(parent))?;
            let valid = matches!(
                (parent_kind.as_str(), kind),
                ("WORK_DESIGN", PlanNodeKind::Outline)
                    | ("OUTLINE", PlanNodeKind::Volume | PlanNodeKind::Chapter)
                    | ("VOLUME", PlanNodeKind::Chapter)
                    | ("CHAPTER", PlanNodeKind::Scene)
            );
            if !valid {
                return Err(PlanError::InvalidParentKind);
            }
        }
        let sort_order: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_nodes WHERE parent_id IS ?1",
                rusqlite::params![parent_id.map(|id| id.to_string())],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        let node = PlanNode {
            id: Uuid::new_v4(),
            parent_id,
            kind,
            title,
            sort_order,
            archived: false,
            revision: 1,
        };
        self.connection
            .execute(
                "INSERT INTO plan_nodes (id, parent_id, kind, title, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    node.id.to_string(),
                    node.parent_id.map(|id| id.to_string()),
                    node.kind.as_str(),
                    node.title,
                    node.sort_order
                ],
            )
            .map_err(DatabaseError::from)?;
        if node.kind == PlanNodeKind::Chapter {
            self.connection
                .execute(
                    "INSERT INTO chapters (id, plan_node_id, title) VALUES (?1, ?1, ?2)",
                    rusqlite::params![node.id.to_string(), node.title],
                )
                .map_err(DatabaseError::from)?;
        }
        self.connection.execute(
            "INSERT INTO plan_revisions (id, node_id, revision, title, archived) VALUES (?1, ?2, 1, ?3, 0)",
            rusqlite::params![Uuid::new_v4().to_string(), node.id.to_string(), node.title],
        ).map_err(DatabaseError::from)?;
        self.connection
            .execute(
                "INSERT INTO plan_node_revisions (id, node_id, revision, title, archived)
             VALUES (?1, ?2, 1, ?3, 0)",
                rusqlite::params![Uuid::new_v4().to_string(), node.id.to_string(), node.title],
            )
            .map_err(DatabaseError::from)?;
        Ok(node)
    }

    pub(super) fn update_plan_node(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
    ) -> Result<PlanNode, PlanError> {
        let current = self
            .list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))?;
        let revision = current.revision + 1;
        self.connection
            .execute(
                "UPDATE plan_nodes SET title = ?1, archived = ?2, revision = ?3 WHERE id = ?4",
                rusqlite::params![title, i64::from(archived), revision, id.to_string()],
            )
            .map_err(DatabaseError::from)?;
        if archived {
            self.connection
                .execute(
                    "UPDATE plan_nodes SET archived = 1 WHERE parent_id = ?1",
                    [id.to_string()],
                )
                .map_err(DatabaseError::from)?;
        }
        self.connection
            .execute(
                "INSERT INTO plan_node_revisions (id, node_id, revision, title, archived)
             VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    id.to_string(),
                    revision,
                    title,
                    i64::from(archived)
                ],
            )
            .map_err(DatabaseError::from)?;
        self.connection.execute(
            "INSERT INTO plan_revisions (id, node_id, revision, parent_revision_id, title, archived) SELECT ?1, ?2, ?3, id, ?4, ?5 FROM plan_revisions WHERE node_id = ?2 ORDER BY revision DESC LIMIT 1",
            rusqlite::params![Uuid::new_v4().to_string(), id.to_string(), revision, title, i64::from(archived)],
        ).map_err(DatabaseError::from)?;
        Ok(PlanNode {
            title,
            archived,
            revision,
            ..current
        })
    }

    pub(super) fn update_plan_node_checked(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let current = self
            .list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))?;
        if current.revision != expected_version {
            return Err(PlanError::Conflict {
                expected: expected_version,
                actual: current.revision,
            });
        }
        self.update_plan_node(id, title, archived)
    }

    pub(super) fn move_plan_node(
        &mut self,
        id: Uuid,
        parent_id: Option<Uuid>,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let current = self
            .list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))?;
        if current.revision != expected_version {
            return Err(PlanError::Conflict {
                expected: expected_version,
                actual: current.revision,
            });
        }
        if parent_id == Some(id) {
            return Err(PlanError::Cycle);
        }
        if let Some(parent) = parent_id {
            let parent_node = self
                .list_plan_nodes()?
                .into_iter()
                .find(|node| node.id == parent)
                .ok_or(PlanError::MissingParent(parent))?;
            let valid = matches!(
                (parent_node.kind, current.kind),
                (PlanNodeKind::WorkDesign, PlanNodeKind::Outline)
                    | (
                        PlanNodeKind::Outline,
                        PlanNodeKind::Volume | PlanNodeKind::Chapter
                    )
                    | (PlanNodeKind::Volume, PlanNodeKind::Chapter)
                    | (PlanNodeKind::Chapter, PlanNodeKind::Scene)
            );
            if !valid {
                return Err(PlanError::InvalidParentKind);
            }
            let mut cursor = Some(parent);
            while let Some(candidate) = cursor {
                if candidate == id {
                    return Err(PlanError::Cycle);
                }
                cursor = self
                    .list_plan_nodes()?
                    .into_iter()
                    .find(|node| node.id == candidate)
                    .and_then(|node| node.parent_id);
            }
        }
        let sort_order: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_nodes WHERE parent_id IS ?1",
                rusqlite::params![parent_id.map(|id| id.to_string())],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        self.connection.execute("UPDATE plan_nodes SET parent_id = ?1, sort_order = ?2, revision = revision + 1 WHERE id = ?3", rusqlite::params![parent_id.map(|id| id.to_string()), sort_order, id.to_string()]).map_err(DatabaseError::from)?;
        self.list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))
    }

    pub(super) fn current_manuscript(
        &self,
        chapter_id: Uuid,
    ) -> Result<Option<ManuscriptRevision>, DatabaseError> {
        self.connection
            .query_row(
                "SELECT id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version, created_at
                 FROM manuscript_revisions WHERE chapter_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [chapter_id.to_string()],
                |row| {
                    Ok(ManuscriptRevision {
                        id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        chapter_id,
                        parent_revision_id: row
                            .get::<_, Option<String>>(1)?
                            .map(|value| {
                                Uuid::parse_str(&value).map_err(|error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        1,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                })
                            })
                            .transpose()?,
                        base_revision_id: row
                            .get::<_, Option<String>>(1)?
                            .map(|value| Uuid::parse_str(&value).map_err(|error| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error))))
                            .transpose()?,
                        document_json: row.get(2)?,
                        content_hash: row.get(3)?,
                        creation_reason: row.get(4)?,
                        document_schema_version: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(DatabaseError::from)
    }

    pub(super) fn list_manuscript_revisions(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<ManuscriptRevision>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version, created_at
             FROM manuscript_revisions WHERE chapter_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = statement.query_map([chapter_id.to_string()], |row| {
            Ok(ManuscriptRevision {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                chapter_id,
                parent_revision_id: row
                    .get::<_, Option<String>>(1)?
                    .map(|value| {
                        Uuid::parse_str(&value).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?,
                base_revision_id: row
                    .get::<_, Option<String>>(1)?
                    .map(|value| {
                        Uuid::parse_str(&value).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?,
                document_json: row.get(2)?,
                content_hash: row.get(3)?,
                creation_reason: row.get(4)?,
                document_schema_version: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn save_manuscript_checked(
        &mut self,
        chapter_id: Uuid,
        base_revision_id: Option<Uuid>,
        mut document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        document_json = normalize_document(&document_json)?;
        let exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chapters WHERE id = ?1)",
                [chapter_id.to_string()],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        if !exists {
            return Err(ManuscriptError::MissingChapter(chapter_id));
        }
        let parent_revision_id = self
            .current_manuscript(chapter_id)?
            .map(|revision| revision.id);
        if let Some(expected) = base_revision_id {
            if Some(expected) != parent_revision_id {
                return Err(ManuscriptError::Conflict {
                    expected: Some(expected),
                    actual: parent_revision_id,
                });
            }
        }
        let mut hasher = Sha256::new();
        hasher.update(document_json.as_bytes());
        let revision = ManuscriptRevision {
            id: Uuid::new_v4(),
            chapter_id,
            parent_revision_id,
            base_revision_id: parent_revision_id,
            content_hash: format!("{:x}", hasher.finalize()),
            document_json,
            creation_reason,
            document_schema_version: 1,
            created_at: now_timestamp(),
        };
        self.connection.execute(
            "INSERT INTO manuscript_revisions (id, chapter_id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![revision.id.to_string(), revision.chapter_id.to_string(), revision.parent_revision_id.map(|id| id.to_string()), revision.document_json, revision.content_hash, revision.creation_reason, revision.document_schema_version],
        ).map_err(DatabaseError::from)?;
        Ok(revision)
    }

    pub(super) fn save_recovery_log(
        &mut self,
        chapter_id: Uuid,
        document_json: String,
    ) -> Result<(), DatabaseError> {
        validate_document(&document_json).map_err(|e| {
            DatabaseError::Sqlite(rusqlite::Error::InvalidParameterName(e.to_string()))
        })?;
        self.connection.execute(
            "INSERT INTO recovery_logs (id, chapter_id, document_json) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                chapter_id.to_string(),
                document_json
            ],
        )?;
        Ok(())
    }

    pub(super) fn list_recovery_logs(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<RecoveryLog>, DatabaseError> {
        let mut statement = self.connection.prepare("SELECT id, chapter_id, document_json, created_at FROM recovery_logs WHERE chapter_id = ?1 ORDER BY created_at DESC, rowid DESC")?;
        let rows = statement.query_map([chapter_id.to_string()], |row| {
            Ok(RecoveryLog {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                chapter_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                document_json: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn list_all_recovery_logs(&self) -> Result<Vec<RecoveryLog>, DatabaseError> {
        let mut statement = self.connection.prepare("SELECT id, chapter_id, document_json, created_at FROM recovery_logs ORDER BY created_at DESC, rowid DESC")?;
        let rows = statement.query_map([], |row| {
            Ok(RecoveryLog {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                chapter_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                document_json: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn clear_recovery_logs(&mut self, chapter_id: Uuid) -> Result<(), DatabaseError> {
        self.connection.execute(
            "DELETE FROM recovery_logs WHERE chapter_id = ?1",
            [chapter_id.to_string()],
        )?;
        Ok(())
    }

    /// Reads the SQLite and migration state used by the desktop health query.
    ///
    /// # Errors
    ///
    /// Returns [`DatabaseError`] when a health query cannot be executed.
    pub fn health(&self) -> Result<DatabaseHealth, DatabaseError> {
        let sqlite_version = self
            .connection
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
        let schema_version = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        let journal_mode = self
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        let foreign_keys_enabled = self
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?
            == 1;
        Ok(DatabaseHealth {
            sqlite_version,
            schema_version,
            journal_mode,
            foreign_keys_enabled,
        })
    }
}
