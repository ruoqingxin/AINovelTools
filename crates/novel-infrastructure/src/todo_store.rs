use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthorTodoKind {
    FactReview,
    FactFinalize,
    Extraction,
    ExtractionDeferred,
    DiscussionDesign,
    Recovery,
    WritingProposal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthorTodo {
    pub kind: AuthorTodoKind,
    pub target_id: String,
    pub target_title: String,
    pub count: u32,
    pub high_risk: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthorTodoQueue {
    pub project_id: Uuid,
    pub pending_count: u32,
    pub items: Vec<AuthorTodo>,
}

impl ProjectManager {
    /// One database snapshot, without chapter-by-chapter IPC or synthetic readiness tasks.
    pub fn list_author_todos(&self) -> Result<AuthorTodoQueue, DatabaseError> {
        let session = self.current.as_ref().ok_or(DatabaseError::Sqlite(
            rusqlite::Error::InvalidQuery,
        ))?;
        let mut statement = session.database.connection.prepare(
            "WITH active_facts AS (
                SELECT * FROM knowledge_candidates
                WHERE project_id=?1 AND candidate_status IN ('PENDING','NEEDS_REVIEW','APPROVED')
             ), risky_chapters AS (
                SELECT DISTINCT a.chapter_id FROM active_facts a JOIN active_facts b
                  ON a.chapter_id=b.chapter_id AND a.subject=b.subject
                  AND a.predicate=b.predicate AND a.object<>b.object
             ), queue AS (
                SELECT CASE WHEN k.candidate_status='APPROVED' THEN 'FACT_FINALIZE'
                       ELSE 'FACT_REVIEW' END todo_kind,
                       n.id target_id, n.title target_title, COUNT(*) count,
                       EXISTS(SELECT 1 FROM risky_chapters r WHERE r.chapter_id=k.chapter_id) high_risk,
                       MAX(k.updated_at) updated_at
                FROM active_facts k JOIN chapters c ON c.id=k.chapter_id
                  JOIN plan_nodes n ON n.id=c.plan_node_id
                GROUP BY n.id, todo_kind
                UNION ALL
                SELECT CASE WHEN i.status='DEFERRED' THEN 'EXTRACTION_DEFERRED' ELSE 'EXTRACTION' END,
                       n.id, n.title, COUNT(*), 0, MAX(i.updated_at)
                FROM chapter_extraction_items i
                  JOIN chapter_extraction_proposals p ON p.id=i.proposal_id
                  JOIN chapters c ON c.id=p.chapter_id JOIN plan_nodes n ON n.id=c.plan_node_id
                WHERE p.project_id=?1 AND i.status IN ('PENDING_REVIEW','DEFERRED')
                GROUP BY n.id, i.status
                UNION ALL
                SELECT 'DISCUSSION_DESIGN', s.id, s.title, COUNT(*), 0, MAX(p.created_at)
                FROM discussion_design_proposals p JOIN discussion_sessions s ON s.id=p.session_id
                WHERE s.project_id=?1 AND s.deleted_at IS NULL AND p.status='PENDING'
                GROUP BY s.id
                UNION ALL
                SELECT 'RECOVERY', n.id, n.title, COUNT(*), 0, MAX(r.created_at)
                FROM recovery_logs r JOIN plan_nodes n ON n.id=r.chapter_id
                GROUP BY n.id
                UNION ALL
                SELECT 'WRITING_PROPOSAL', n.id, n.title, COUNT(*), 0, MAX(p.created_at)
                FROM ai_proposals p JOIN chapters c ON c.id=p.chapter_id
                  JOIN plan_nodes n ON n.id=c.plan_node_id
                WHERE p.status='PENDING' AND p.action<>'CONSISTENCY_CHECK'
                GROUP BY n.id
             )
             SELECT todo_kind, target_id, target_title, count, high_risk, updated_at FROM queue
             ORDER BY high_risk DESC, updated_at DESC, todo_kind, target_id",
        )?;
        let items = statement.query_map([session.manifest.project_id.to_string()], |row| {
            let kind = match row.get::<_, String>(0)?.as_str() {
                "FACT_REVIEW" => AuthorTodoKind::FactReview,
                "FACT_FINALIZE" => AuthorTodoKind::FactFinalize,
                "EXTRACTION" => AuthorTodoKind::Extraction,
                "EXTRACTION_DEFERRED" => AuthorTodoKind::ExtractionDeferred,
                "DISCUSSION_DESIGN" => AuthorTodoKind::DiscussionDesign,
                "RECOVERY" => AuthorTodoKind::Recovery,
                _ => AuthorTodoKind::WritingProposal,
            };
            Ok(AuthorTodo {
                kind,
                target_id: row.get(1)?,
                target_title: row.get(2)?,
                count: row.get(3)?,
                high_risk: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(AuthorTodoQueue {
            project_id: session.manifest.project_id,
            pending_count: items.iter().map(|item| item.count).sum(),
            items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_uses_persisted_states_and_separates_approval_from_finalization() {
        let root = std::env::temp_dir().join(format!("author-todos-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let project = manager.create(&root, "Queue").unwrap();
        let chapter = manager.create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into()).unwrap();
        let document = r#"{"type":"doc","content":[]}"#.to_owned();
        let draft = manager.save_manuscript_draft(chapter.id, None, document.clone(), 0).unwrap();
        let revision = manager.commit_manuscript_draft(chapter.id, None, document, draft.version).unwrap();
        let db = &manager.current.as_ref().unwrap().database.connection;
        for (status, object) in [
            ("PENDING", "alive"), ("APPROVED", "dead"), ("REJECTED", "missing"), ("FINALIZED", "lost"),
        ] {
            db.execute(
                "INSERT INTO knowledge_candidates
                 (id,project_id,chapter_id,knowledge_id,knowledge_version,subject,predicate,object,
                  source_revision_id,lifecycle_status,created_by,candidate_status)
                 VALUES (?1,?2,?3,?4,1,'hero','state',?5,?6,'ACTIVE','test',?7)",
                rusqlite::params![Uuid::new_v4().to_string(), project.project_id.to_string(),
                    chapter.id.to_string(), Uuid::new_v4().to_string(), object, revision.revision.id.to_string(), status],
            ).unwrap();
        }
        let queue = manager.list_author_todos().unwrap();
        assert_eq!(queue.pending_count, 2);
        assert_eq!(queue.items.len(), 2);
        assert!(queue.items.iter().all(|item| item.high_risk));
        assert!(queue.items.iter().any(|item| item.kind == AuthorTodoKind::FactFinalize));
        assert_eq!(manager.detect_candidate_conflicts(chapter.id).unwrap().len(), 1);
        db.execute("UPDATE knowledge_candidates SET candidate_status='REJECTED' WHERE candidate_status='PENDING'", []).unwrap();
        let queue = manager.list_author_todos().unwrap();
        assert_eq!(queue.pending_count, 1);
        assert!(!queue.items[0].high_risk);
        assert!(manager.detect_candidate_conflicts(chapter.id).unwrap().is_empty());
        manager.close();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_planning_is_not_a_todo_and_recovery_is_grouped_by_chapter() {
        let root = std::env::temp_dir().join(format!("author-todos-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "Queue").unwrap();
        let chapter = manager.create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into()).unwrap();
        assert_eq!(manager.list_author_todos().unwrap().pending_count, 0);
        for _ in 0..2 {
            manager.save_recovery_log(chapter.id, r#"{"type":"doc","content":[]}"#.into()).unwrap();
        }
        let queue = manager.list_author_todos().unwrap();
        assert_eq!(queue.pending_count, 2);
        assert_eq!(queue.items.len(), 1);
        assert_eq!(queue.items[0].kind, AuthorTodoKind::Recovery);
        manager.clear_recovery_logs(chapter.id).unwrap();
        assert_eq!(manager.list_author_todos().unwrap().pending_count, 0);
        manager.close();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queue_aggregates_extractions_designs_and_writing_without_counting_checks_or_other_projects() {
        let root = std::env::temp_dir().join(format!("author-todos-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let project = manager.create(&root, "Queue").unwrap();
        let chapter = manager.create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into()).unwrap();
        let document = r#"{"type":"doc","content":[]}"#.to_owned();
        let draft = manager.save_manuscript_draft(chapter.id, None, document.clone(), 0).unwrap();
        let revision = manager.commit_manuscript_draft(chapter.id, None, document, draft.version).unwrap().revision;
        let profile = manager.upsert_model_profile(ModelProfileInput {
            id: None, name: "Test".into(), provider: ModelProvider::DeepSeek, capability: ModelCapability::Chat,
            base_url: "https://example.test".into(), model_id: "test".into(),
            context_window: 8192, max_output_tokens: 1024, privacy_level: PrivacyLevel::AllowCloud,
            timeout_seconds: 30, retry_limit: 0, input_price_micros_per_million: 0,
            output_price_micros_per_million: 0, price_currency: "USD".into(),
        }).unwrap();
        let db = &manager.current.as_ref().unwrap().database.connection;
        let anchor = Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO evidence_anchors
             (id,project_id,chapter_id,source_revision_id,block_id,start_offset,end_offset,source_version,source_hash,lifecycle_status,created_by)
             VALUES (?1,?2,?3,?4,'p',0,1,'test','test','ACTIVE','test')",
            rusqlite::params![anchor, project.project_id.to_string(), chapter.id.to_string(), revision.id.to_string()],
        ).unwrap();
        let proposal = Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO chapter_extraction_proposals (id,project_id,chapter_id,source_revision_id,status)
             VALUES (?1,?2,?3,?4,'PENDING_REVIEW')",
            rusqlite::params![proposal, project.project_id.to_string(), chapter.id.to_string(), revision.id.to_string()],
        ).unwrap();
        for status in ["PENDING_REVIEW", "DEFERRED", "ACCEPTED", "REJECTED"] {
            db.execute(
                "INSERT INTO chapter_extraction_items (id,proposal_id,kind,payload_json,evidence_anchor_id,status)
                 VALUES (?1,?2,'ENTITY','{}',?3,?4)",
                rusqlite::params![Uuid::new_v4().to_string(), proposal, anchor, status],
            ).unwrap();
        }
        for project_id in [project.project_id, Uuid::new_v4()] {
            let session = Uuid::new_v4().to_string();
            db.execute(
                "INSERT INTO discussion_sessions (id,project_id,title,scope_kind) VALUES (?1,?2,'Design','PROJECT')",
                rusqlite::params![session, project_id.to_string()],
            ).unwrap();
            for status in ["PENDING", "CONFIRMED"] {
                db.execute(
                    "INSERT INTO discussion_design_proposals
                     (id,session_id,workspace_version,entities_json,source_message_ids_json,context_version,status)
                     VALUES (?1,?2,0,'[]','[]','test',?3)",
                    rusqlite::params![Uuid::new_v4().to_string(), session, status],
                ).unwrap();
            }
        }
        for (action, status) in [("DRAFT", "PENDING"), ("DRAFT", "ACCEPTED"), ("CONSISTENCY_CHECK", "PENDING")] {
            let task = Uuid::new_v4().to_string();
            db.execute(
                "INSERT INTO ai_tasks (id,profile_id,chapter_id,action,context_version,prompt_version,status)
                 VALUES (?1,?2,?3,?4,'test','test','COMPLETED')",
                rusqlite::params![task, profile.id.to_string(), chapter.id.to_string(), action],
            ).unwrap();
            db.execute(
                "INSERT INTO ai_proposals (id,task_id,chapter_id,action,context_version,prompt_version,output_text,status)
                 VALUES (?1,?2,?3,?4,'test','test','candidate',?5)",
                rusqlite::params![Uuid::new_v4().to_string(), task, chapter.id.to_string(), action, status],
            ).unwrap();
        }
        let queue = manager.list_author_todos().unwrap();
        assert_eq!(queue.pending_count, 4);
        assert_eq!(queue.items.len(), 4);
        assert!(queue.items.iter().all(|item| item.count == 1 && !item.high_risk));
        for kind in [AuthorTodoKind::Extraction, AuthorTodoKind::ExtractionDeferred,
            AuthorTodoKind::DiscussionDesign, AuthorTodoKind::WritingProposal] {
            assert!(queue.items.iter().any(|item| item.kind == kind));
        }
        manager.close();
        std::fs::remove_dir_all(root).unwrap();
    }
}
