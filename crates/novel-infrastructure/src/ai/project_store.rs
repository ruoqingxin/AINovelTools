use super::*;

impl ProjectManager {
    pub fn get_project_ai_task_overrides(&self) -> Result<ProjectAiTaskOverrides, AiError> {
        let Some(session) = self.current.as_ref() else {
            return Ok(ProjectAiTaskOverrides::default());
        };
        let mut overrides = ProjectAiTaskOverrides {
            available: true,
            ..ProjectAiTaskOverrides::default()
        };
        let mut statement = session
            .database
            .connection
            .prepare("SELECT task_key, preference_json FROM project_ai_task_overrides")
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(DatabaseError::from)?;
        for row in rows {
            let (task_key, preference_json) = row.map_err(DatabaseError::from)?;
            let preference = serde_json::from_str::<AiTaskPreference>(&preference_json)
                .map_err(|_| AiError::ContextSerialization)?;
            match task_key.as_str() {
                "workDesign" => overrides.work_design = Some(preference),
                "outline" => overrides.outline = Some(preference),
                "volumePlanning" => overrides.volume_planning = Some(preference),
                "chapterSplit" => overrides.chapter_split = Some(preference),
                "chapterPlan" => overrides.chapter_plan = Some(preference),
                "consistencyReview" => overrides.consistency_review = Some(preference),
                "writing" => overrides.writing = Some(preference),
                "knowledgeExtraction" => overrides.knowledge_extraction = Some(preference),
                _ => {}
            }
        }
        Ok(overrides)
    }

    pub fn save_project_ai_task_override(
        &mut self,
        task: AiTaskKind,
        preference: &AiTaskPreference,
    ) -> Result<(), AiError> {
        let profiles = self.list_model_profiles()?;
        validate_ai_task_preference(preference, &profiles)?;
        let preference_json =
            serde_json::to_string(preference).map_err(|_| AiError::ContextSerialization)?;
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .execute(
                "INSERT INTO project_ai_task_overrides (task_key, preference_json)
                 VALUES (?1, ?2)
                 ON CONFLICT(task_key) DO UPDATE SET
                    preference_json=excluded.preference_json,
                    updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![task.storage_key(), preference_json],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn save_project_ai_task_overrides(
        &mut self,
        preferences: &AiTaskPreferences,
    ) -> Result<(), AiError> {
        let profiles = self.list_model_profiles()?;
        let entries = [
            (AiTaskKind::WorkDesign, &preferences.work_design),
            (AiTaskKind::Outline, &preferences.outline),
            (AiTaskKind::VolumePlanning, &preferences.volume_planning),
            (AiTaskKind::ChapterSplit, &preferences.chapter_split),
            (AiTaskKind::ChapterPlan, &preferences.chapter_plan),
            (
                AiTaskKind::ConsistencyReview,
                &preferences.consistency_review,
            ),
            (AiTaskKind::Writing, &preferences.writing),
            (
                AiTaskKind::KnowledgeExtraction,
                &preferences.knowledge_extraction,
            ),
        ];
        let mut serialized = Vec::with_capacity(entries.len());
        for (task, preference) in entries {
            validate_ai_task_preference(preference, &profiles)?;
            serialized.push((
                task.storage_key(),
                serde_json::to_string(preference).map_err(|_| AiError::ContextSerialization)?,
            ));
        }

        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        for (task_key, preference_json) in serialized {
            transaction
                .execute(
                    "INSERT INTO project_ai_task_overrides (task_key, preference_json)
                     VALUES (?1, ?2)
                     ON CONFLICT(task_key) DO UPDATE SET
                        preference_json=excluded.preference_json,
                        updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    rusqlite::params![task_key, preference_json],
                )
                .map_err(DatabaseError::from)?;
        }
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn remove_project_ai_task_override(&mut self, task: AiTaskKind) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .execute(
                "DELETE FROM project_ai_task_overrides WHERE task_key=?1",
                [task.storage_key()],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn list_model_profiles(&self) -> Result<Vec<ModelProfile>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles ORDER BY updated_at DESC"
        ).map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], read_profile)
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn get_model_profile(&self, id: Uuid) -> Result<ModelProfile, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session.database.connection.query_row(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles WHERE id = ?1",
            [id.to_string()], read_profile,
        ).optional().map_err(DatabaseError::from)?.ok_or(AiError::MissingProfile(id))
    }

    pub fn upsert_model_profile(
        &mut self,
        input: ModelProfileInput,
    ) -> Result<ModelProfile, AiError> {
        input.validate()?;
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        session.database.connection.execute(
            "INSERT INTO model_profiles (id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, capability=excluded.capability, base_url=excluded.base_url, model_id=excluded.model_id, context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens, privacy_level=excluded.privacy_level, timeout_seconds=excluded.timeout_seconds, retry_limit=excluded.retry_limit, input_price_micros_per_million=excluded.input_price_micros_per_million, output_price_micros_per_million=excluded.output_price_micros_per_million, price_currency=excluded.price_currency, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id.to_string(), input.name.trim(), provider_str(input.provider), capability_str(input.capability), input.base_url.trim_end_matches('/'), input.model_id.trim(), input.context_window, input.max_output_tokens, privacy_str(input.privacy_level), input.timeout_seconds, input.retry_limit, i64::try_from(input.input_price_micros_per_million).unwrap_or(i64::MAX), i64::try_from(input.output_price_micros_per_million).unwrap_or(i64::MAX), input.price_currency.trim()],
        ).map_err(DatabaseError::from)?;
        self.get_model_profile(id)
    }

