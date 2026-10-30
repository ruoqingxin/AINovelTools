use novel_infrastructure::{AiError, ModelProfile, ModelProfileInput, ProjectManager};

pub(crate) enum AiRecordKind {
    Run,
    Task,
}

pub(crate) fn sync_model_profile(
    manager: &mut ProjectManager,
    profile: &ModelProfile,
) -> Result<(), AiError> {
    manager.upsert_model_profile(ModelProfileInput {
        id: Some(profile.id),
        name: profile.name.clone(),
        provider: profile.provider,
        capability: profile.capability,
        base_url: profile.base_url.clone(),
        model_id: profile.model_id.clone(),
        context_window: profile.context_window,
        max_output_tokens: profile.max_output_tokens,
        privacy_level: profile.privacy_level,
        timeout_seconds: profile.timeout_seconds,
        retry_limit: profile.retry_limit,
        input_price_micros_per_million: profile.input_price_micros_per_million,
        output_price_micros_per_million: profile.output_price_micros_per_million,
        price_currency: profile.price_currency.clone(),
    })?;
    manager.set_model_profile_secret_ref(profile.id, profile.secret_ref.as_deref())?;
    Ok(())
}

pub(crate) fn sync_and_record_ai_fallback(
    manager: &mut ProjectManager,
    run_id: uuid::Uuid,
    kind: AiRecordKind,
    profile: &ModelProfile,
    reason: &str,
) -> Result<(), AiError> {
    // Global settings and project history use separate databases.
    sync_model_profile(manager, profile)?;
    match kind {
        AiRecordKind::Run => manager.record_ai_run_fallback(run_id, profile.id, reason),
        AiRecordKind::Task => manager.record_ai_task_fallback(run_id, profile.id, reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use novel_infrastructure::{
        AiAction, AiRunSource, AiRunStart, AiTaskKind, ModelCapability, ModelProfileStore,
        ModelProvider, PlanNodeKind, PrivacyLevel,
    };

    struct Fixture {
        root: std::path::PathBuf,
        manager: ProjectManager,
        profiles: ModelProfileStore,
        _cleanup: DirectoryCleanup,
    }

    struct DirectoryCleanup(std::path::PathBuf);

    impl Drop for DirectoryCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ainovel-model-sync-{}", uuid::Uuid::new_v4()));
            let profiles = ModelProfileStore::open(root.join("settings.sqlite")).unwrap();
            let mut manager = ProjectManager::new();
            manager.create(root.join("first"), "First project").unwrap();
            Self {
                _cleanup: DirectoryCleanup(root.clone()),
                root,
                manager,
                profiles,
            }
        }

        fn profile(&mut self, name: &str) -> ModelProfile {
            self.profiles
                .upsert(ModelProfileInput {
                    id: None,
                    name: name.into(),
                    provider: ModelProvider::OpenAiCompatible,
                    capability: ModelCapability::Chat,
                    base_url: "http://127.0.0.1:1/v1".into(),
                    model_id: name.into(),
                    context_window: 8192,
                    max_output_tokens: 1024,
                    privacy_level: PrivacyLevel::AllowCloud,
                    timeout_seconds: 10,
                    retry_limit: 0,
                    input_price_micros_per_million: 1_000_000,
                    output_price_micros_per_million: 2_000_000,
                    price_currency: "USD".into(),
                })
                .unwrap()
        }

        fn start_run(&mut self, profile: &ModelProfile) -> uuid::Uuid {
            sync_model_profile(&mut self.manager, profile).unwrap();
            self.manager
                .start_ai_run(AiRunStart {
                    task: AiTaskKind::KnowledgeExtraction,
                    source: AiRunSource::KnowledgeExtraction,
                    job_id: None,
                    chapter_id: None,
                    display_title: "Fixture extraction",
                    profile_id: profile.id,
                    prompt_version: "sync-test",
                    estimated_input_tokens: 100,
                })
                .unwrap()
        }
    }

    #[test]
    fn syncs_latest_global_settings_and_secret_reference_in_each_project() {
        let mut fixture = Fixture::new();
        let profile = fixture.profile("Primary");
        assert!(fixture.manager.list_model_profiles().unwrap().is_empty());
        let old_run = fixture.start_run(&profile);
        fixture.manager.complete_ai_run(old_run, None, 10).unwrap();

        let mut updated = profile.clone();
        updated.name = "Updated primary".into();
        updated.model_id = "updated-model".into();
        updated.base_url = "http://127.0.0.1:2/v1".into();
        updated.context_window = 16384;
        updated.max_output_tokens = 2048;
        updated.timeout_seconds = 30;
        updated.retry_limit = 2;
        updated.input_price_micros_per_million = 3_000_000;
        updated.output_price_micros_per_million = 4_000_000;
        updated.price_currency = "CNY".into();
        updated.secret_ref = Some("synthetic-reference-only".into());
        fixture
            .manager
            .create(fixture.root.join("second"), "Second project")
            .unwrap();
        assert!(fixture.manager.list_model_profiles().unwrap().is_empty());
        fixture.start_run(&updated);
        let saved = fixture.manager.get_model_profile(profile.id).unwrap();
        let mut expected = serde_json::to_value(&updated).unwrap();
        let mut actual = serde_json::to_value(saved).unwrap();
        for value in [&mut expected, &mut actual] {
            let object = value.as_object_mut().unwrap();
            object.remove("createdAt");
            object.remove("updatedAt");
            object.remove("hasSecret");
        }
        assert_eq!(actual, expected);

        fixture.manager.open(fixture.root.join("first")).unwrap();
        fixture.start_run(&updated);
        let runs = fixture.manager.list_ai_runs(None).unwrap();
        let historical = runs.iter().find(|run| run.id == old_run).unwrap();
        assert_eq!(historical.price_currency, "USD");
        assert_eq!(historical.estimated_cost_micros, Some(120));
        updated.secret_ref = None;
        sync_model_profile(&mut fixture.manager, &updated).unwrap();
        assert!(
            fixture
                .manager
                .get_model_profile(profile.id)
                .unwrap()
                .secret_ref
                .is_none()
        );
        assert_eq!(fixture.profiles.list().unwrap().len(), 1);
    }

    #[test]
    fn records_unsynced_fallback_before_failed_run_and_preserves_reason_and_prices() {
        let mut fixture = Fixture::new();
        let primary = fixture.profile("Primary");
        let mut fallback = fixture.profile("Fallback");
        fallback.price_currency = "CNY".into();
        fallback.output_price_micros_per_million = 4_000_000;
        let run_id = fixture.start_run(&primary);
        assert!(matches!(
            fixture.manager.get_model_profile(fallback.id),
            Err(AiError::MissingProfile(_))
        ));
        sync_and_record_ai_fallback(
            &mut fixture.manager,
            run_id,
            AiRecordKind::Run,
            &fallback,
            "PROVIDER_UNAVAILABLE",
        )
        .unwrap();
        fixture
            .manager
            .fail_ai_run(run_id, &AiError::Authentication)
            .unwrap();
        let runs = fixture.manager.list_ai_runs(None).unwrap();
        let run = &runs[0];
        assert_eq!(run.status, "FAILED");
        assert_eq!(run.profile_name, "Fallback");
        assert_eq!(run.attempt_count, 2);
        assert_eq!(run.retry_reason.as_deref(), Some("PROVIDER_UNAVAILABLE"));
        assert_eq!(run.error_code.as_deref(), Some("PROVIDER_AUTHENTICATION"));
        assert_eq!(run.price_currency, "CNY");
    }

    #[test]
    fn task_fallback_syncs_both_task_and_usage_record_without_duplicate_attempts() {
        let mut fixture = Fixture::new();
        let primary = fixture.profile("Primary");
        let fallback = fixture.profile("Fallback");
        sync_model_profile(&mut fixture.manager, &primary).unwrap();
        let chapter = fixture
            .manager
            .create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into())
            .unwrap();
        let mut context = novel_application::ContextPackage::connection_test();
        context.chapter_id = chapter.id;
        context.action = AiAction::Draft;
        let task_id = fixture
            .manager
            .create_ai_task(primary.id, &context, None)
            .unwrap();
        sync_and_record_ai_fallback(
            &mut fixture.manager,
            task_id,
            AiRecordKind::Task,
            &fallback,
            "PROVIDER_TIMEOUT",
        )
        .unwrap();
        fixture
            .manager
            .fail_ai_task(task_id, &AiError::Authentication)
            .unwrap();
        let runs = fixture.manager.list_ai_runs(None).unwrap();
        assert_eq!(runs[0].profile_name, "Fallback");
        assert_eq!(runs[0].attempt_count, 2);
        assert_eq!(runs[0].retry_reason.as_deref(), Some("PROVIDER_TIMEOUT"));
        assert_eq!(runs[0].status, "FAILED");
    }
}
