use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscussionSourceRequest {
    pub candidate_id: Uuid,
    pub project_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub section_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningDiscussionSource {
    pub candidate: DiscussionCandidate,
    pub project_id: Uuid,
    pub session_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionSource {
    pub session: DiscussionSession,
    pub candidate: DiscussionCandidate,
    pub message: DiscussionMessage,
    pub planning_target_available: bool,
    pub planning_target_kind: Option<String>,
}

impl Database {
    pub(super) fn valid_discussion_planning_target(
        connection: &Connection,
        section_id: &str,
    ) -> Result<bool, DiscussionStoreError> {
        if super::context_store::WRITING_SETTING_SECTIONS
            .iter()
            .any(|(id, _)| *id == section_id)
        {
            return Ok(true);
        }
        let Some(id) = section_id
            .strip_prefix("plan-node:")
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            return Ok(false);
        };
        Ok(connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM plan_nodes WHERE id = ?1 AND archived = 0
             AND kind IN ('OUTLINE', 'VOLUME', 'CHAPTER', 'SCENE'))",
            [id.to_string()],
            |row| row.get(0),
        )?)
    }
}

impl ProjectManager {
    pub fn list_planning_discussion_sources(
        &self,
        section_id: String,
        project_id: Uuid,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<PlanningDiscussionSource>, DiscussionStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        if project_id != session.manifest.project_id {
            return Err(DiscussionStoreError::Conflict);
        }
        let mut stmt = session.database.connection.prepare(
            "SELECT c.id, c.session_id, c.message_id, c.kind, c.content, c.target_section_id,
                    c.status, c.promoted_object_id, c.created_at, c.updated_at, s.title
             FROM discussion_candidates c JOIN discussion_sessions s ON s.id = c.session_id
             JOIN discussion_messages m ON m.id = c.message_id AND m.session_id = s.id
             JOIN planning_sections p ON p.id = c.target_section_id AND p.id = c.promoted_object_id
             WHERE s.project_id = ?1 AND c.target_section_id = ?2
               AND c.kind IN ('PLANNING', 'SETTING') AND c.status = 'PROMOTED'
             ORDER BY c.updated_at DESC, c.id LIMIT ?3 OFFSET ?4",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                project_id.to_string(),
                section_id,
                limit.clamp(1, 100),
                offset
            ],
            |row| {
                Ok(PlanningDiscussionSource {
                    candidate: super::discussion_store::map_discussion_candidate(row)?,
                    project_id,
                    session_title: row.get(10)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_discussion_source(
        &self,
        request: DiscussionSourceRequest,
    ) -> Result<DiscussionSource, DiscussionStoreError> {
        let project = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        if request
            .project_id
            .is_some_and(|id| id != project.manifest.project_id)
        {
            return Err(DiscussionStoreError::Conflict);
        }
        let candidate = project
            .database
            .get_discussion_candidate(request.candidate_id)?
            .ok_or(DiscussionStoreError::MissingCandidate(request.candidate_id))?;
        let session = project
            .database
            .get_discussion_session(candidate.session_id)?
            .filter(|session| session.project_id == project.manifest.project_id)
            .ok_or(DiscussionStoreError::MissingSession(candidate.session_id))?;
        if request.session_id.is_some_and(|id| id != session.id) {
            return Err(DiscussionStoreError::Conflict);
        }
        let is_planning_transfer = candidate.status == DiscussionCandidateStatus::Promoted
            && candidate.kind.can_promote_to_planning()
            && candidate.target_section_id.is_some()
            && candidate.target_section_id == candidate.promoted_object_id;
        if let Some(section_id) = &request.section_id {
            if !is_planning_transfer || candidate.target_section_id.as_ref() != Some(section_id) {
                return Err(DiscussionStoreError::InvalidPromotion);
            }
        }
        let message = project.database.connection.query_row(
            "SELECT id, session_id, role, content, profile_id, context_version, context_summary, created_at
             FROM discussion_messages WHERE id = ?1 AND session_id = ?2",
            rusqlite::params![candidate.message_id.to_string(), session.id.to_string()],
            super::discussion_store::map_discussion_message,
        ).optional()?.ok_or(DiscussionStoreError::MissingMessage(candidate.message_id))?;
        let planning_target_available = if is_planning_transfer {
            let id = candidate.target_section_id.as_deref().unwrap_or_default();
            let exists: bool = project.database.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM planning_sections WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )?;
            exists && Database::valid_discussion_planning_target(&project.database.connection, id)?
        } else {
            false
        };
        let planning_target_kind = candidate
            .target_section_id
            .as_deref()
            .and_then(|id| id.strip_prefix("plan-node:"))
            .map(|id| {
                project
                    .database
                    .connection
                    .query_row("SELECT kind FROM plan_nodes WHERE id = ?1", [id], |row| {
                        row.get::<_, String>(0)
                    })
                    .optional()
            })
            .transpose()?
            .flatten();
        Ok(DiscussionSource {
            session,
            candidate,
            message,
            planning_target_available,
            planning_target_kind,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        manager: ProjectManager,
        project_id: Uuid,
        session: DiscussionSession,
        message: DiscussionMessage,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ainovel-discussion-source-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager.create(&root, "source test").unwrap().project_id;
            let session = manager
                .create_discussion_session(
                    "原始讨论".into(),
                    DiscussionScopeKind::Project,
                    None,
                    None,
                )
                .unwrap();
            let message = manager
                .append_discussion_message(
                    session.id,
                    DiscussionMessageRole::Assistant,
                    "原始消息 😀 不是最新一页的内容。".into(),
                    None,
                    Some("context:old".into()),
                    None,
                )
                .unwrap();
            Self {
                manager,
                project_id,
                session,
                message,
                root,
            }
        }
        fn candidate(&mut self, section_id: &str) -> DiscussionCandidate {
            self.manager
                .create_discussion_candidate(
                    self.session.id,
                    self.message.id,
                    DiscussionCandidateKind::Planning,
                    "作者编辑后的候选快照".into(),
                    Some(section_id.into()),
                )
                .unwrap()
        }
        fn request(&self, candidate: &DiscussionCandidate) -> DiscussionSourceRequest {
            DiscussionSourceRequest {
                candidate_id: candidate.id,
                project_id: Some(self.project_id),
                session_id: Some(self.session.id),
                section_id: candidate.target_section_id.clone(),
            }
        }
        fn database(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.current.take();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn old_promoted_records_resolve_exact_messages_without_writes_or_reference_backfill() {
        let mut f = Fixture::new();
        let candidate = f.candidate("seed-premise");
        f.manager
            .promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending,
            )
            .unwrap();
        for index in 0..105 {
            f.manager
                .append_discussion_message(
                    f.session.id,
                    DiscussionMessageRole::User,
                    format!("后续消息 {index}"),
                    None,
                    None,
                    None,
                )
                .unwrap();
        }
        assert!(
            !f.manager
                .list_discussion_messages_before(f.session.id, 100, None)
                .unwrap()
                .iter()
                .any(|m| m.id == f.message.id)
        );
        let before = f.database().connection.total_changes();
        let sources = f
            .manager
            .list_planning_discussion_sources("seed-premise".into(), f.project_id, 20, 0)
            .unwrap();
        let source = f
            .manager
            .get_discussion_source(f.request(&candidate))
            .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].candidate.id, candidate.id);
        assert_eq!(sources[0].session_title, f.session.title);
        assert_eq!(source.message.content, f.message.content);
        assert_eq!(source.candidate.content, candidate.content);
        assert!(source.planning_target_available);
        assert_eq!(f.database().connection.total_changes(), before);
        assert!(
            f.manager.list_planning_sections().unwrap()[0]
                .references
                .is_empty()
        );
    }

    #[test]
    fn transfer_preserves_formal_content_and_blocks_stale_planning_and_repeated_promotion() {
        let mut f = Fixture::new();
        let baseline = f
            .manager
            .save_planning_section_checked(
                PlanningSection {
                    id: "seed-premise".into(),
                    content: "正式设定".into(),
                    pending_content: "原待定".into(),
                    story_state: PlanningStoryState::Locked,
                    rationale: "作者理由".into(),
                    consequence: "影响".into(),
                    references: vec!["author-reference".into()],
                    updated_at: now_timestamp(),
                },
                0,
            )
            .unwrap();
        let candidate = f.candidate("seed-premise");
        f.manager
            .promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending,
            )
            .unwrap();
        let next = f
            .manager
            .list_versioned_planning_sections()
            .unwrap()
            .into_iter()
            .find(|s| s.section.id == "seed-premise")
            .unwrap();
        assert_eq!(next.version, baseline.version + 1);
        assert_eq!(next.section.content, baseline.section.content);
        assert_eq!(next.section.story_state, PlanningStoryState::Locked);
        assert_eq!(next.section.references, baseline.section.references);
        assert_eq!(next.section.rationale, baseline.section.rationale);
        assert_eq!(
            next.section.pending_content,
            format!("原待定\n\n{}", candidate.content)
        );
        assert!(
            f.manager
                .save_planning_section_checked(baseline.section, baseline.version)
                .is_err()
        );
        for status in [
            DiscussionCandidateStatus::Pending,
            DiscussionCandidateStatus::Promoted,
            DiscussionCandidateStatus::Dismissed,
        ] {
            assert!(matches!(
                f.manager
                    .promote_discussion_candidate_to_planning(candidate.id, status),
                Err(DiscussionStoreError::Conflict)
            ));
        }
        assert_eq!(
            f.manager
                .list_versioned_planning_sections()
                .unwrap()
                .into_iter()
                .find(|s| s.section.id == "seed-premise")
                .unwrap()
                .version,
            next.version
        );
        assert!(matches!(
            f.manager
                .promote_discussion_candidate_to_foreshadowing_review(
                    candidate.id,
                    DiscussionCandidateStatus::Promoted,
                    Uuid::new_v4()
                ),
            Err(DiscussionStoreError::Conflict)
        ));
    }

    #[test]
    fn wrong_project_session_section_missing_candidate_and_cross_session_message_are_rejected() {
        let mut f = Fixture::new();
        let candidate = f.candidate("seed-premise");
        f.manager
            .promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending,
            )
            .unwrap();
        for wrong in [
            DiscussionSourceRequest {
                project_id: Some(Uuid::new_v4()),
                ..f.request(&candidate)
            },
            DiscussionSourceRequest {
                session_id: Some(Uuid::new_v4()),
                ..f.request(&candidate)
            },
            DiscussionSourceRequest {
                section_id: Some("engine-theme".into()),
                ..f.request(&candidate)
            },
            DiscussionSourceRequest {
                candidate_id: Uuid::new_v4(),
                ..f.request(&candidate)
            },
        ] {
            assert!(f.manager.get_discussion_source(wrong).is_err());
        }
        assert!(
            f.manager
                .list_planning_discussion_sources("seed-premise".into(), Uuid::new_v4(), 20, 0)
                .is_err()
        );
        let other = f
            .manager
            .create_discussion_session("另一讨论".into(), DiscussionScopeKind::Project, None, None)
            .unwrap();
        let other_message = f
            .manager
            .append_discussion_message(
                other.id,
                DiscussionMessageRole::User,
                "其他内容".into(),
                None,
                None,
                None,
            )
            .unwrap();
        f.database()
            .connection
            .execute(
                "UPDATE discussion_candidates SET message_id = ?1 WHERE id = ?2",
                rusqlite::params![other_message.id.to_string(), candidate.id.to_string()],
            )
            .unwrap();
        assert!(matches!(
            f.manager.get_discussion_source(f.request(&candidate)),
            Err(DiscussionStoreError::MissingMessage(_))
        ));
        assert!(
            f.manager
                .list_planning_discussion_sources("seed-premise".into(), f.project_id, 20, 0)
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            ProjectManager::new().get_discussion_source(f.request(&candidate)),
            Err(DiscussionStoreError::NoProject)
        ));
    }