    pub fn set_model_profile_secret_ref(
        &mut self,
        id: Uuid,
        secret_ref: Option<&str>,
    ) -> Result<ModelProfile, AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let changed = session.database.connection.execute(
            "UPDATE model_profiles SET secret_ref = ?2, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?1",
            rusqlite::params![id.to_string(), secret_ref],
        ).map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::MissingProfile(id));
        }
        self.get_model_profile(id)
    }

    pub fn create_ai_task(
        &mut self,
        profile_id: Uuid,
        context: &ContextPackage,
        review_purpose: Option<ReviewPurpose>,
    ) -> Result<Uuid, AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let profile_snapshot: Option<(String, String, String, String, u64, u64, String)> = session
            .database
            .connection
            .query_row(
                "SELECT p.capability, COALESCE(c.title, '未命名章节'), p.provider, p.model_id,
                        p.input_price_micros_per_million, p.output_price_micros_per_million,
                        p.price_currency
                 FROM model_profiles p
                 LEFT JOIN chapters c ON c.id = ?2
                 WHERE p.id = ?1",
                rusqlite::params![profile_id.to_string(), context.chapter_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                        u64::try_from(row.get::<_, i64>(5)?.max(0)).unwrap_or(0),
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(DatabaseError::from)?;
        let Some((
            capability,
            chapter_title,
            provider,
            model_id,
            input_price,
            output_price,
            price_currency,
        )) = profile_snapshot
        else {
            return Err(AiError::MissingProfile(profile_id));
        };
        let (cache_hit_price, input_price, output_price, price_currency) = snapshot_run_prices(
            &provider,
            &model_id,
            input_price,
            output_price,
            price_currency,
        );
        match capability.as_str() {
            "CHAT" => {}
            _ => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let task_id = Uuid::new_v4();
        let task_contract_json = serde_json::to_string(&context.task_contract)
            .map_err(|_| AiError::ContextSerialization)?;
        let context_section_audit_json = serde_json::to_string(&context.section_audit)
            .map_err(|_| AiError::ContextSerialization)?;
        let task_kind = if context.action == AiAction::ConsistencyCheck {
            AiTaskKind::ConsistencyReview
        } else {
            AiTaskKind::Writing
        };
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        transaction.execute(
            "INSERT INTO ai_tasks (id, profile_id, chapter_id, action, target_revision_id, context_version, prompt_version, task_contract_json, context_section_audit_json, status, estimated_input_tokens, review_purpose) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![task_id.to_string(), profile_id.to_string(), context.chapter_id.to_string(), action_str(context.action), context.target_revision_id.map(|id| id.to_string()), context.context_version, context.prompt_version, task_contract_json, context_section_audit_json, task_status_str(AiTaskStatus::Running), context.estimated_input_tokens, review_purpose.unwrap_or(ReviewPurpose::Admission).storage_key()],
        ).map_err(DatabaseError::from)?;
        transaction
            .execute(
                "INSERT INTO ai_run_records (
                id, task_key, source, chapter_id, display_title, profile_id, action, status,
                estimated_input_tokens, input_price_micros_per_million,
                input_cache_hit_price_micros_per_million, output_price_micros_per_million,
                price_currency, prompt_version, review_purpose
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                rusqlite::params![
                    task_id.to_string(),
                    task_kind.storage_key(),
                    AiRunSource::Writing.storage_key(),
                    context.chapter_id.to_string(),
                    chapter_title,
                    profile_id.to_string(),
                    action_str(context.action),
                    task_status_str(AiTaskStatus::Running),
                    context.estimated_input_tokens,
                    i64::try_from(input_price).unwrap_or(i64::MAX),
                    i64::try_from(cache_hit_price).unwrap_or(i64::MAX),
                    i64::try_from(output_price).unwrap_or(i64::MAX),
                    price_currency,
                    context.prompt_version,
                    review_purpose
                        .unwrap_or(ReviewPurpose::Admission)
                        .storage_key()
                ],
            )
            .map_err(DatabaseError::from)?;
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(task_id)
    }

    pub fn start_ai_run(&mut self, input: AiRunStart<'_>) -> Result<Uuid, AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let capability_and_prices: Option<(String, String, String, u64, u64, String)> = session
            .database
            .connection
            .query_row(
                "SELECT capability, provider, model_id, input_price_micros_per_million,
                        output_price_micros_per_million, price_currency
                 FROM model_profiles WHERE id = ?1",
                [input.profile_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        u64::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                        u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(DatabaseError::from)?;
        let Some((capability, provider, model_id, input_price, output_price, price_currency)) =
            capability_and_prices
        else {
            return Err(AiError::MissingProfile(input.profile_id));
        };
        let (cache_hit_price, input_price, output_price, price_currency) = snapshot_run_prices(
            &provider,
            &model_id,
            input_price,
            output_price,
            price_currency,
        );
        if capability != "CHAT" {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
        let run_id = Uuid::new_v4();
        session
            .database
            .connection
            .execute(
                "INSERT INTO ai_run_records (
                id, task_key, source, job_id, chapter_id, display_title, profile_id, action,
                status, estimated_input_tokens, input_price_micros_per_million,
                input_cache_hit_price_micros_per_million, output_price_micros_per_million,
                price_currency, prompt_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?2, 'RUNNING', ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    run_id.to_string(),
                    input.task.storage_key(),
                    input.source.storage_key(),
                    input.job_id.map(|id| id.to_string()),
                    input.chapter_id.map(|id| id.to_string()),
                    input.display_title.trim(),
                    input.profile_id.to_string(),
                    input.estimated_input_tokens,
                    i64::try_from(input_price).unwrap_or(i64::MAX),
                    i64::try_from(cache_hit_price).unwrap_or(i64::MAX),
                    i64::try_from(output_price).unwrap_or(i64::MAX),
                    price_currency,
                    input.prompt_version
                ],
            )
            .map_err(DatabaseError::from)?;
        Ok(run_id)
    }

    pub fn record_ai_run_request(
        &mut self,
        run_id: Uuid,
        endpoint: &str,
        request_body: &str,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let changed = session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records
                 SET request_endpoint=?2, request_body=?3
                 WHERE id=?1",
                rusqlite::params![run_id.to_string(), endpoint, request_body],
            )
            .map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::MissingRun(run_id));
        }
        self.prune_ai_request_snapshots().map_err(AiError::from)?;
        Ok(())
    }

    pub fn get_ai_run_request(&self, run_id: Uuid) -> Result<AiRunRequest, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .query_row(
                "SELECT request_endpoint, request_body
                 FROM ai_run_records WHERE id=?1",
                [run_id.to_string()],
                |row| {
                    Ok(AiRunRequest {
                        endpoint: row.get(0)?,
                        request_body: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(DatabaseError::from)?
            .ok_or(AiError::MissingRun(run_id))
    }

    pub fn complete_ai_task(
        &mut self,
        task_id: Uuid,
        context: &ContextPackage,
        output_text: String,
        usage: Option<&GenerationUsage>,
    ) -> Result<AiProposal, AiError> {
        if output_text.trim().is_empty() {
            return Err(AiError::InvalidResponse);
        }
        let fallback_output_tokens =
            u32::try_from(output_text.trim().chars().count().div_ceil(4)).unwrap_or(u32::MAX);
        let input_tokens = usage.map(|value| value.input_tokens);
        let output_tokens = usage.map_or(fallback_output_tokens, |value| value.output_tokens);
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        let review_purpose: String = transaction
            .query_row(
                "SELECT review_purpose FROM ai_tasks WHERE id=?1",
                [task_id.to_string()],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        let (cache_hit_price, cache_miss_price, output_price): (i64, i64, i64) = transaction
            .query_row(
                "SELECT input_cache_hit_price_micros_per_million,
                        input_price_micros_per_million, output_price_micros_per_million
                 FROM ai_run_records WHERE id=?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(DatabaseError::from)?;
        let actual_cost = usage.and_then(|value| {
            actual_run_cost_micros(
                value,
                u64::try_from(cache_hit_price.max(0)).unwrap_or(0),
                u64::try_from(cache_miss_price.max(0)).unwrap_or(0),
                u64::try_from(output_price.max(0)).unwrap_or(0),
            )
        });
        transaction.execute("UPDATE ai_tasks SET status='COMPLETED', estimated_input_tokens=COALESCE(?2, estimated_input_tokens), estimated_output_tokens=?3, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1 AND status='RUNNING'", rusqlite::params![task_id.to_string(), input_tokens, output_tokens]).map_err(DatabaseError::from)?;
        transaction.execute(
            "UPDATE ai_run_records SET status='COMPLETED',
                estimated_input_tokens=COALESCE(?2, estimated_input_tokens), estimated_output_tokens=?3,
                actual_cost_micros=?4,
                finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1 AND status='RUNNING'",
            rusqlite::params![task_id.to_string(), input_tokens, output_tokens, actual_cost.map(|value| i64::try_from(value).unwrap_or(i64::MAX))],
        )
        .map_err(DatabaseError::from)?;
        let proposal_id = Uuid::new_v4();
        transaction.execute(
            "INSERT INTO ai_proposals (id, task_id, chapter_id, action, review_purpose, target_revision_id, context_version, prompt_version, output_text, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'PENDING')",
            rusqlite::params![proposal_id.to_string(), task_id.to_string(), context.chapter_id.to_string(), action_str(context.action), review_purpose, context.target_revision_id.map(|id| id.to_string()), context.context_version, context.prompt_version, output_text],
        ).map_err(DatabaseError::from)?;
        transaction.commit().map_err(DatabaseError::from)?;
        self.prune_ai_request_snapshots().map_err(AiError::from)?;
        self.get_ai_proposal(proposal_id)
    }

    pub fn fail_ai_task(&mut self, task_id: Uuid, error: &AiError) -> Result<(), AiError> {
        self.fail_ai_run(task_id, error)
    }

    pub fn fail_ai_run(&mut self, run_id: Uuid, error: &AiError) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let status = if matches!(error, AiError::Cancelled) {
            "CANCELLED"
        } else {
            "FAILED"
        };
        session
            .database
            .connection
            .execute(
                "UPDATE ai_tasks SET status=?2, error_code=?3, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
                rusqlite::params![run_id.to_string(), status, error.code()],
            )
            .map_err(DatabaseError::from)?;
        session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET status=?2, error_code=?3, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
                rusqlite::params![run_id.to_string(), status, error.code()],
            )
            .map_err(DatabaseError::from)?;
        self.prune_ai_request_snapshots().map_err(AiError::from)?;
        Ok(())
    }

    pub fn complete_ai_run(
        &mut self,
        run_id: Uuid,
        usage: Option<&GenerationUsage>,
        fallback_output_tokens: u32,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let (cache_hit_price, cache_miss_price, output_price): (i64, i64, i64) = session
            .database
            .connection
            .query_row(
                "SELECT input_cache_hit_price_micros_per_million,
                        input_price_micros_per_million, output_price_micros_per_million
                 FROM ai_run_records WHERE id=?1",
                [run_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(DatabaseError::from)?
            .ok_or(AiError::MissingRun(run_id))?;
        let input_tokens = usage.map(|value| value.input_tokens);
        let output_tokens = usage.map_or(fallback_output_tokens, |value| value.output_tokens);
        let actual_cost = usage.and_then(|value| {
            actual_run_cost_micros(
                value,
                u64::try_from(cache_hit_price.max(0)).unwrap_or(0),
                u64::try_from(cache_miss_price.max(0)).unwrap_or(0),
                u64::try_from(output_price.max(0)).unwrap_or(0),
            )
        });
        let changed = session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET status='COMPLETED',
                    estimated_input_tokens=COALESCE(?2, estimated_input_tokens), estimated_output_tokens=?3,
                    actual_cost_micros=?4,
                    finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 WHERE id=?1 AND status='RUNNING'",
                rusqlite::params![run_id.to_string(), input_tokens, output_tokens, actual_cost.map(|value| i64::try_from(value).unwrap_or(i64::MAX))],
            )
            .map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::InvalidResponse);
        }
        self.prune_ai_request_snapshots().map_err(AiError::from)?;
        Ok(())
    }

    pub fn record_ai_task_fallback(
        &mut self,
        task_id: Uuid,
        fallback_profile_id: Uuid,
        reason: &str,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let capability: Option<String> = session
            .database
            .connection
            .query_row(
                "SELECT capability FROM model_profiles WHERE id = ?1",
                [fallback_profile_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        match capability.as_deref() {
            None => return Err(AiError::MissingProfile(fallback_profile_id)),
            Some("CHAT") => {}
            Some(_) => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let changed = session.database.connection.execute(
            "UPDATE ai_tasks SET profile_id=?2, fallback_profile_id=?2, attempt_count=attempt_count+1, retry_reason=?3 WHERE id=?1 AND status='RUNNING'",
            rusqlite::params![task_id.to_string(), fallback_profile_id.to_string(), reason],
        ).map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::InvalidResponse);
        }
        session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET
                profile_id=?2,
                fallback_profile_id=?2,
                attempt_count=attempt_count+1,
                retry_reason=?3,
                input_price_micros_per_million=COALESCE(
                    (SELECT input_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                ),
                output_price_micros_per_million=COALESCE(
                    (SELECT output_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                ),
                price_currency=COALESCE(
                    (SELECT price_currency FROM model_profiles WHERE id=?2), 'USD'
                )
             WHERE id=?1 AND status='RUNNING'",
                rusqlite::params![task_id.to_string(), fallback_profile_id.to_string(), reason],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn record_ai_run_fallback(
        &mut self,
        run_id: Uuid,
        fallback_profile_id: Uuid,
        reason: &str,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let capability: Option<String> = session
            .database
            .connection
            .query_row(
                "SELECT capability FROM model_profiles WHERE id = ?1",
                [fallback_profile_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        match capability.as_deref() {
            None => return Err(AiError::MissingProfile(fallback_profile_id)),
            Some("CHAT") => {}
            Some(_) => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let changed = session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET
                    profile_id=?2,
                    fallback_profile_id=?2,
                    attempt_count=attempt_count+1,
                    retry_reason=?3,
                    input_price_micros_per_million=COALESCE(
                        (SELECT input_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                    ),
                    output_price_micros_per_million=COALESCE(
                        (SELECT output_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                    ),
                    price_currency=COALESCE(
                        (SELECT price_currency FROM model_profiles WHERE id=?2), 'USD'
                    )
                 WHERE id=?1 AND status='RUNNING'",
                rusqlite::params![run_id.to_string(), fallback_profile_id.to_string(), reason],
            )
            .map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::InvalidResponse);
        }
        Ok(())
    }

    pub fn list_ai_runs(&self, limit: Option<u32>) -> Result<Vec<AiRun>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let limit = limit
            .map(|value| i64::from(value.clamp(1, 100)))
            .unwrap_or(-1);
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT t.id, t.action, t.status, t.display_title, COALESCE(NULLIF(TRIM(p.name), ''), '已删除模型'),
                        t.attempt_count, t.retry_reason, t.error_code, t.estimated_input_tokens,
                        t.estimated_output_tokens, t.prompt_version, t.created_at, t.finished_at,
                        t.task_key, t.source, t.input_price_micros_per_million,
                        t.output_price_micros_per_million, t.price_currency, t.chapter_id,
                        t.review_purpose, t.actual_cost_micros
                 FROM ai_run_records t
                 LEFT JOIN model_profiles p ON p.id = t.profile_id
                 ORDER BY t.created_at DESC, t.rowid DESC
                 LIMIT ?1",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([limit], |row| {
                let id = Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(AiRun {
                    id,
                    task_key: row.get(13)?,
                    source: row.get(14)?,
                    action: row.get(1)?,
                    status: row.get(2)?,
                    chapter_id: row.get(18)?,
                    review_purpose: match row.get::<_, String>(19)?.as_str() {
                        "MANUSCRIPT" => ReviewPurpose::Manuscript,
                        _ => ReviewPurpose::Admission,
                    },
                    chapter_title: row.get(3)?,
                    profile_name: row.get(4)?,
                    attempt_count: row.get(5)?,
                    retry_reason: row.get(6)?,
                    error_code: row.get(7)?,
                    estimated_input_tokens: row.get(8)?,
                    estimated_output_tokens: row.get(9)?,
                    estimated_cost_micros: row
                        .get::<_, Option<i64>>(20)?
                        .and_then(|value| u64::try_from(value.max(0)).ok())
                        .or(estimate_run_cost_micros(
                            row.get(8)?,
                            row.get(9)?,
                            u64::try_from(row.get::<_, i64>(15)?.max(0)).unwrap_or(0),
                            u64::try_from(row.get::<_, i64>(16)?.max(0)).unwrap_or(0),
                        )),
                    price_currency: row.get(17)?,
                    prompt_version: row.get(10)?,
                    created_at: row.get(11)?,
                    finished_at: row.get(12)?,
                })
            })
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn get_ai_usage_summary(&self, days: u32) -> Result<AiUsageSummary, AiError> {
        let days = days.clamp(1, 365);
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut total_by_currency = HashMap::<String, UsageAggregate>::new();
        let mut total_by_task = HashMap::<(String, String), UsageAggregate>::new();
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT task_key, estimated_input_tokens, estimated_output_tokens,
                        input_price_micros_per_million, output_price_micros_per_million,
                        price_currency, actual_cost_micros
                 FROM ai_run_records",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], |row| {
                Ok(UsageRunRow {
                    task_key: row.get(0)?,
                    input_tokens: u64::from(row.get::<_, u32>(1)?),
                    output_tokens: u64::from(row.get::<_, u32>(2)?),
                    input_price: u64::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                    output_price: u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                    currency: row.get(5)?,
                    actual_cost_micros: row
                        .get::<_, Option<i64>>(6)?
                        .and_then(|value| u64::try_from(value.max(0)).ok()),
                    date: None,
                })
            })
            .map_err(DatabaseError::from)?;
        for row in rows {
            let row = row.map_err(DatabaseError::from)?;
            total_by_currency
                .entry(row.currency.clone())
                .or_default()
                .add(&row);
            total_by_task
                .entry((row.task_key.clone(), row.currency.clone()))
                .or_default()
                .add(&row);
        }

        let modifier = format!("-{} days", days.saturating_sub(1));
        let mut daily_by_currency = HashMap::<(String, String), UsageAggregate>::new();
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT task_key, estimated_input_tokens, estimated_output_tokens,
                        input_price_micros_per_million, output_price_micros_per_million,
                        price_currency, date(created_at, 'localtime'), actual_cost_micros
                 FROM ai_run_records
                 WHERE date(created_at, 'localtime') >= date('now', 'localtime', ?1)",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([modifier], |row| {
                Ok(UsageRunRow {
                    task_key: row.get(0)?,
                    input_tokens: u64::from(row.get::<_, u32>(1)?),
                    output_tokens: u64::from(row.get::<_, u32>(2)?),
                    input_price: u64::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                    output_price: u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                    currency: row.get(5)?,
                    date: Some(row.get(6)?),
                    actual_cost_micros: row
                        .get::<_, Option<i64>>(7)?
                        .and_then(|value| u64::try_from(value.max(0)).ok()),
                })
            })
            .map_err(DatabaseError::from)?;
        for row in rows {
            let row = row.map_err(DatabaseError::from)?;
            let date = row.date.clone().ok_or(AiError::InvalidResponse)?;
            daily_by_currency
                .entry((date, row.currency.clone()))
                .or_default()
                .add(&row);
        }

        let mut total = total_by_currency
            .into_iter()
            .map(|(currency, aggregate)| aggregate.into_currency(currency))
            .collect::<Vec<_>>();
        total.sort_by(|left, right| left.currency.cmp(&right.currency));
        let mut daily = daily_by_currency
            .into_iter()
            .map(|((date, currency), aggregate)| AiUsageDailySummary {
                date,
                usage: aggregate.into_currency(currency),
            })
            .collect::<Vec<_>>();
        daily.sort_by(|left, right| {
            right
                .date
                .cmp(&left.date)
                .then_with(|| left.usage.currency.cmp(&right.usage.currency))
        });
        let mut by_task = total_by_task
            .into_iter()
            .map(|((task_key, currency), aggregate)| AiUsageTaskSummary {
                task_key,
                usage: aggregate.into_currency(currency),
            })
            .collect::<Vec<_>>();
        by_task.sort_by(|left, right| {
            left.task_key
                .cmp(&right.task_key)
                .then_with(|| left.usage.currency.cmp(&right.usage.currency))
        });
        Ok(AiUsageSummary {
            days,
            total,
            daily,
            by_task,
        })
    }

    pub fn get_ai_quality_summary(
        &self,
        limit: u32,
        days: Option<u32>,
    ) -> Result<AiQualitySummary, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let date_modifier =
            days.map(|days| format!("-{} days", days.clamp(1, 3_650).saturating_sub(1)));
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT r.task_key, r.action, r.prompt_version,
                        COALESCE(NULLIF(TRIM(p.name), ''), '已删除模型'), pr.status, pr.output_text,
                        f.rating
                 FROM ai_proposals pr
                 INNER JOIN ai_run_records r ON r.id = pr.task_id
                 LEFT JOIN model_profiles p ON p.id = r.profile_id
                 LEFT JOIN ai_proposal_feedback f ON f.proposal_id = pr.id
                 WHERE (?1 IS NULL OR date(r.created_at, 'localtime') >= date('now', 'localtime', ?1))",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map(rusqlite::params![date_modifier.as_deref()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(DatabaseError::from)?;
        let mut groups = HashMap::<(String, String, String, String), QualityAggregate>::new();
        for row in rows {
            let (task_key, action, prompt_version, profile_name, status, output_text, rating) =
                row.map_err(DatabaseError::from)?;
            let validation = validate_ai_output(parse_action(&action), &output_text);
            let aggregate = groups
                .entry((task_key, action, prompt_version, profile_name))
                .or_default();
            aggregate.proposals = aggregate.proposals.saturating_add(1);
            if matches!(status.as_str(), "ACCEPTED" | "PARTIALLY_ACCEPTED") {
                aggregate.accepted = aggregate.accepted.saturating_add(1);
            }
            match rating.as_deref() {
                Some("HELPFUL") => {
                    aggregate.rated = aggregate.rated.saturating_add(1);
                    aggregate.helpful = aggregate.helpful.saturating_add(1);
                }
                Some("NOT_HELPFUL") => {
                    aggregate.rated = aggregate.rated.saturating_add(1);
                    aggregate.not_helpful = aggregate.not_helpful.saturating_add(1);
                }
                _ => {}
            }
            match validation.status.as_str() {
                "VALID" => aggregate.valid = aggregate.valid.saturating_add(1),
                "WARNING" => aggregate.warnings = aggregate.warnings.saturating_add(1),
                "NEEDS_INPUT" => {
                    aggregate.needs_input = aggregate.needs_input.saturating_add(1);
                }
                _ => aggregate.invalid = aggregate.invalid.saturating_add(1),
            }
        }

        let mut summary = AiQualitySummary {
            total_proposals: 0,
            total_rated: 0,
            total_helpful: 0,
            total_with_issues: 0,
            groups: Vec::new(),
        };
        for ((task_key, action, prompt_version, profile_name), aggregate) in groups {
            summary.total_proposals = summary.total_proposals.saturating_add(aggregate.proposals);
            summary.total_rated = summary.total_rated.saturating_add(aggregate.rated);
            summary.total_helpful = summary.total_helpful.saturating_add(aggregate.helpful);
            summary.total_with_issues = summary
                .total_with_issues
                .saturating_add(aggregate.warnings)
                .saturating_add(aggregate.needs_input)
                .saturating_add(aggregate.invalid);
            summary.groups.push(AiQualityGroup {
                task_key,
                action,
                prompt_version,
                profile_name,
                proposal_count: aggregate.proposals,
                accepted_count: aggregate.accepted,
                rated_count: aggregate.rated,
                helpful_count: aggregate.helpful,
                not_helpful_count: aggregate.not_helpful,
                valid_count: aggregate.valid,
                warning_count: aggregate.warnings,
                needs_input_count: aggregate.needs_input,
                invalid_count: aggregate.invalid,
            });
        }
        summary.groups.sort_by(|left, right| {
            right
                .proposal_count
                .cmp(&left.proposal_count)
                .then_with(|| left.task_key.cmp(&right.task_key))
                .then_with(|| left.prompt_version.cmp(&right.prompt_version))
                .then_with(|| left.profile_name.cmp(&right.profile_name))
        });
        summary
            .groups
            .truncate(usize::try_from(limit.clamp(1, 100)).unwrap_or(100));
        Ok(summary)
    }

    pub fn list_ai_proposals(
        &self,
        chapter_id: Uuid,
        review_purpose: Option<ReviewPurpose>,
    ) -> Result<Vec<AiProposal>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, task_id, chapter_id, action, review_purpose, target_revision_id, context_version, prompt_version, output_text, accepted_text, status, created_at, decided_at
             FROM ai_proposals
             WHERE chapter_id=?1 AND (?2 IS NULL OR review_purpose=?2)
             ORDER BY created_at DESC"
        ).map_err(DatabaseError::from)?;
        let rows = statement
            .query_map(
                rusqlite::params![
                    chapter_id.to_string(),
                    review_purpose.map(ReviewPurpose::storage_key)
                ],
                read_proposal,
            )
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn list_ai_proposal_reviews(
        &self,
        chapter_id: Uuid,
        review_purpose: Option<ReviewPurpose>,
    ) -> Result<Vec<AiProposalReview>, AiError> {
        let proposals = self.list_ai_proposals(chapter_id, review_purpose)?;
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut feedback = HashMap::new();
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT f.proposal_id, f.rating, f.note, f.created_at, f.updated_at
                 FROM ai_proposal_feedback f
                 INNER JOIN ai_proposals p ON p.id = f.proposal_id
                 WHERE p.chapter_id = ?1",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([chapter_id.to_string()], read_proposal_feedback)
            .map_err(DatabaseError::from)?;
        for item in rows {
            let item = item.map_err(DatabaseError::from)?;
            feedback.insert(item.proposal_id, item);
        }
        Ok(proposals
            .into_iter()
            .map(|proposal| {
                let consistency = (proposal.action == AiAction::ConsistencyCheck)
                    .then(|| parse_consistency_report(&proposal.output_text));
                let has_review_trace = session
                    .database
                    .connection
                    .query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM ai_review_traces WHERE run_id=?1
                         )",
                        [proposal.task_id.to_string()],
                        |row| row.get::<_, i64>(0),
                    )
                    .is_ok_and(|value| value == 1);
                AiProposalReview {
                    validation: validate_ai_output(proposal.action, &proposal.output_text),
                    feedback: feedback.remove(&proposal.id),
                    consistency,
                    consistency_freshness: None,
                    has_review_trace,
                    proposal,
                }
            })
            .collect())
    }

    pub fn mark_consistency_review_freshness(
        reviews: &mut [AiProposalReview],
        current_context_version: Option<&str>,
    ) {
        for review in reviews {
            if review.proposal.action == AiAction::ConsistencyCheck
                && review.proposal.status == AiProposalStatus::Pending
            {
                review.consistency_freshness = Some(match current_context_version {
                    Some(current_context_version)
                        if review.proposal.context_version == current_context_version =>
                    {
                        ConsistencyReviewFreshness::Fresh
                    }
                    Some(_) => ConsistencyReviewFreshness::Stale,
                    None => ConsistencyReviewFreshness::Unverified,
                });
            }
        }
    }

    pub fn chapter_writing_admission(
        &self,
        chapter_id: Uuid,
        current_context_version: Option<&str>,
        policy: WritingReviewPolicy,
    ) -> Result<WritingAdmission, AiError> {
        let Some(review) = self
            .list_ai_proposal_reviews(chapter_id, Some(ReviewPurpose::Admission))?
            .into_iter()
            .find(|item| {
                item.proposal.action == AiAction::ConsistencyCheck
                    && item.proposal.status == AiProposalStatus::Pending
            })
        else {
            let allowed = policy != WritingReviewPolicy::Required;
            return Ok(WritingAdmission {
                allowed,
                blocker_count: 0,
                reason: (!allowed).then(|| {
                    "当前作品要求生成正文前完成一致性审核，请先运行审核并确认结果。".to_owned()
                }),
                review_freshness: ConsistencyReviewFreshness::Missing,
            });
        };
        let freshness = match current_context_version {
            Some(version) if version == review.proposal.context_version => {
                ConsistencyReviewFreshness::Fresh
            }
            Some(_) => ConsistencyReviewFreshness::Stale,
            None => ConsistencyReviewFreshness::Unverified,
        };
        if freshness == ConsistencyReviewFreshness::Stale {
            let allowed = policy != WritingReviewPolicy::Required;
            return Ok(WritingAdmission {
                allowed,
                blocker_count: 0,
                reason: Some(if allowed {
                    "审核依据已经变化，原审核结果已过期，不再参与正文生成准入。".to_owned()
                } else {
                    "审核依据已经变化，当前作品要求重新审核通过后才能生成正文。".to_owned()
                }),
                review_freshness: freshness,
            });
        }
        if freshness == ConsistencyReviewFreshness::Unverified
            && policy == WritingReviewPolicy::Required
        {
            return Ok(WritingAdmission {
                allowed: false,
                blocker_count: 0,
                reason: Some(
                    "系统无法确认现有审核是否对应当前正文与设定，请重新审核后再生成正文。"
                        .to_owned(),
                ),
                review_freshness: freshness,
            });
        }
        let Some(report) = review.consistency else {
            let allowed = policy != WritingReviewPolicy::Required;
            return Ok(WritingAdmission {
                allowed,
                blocker_count: 0,
                reason: (!allowed)
                    .then(|| "现有审核没有可用的审核报告，请重新审核后再生成正文。".to_owned()),
                review_freshness: ConsistencyReviewFreshness::Missing,
            });
        };
        let report_admission = match report.verdict {
            AiConsistencyVerdict::Blocked => {
                let blocker_count = report
                    .findings
                    .iter()
                    .filter(|finding| finding.severity == AiConsistencySeverity::Blocker)
                    .count();
                WritingAdmission {
                    allowed: false,
                    blocker_count,
                    reason: Some(format!(
                        "最近一次一致性审核发现 {blocker_count} 个阻断问题，请先处理并关闭审核后再生成正文。"
                    )),
                    review_freshness: freshness,
                }
            }
            AiConsistencyVerdict::NeedsInput => WritingAdmission {
                allowed: true,
                blocker_count: 0,
                reason: Some(
                    "最近一次一致性审核发现部分正式依据未记录或无法确认。未知项可以保留，不会阻断正文生成。"
                        .to_owned(),
                ),
                review_freshness: freshness,
            },
            AiConsistencyVerdict::Unparsed if policy == WritingReviewPolicy::Required => {
                WritingAdmission {
                    allowed: false,
                    blocker_count: 0,
                    reason: Some(
                        "当前作品要求审核结论可解析，请重新审核并确认报告格式。".to_owned(),
                    ),
                    review_freshness: freshness,
                }
            }
            AiConsistencyVerdict::Pass
            | AiConsistencyVerdict::Review
            | AiConsistencyVerdict::Unparsed => WritingAdmission {
                allowed: true,
                blocker_count: 0,
                reason: None,
                review_freshness: freshness,
            },
        };
        if policy == WritingReviewPolicy::Advisory {
            return Ok(WritingAdmission {
                allowed: true,
                blocker_count: report_admission.blocker_count,
                reason: (!report_admission.allowed)
                    .then(|| "当前作品的一致性审核仅作建议，不阻止生成正文。".to_owned()),
                review_freshness: freshness,
            });
        }
        Ok(report_admission)
    }

    pub fn rate_ai_proposal(
        &mut self,
        proposal_id: Uuid,
        rating: AiProposalFeedbackRating,
        note: Option<String>,
    ) -> Result<AiProposalFeedback, AiError> {
        let _ = self.get_ai_proposal(proposal_id)?;
        let note = note.filter(|value| !value.trim().is_empty());
        if note
            .as_deref()
            .is_some_and(|value| value.chars().count() > 2_000)
        {
            return Err(AiContractError::InvalidGenerationOptions.into());
        }
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .execute(
                "INSERT INTO ai_proposal_feedback (proposal_id, rating, note)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(proposal_id) DO UPDATE SET
                    rating=excluded.rating,
                    note=excluded.note,
                    updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![proposal_id.to_string(), feedback_rating_str(rating), note],
            )
            .map_err(DatabaseError::from)?;
        self.get_ai_proposal_feedback(proposal_id)?
            .ok_or(AiError::InvalidResponse)
    }

    pub fn get_ai_proposal_feedback(
        &self,
        proposal_id: Uuid,
    ) -> Result<Option<AiProposalFeedback>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .query_row(
                "SELECT proposal_id, rating, note, created_at, updated_at
                 FROM ai_proposal_feedback WHERE proposal_id=?1",
                [proposal_id.to_string()],
                read_proposal_feedback,
            )
            .optional()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn decide_ai_proposal(
        &mut self,
        id: Uuid,
        status: AiProposalStatus,
        accepted_text: Option<String>,
    ) -> Result<AiProposal, AiError> {
        let current = self.get_ai_proposal(id)?;
        if current.status != AiProposalStatus::Pending || status == AiProposalStatus::Pending {
            return Err(AiContractError::InvalidProposalTransition.into());
        }
        if current.action == AiAction::ConsistencyCheck && status != AiProposalStatus::Rejected {
            return Err(AiContractError::InvalidProposalTransition.into());
        }
        if status != AiProposalStatus::Rejected
            && validate_ai_output(current.action, &current.output_text).status == "NEEDS_INPUT"
        {
            return Err(AiContractError::InvalidProposalTransition.into());
        }
        let accepted = match status {
            AiProposalStatus::Accepted => Some(current.output_text.clone()),
            AiProposalStatus::PartiallyAccepted => {
                let text = accepted_text
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(AiContractError::EmptyAcceptedText)?;
                Some(text)
            }
            AiProposalStatus::Rejected => None,
            AiProposalStatus::Pending => unreachable!(),
        };
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session.database.connection.execute(
            "UPDATE ai_proposals SET status=?2, accepted_text=?3, decided_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
            rusqlite::params![id.to_string(), proposal_status_str(status), accepted],
        ).map_err(DatabaseError::from)?;
        self.get_ai_proposal(id)
    }

    fn get_ai_proposal(&self, id: Uuid) -> Result<AiProposal, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session.database.connection.query_row(
            "SELECT id, task_id, chapter_id, action, review_purpose, target_revision_id, context_version, prompt_version, output_text, accepted_text, status, created_at, decided_at FROM ai_proposals WHERE id=?1",
            [id.to_string()], read_proposal,
        ).optional().map_err(DatabaseError::from)?.ok_or(AiError::MissingProposal(id))
    }
}