    #[test]
    fn active_node_targets_work_and_archived_or_unknown_targets_do_not_create_orphan_plans() {
        let mut f = Fixture::new();
        let chapter = f
            .manager
            .create_plan_node(None, PlanNodeKind::Chapter, "入城".into())
            .unwrap();
        let id = format!("plan-node:{}", chapter.id);
        let candidate = f.candidate(&id);
        f.manager
            .promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending,
            )
            .unwrap();
        let source = f
            .manager
            .get_discussion_source(f.request(&candidate))
            .unwrap();
        assert_eq!(source.planning_target_kind.as_deref(), Some("CHAPTER"));
        assert!(source.planning_target_available);
        f.manager
            .update_plan_node(chapter.id, "入城".into(), true)
            .unwrap();
        assert!(
            !f.manager
                .get_discussion_source(f.request(&candidate))
                .unwrap()
                .planning_target_available
        );
        for target in [
            id,
            "unknown-section".into(),
            format!("plan-node:{}", Uuid::new_v4()),
        ] {
            let invalid = f.candidate(&target);
            assert!(matches!(
                f.manager.promote_discussion_candidate_to_planning(
                    invalid.id,
                    DiscussionCandidateStatus::Pending
                ),
                Err(DiscussionStoreError::InvalidPromotion)
            ));
            assert_eq!(
                f.manager
                    .list_discussion_candidates(f.session.id)
                    .unwrap()
                    .iter()
                    .find(|c| c.id == invalid.id)
                    .unwrap()
                    .status,
                DiscussionCandidateStatus::Pending
            );
        }
        assert_eq!(f.manager.list_planning_sections().unwrap().len(), 1);
    }

    #[test]
    fn promotion_rejects_foreign_sessions_and_mismatched_messages_without_writing_planning() {
        let mut f = Fixture::new();
        let candidate = f.candidate("seed-premise");
        f.database()
            .connection
            .execute(
                "UPDATE discussion_sessions SET project_id = ?1 WHERE id = ?2",
                rusqlite::params![Uuid::new_v4().to_string(), f.session.id.to_string()],
            )
            .unwrap();
        assert!(matches!(
            f.manager.promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending
            ),
            Err(DiscussionStoreError::Conflict)
        ));
        f.database()
            .connection
            .execute(
                "UPDATE discussion_sessions SET project_id = ?1 WHERE id = ?2",
                rusqlite::params![f.project_id.to_string(), f.session.id.to_string()],
            )
            .unwrap();
        let other = f
            .manager
            .create_discussion_session("另一讨论".into(), DiscussionScopeKind::Project, None, None)
            .unwrap();
        let message = f
            .manager
            .append_discussion_message(
                other.id,
                DiscussionMessageRole::User,
                "无关消息".into(),
                None,
                None,
                None,
            )
            .unwrap();
        f.database()
            .connection
            .execute(
                "UPDATE discussion_candidates SET message_id = ?1 WHERE id = ?2",
                rusqlite::params![message.id.to_string(), candidate.id.to_string()],
            )
            .unwrap();
        assert!(matches!(
            f.manager.promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending
            ),
            Err(DiscussionStoreError::Conflict)
        ));
        assert!(f.manager.list_planning_sections().unwrap().is_empty());
        assert_eq!(
            f.manager.list_discussion_candidates(f.session.id).unwrap()[0].status,
            DiscussionCandidateStatus::Pending
        );
    }

    #[test]
    fn transfer_failure_rolls_back_both_pending_content_and_candidate_status() {
        let mut f = Fixture::new();
        let candidate = f.candidate("seed-premise");
        f.database().connection.execute_batch(
            "CREATE TRIGGER fail_discussion_transfer BEFORE UPDATE OF status ON discussion_candidates
             BEGIN SELECT RAISE(ABORT, 'test transfer failure'); END;"
        ).unwrap();
        assert!(
            f.manager
                .promote_discussion_candidate_to_planning(
                    candidate.id,
                    DiscussionCandidateStatus::Pending
                )
                .is_err()
        );
        assert!(f.manager.list_planning_sections().unwrap().is_empty());
        assert_eq!(
            f.manager.list_discussion_candidates(f.session.id).unwrap()[0].status,
            DiscussionCandidateStatus::Pending
        );
        assert!(
            f.manager
                .list_planning_discussion_sources("seed-premise".into(), f.project_id, 20, 0)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn source_pages_filter_transferred_candidates_and_survive_author_replacing_the_plan() {
        let mut f = Fixture::new();
        for _ in 0..3 {
            let candidate = f.candidate("seed-premise");
            f.manager
                .promote_discussion_candidate_to_planning(
                    candidate.id,
                    DiscussionCandidateStatus::Pending,
                )
                .unwrap();
        }
        let pending = f.candidate("seed-premise");
        let dismissed = f.candidate("seed-premise");
        f.manager
            .dismiss_discussion_candidate(dismissed.id, DiscussionCandidateStatus::Pending)
            .unwrap();
        assert!(
            f.manager
                .get_discussion_source(DiscussionSourceRequest {
                    section_id: None,
                    ..f.request(&pending)
                })
                .is_ok()
        );
        assert!(
            f.manager
                .get_discussion_source(f.request(&pending))
                .is_err()
        );
        let pages = (0..3)
            .map(|offset| {
                f.manager
                    .list_planning_discussion_sources(
                        "seed-premise".into(),
                        f.project_id,
                        1,
                        offset,
                    )
                    .unwrap()[0]
                    .candidate
                    .id
            })
            .collect::<Vec<_>>();
        assert_eq!(
            pages.iter().collect::<std::collections::HashSet<_>>().len(),
            3
        );
        assert!(
            f.manager
                .list_planning_discussion_sources("engine-theme".into(), f.project_id, 20, 0)
                .unwrap()
                .is_empty()
        );
        let mut section = f
            .manager
            .list_planning_sections()
            .unwrap()
            .into_iter()
            .find(|s| s.id == "seed-premise")
            .unwrap();
        section.pending_content.clear();
        section.content = "作者另写的正式设定".into();
        section.story_state = PlanningStoryState::Confirmed;
        f.manager.save_planning_section(section).unwrap();
        assert_eq!(
            f.manager
                .list_planning_discussion_sources("seed-premise".into(), f.project_id, 100, 0)
                .unwrap()
                .len(),
            3
        );
    }
}
