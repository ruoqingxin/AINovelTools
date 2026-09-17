use super::*;

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    use std::time::Duration;

    fn serve(body: &'static str, content_type: &'static str, delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock provider");
        let address = listener.local_addr().expect("mock address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0_u8; 16_384];
            let _ = stream.read(&mut request);
            std::thread::sleep(delay);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://{address}/v1")
    }

    fn profile(base_url: String, timeout_seconds: u32) -> novel_domain::ModelProfile {
        novel_domain::ModelProfile {
            id: uuid::Uuid::new_v4(),
            name: "mock".into(),
            provider: novel_domain::ModelProvider::OpenAiCompatible,
            capability: novel_domain::ModelCapability::Chat,
            base_url,
            model_id: "mock-model".into(),
            context_window: 4_096,
            max_output_tokens: 512,
            privacy_level: novel_domain::PrivacyLevel::AllowCloud,
            timeout_seconds,
            retry_limit: 0,
            input_price_micros_per_million: 0,
            output_price_micros_per_million: 0,
            price_currency: "USD".into(),
            secret_ref: None,
            has_secret: false,
            created_at: "0".into(),
            updated_at: "0".into(),
        }
    }

    fn context() -> novel_application::ContextPackage {
        novel_application::ContextPackage::connection_test()
    }

    #[test]
    fn writing_actions_round_trip() {
        for action in [
            novel_domain::AiAction::Draft,
            novel_domain::AiAction::Continue,
            novel_domain::AiAction::Rewrite,
            novel_domain::AiAction::Polish,
            novel_domain::AiAction::Summarize,
            novel_domain::AiAction::ConsistencyCheck,
        ] {
            assert_eq!(super::parse_action(super::action_str(action)), action);
        }
    }

    #[test]
    fn reads_provider_reported_token_usage() {
        let usage = super::response_usage(&serde_json::json!({
            "usage": {
                "prompt_tokens": 123,
                "completion_tokens": 45,
                "prompt_cache_hit_tokens": 80,
                "prompt_cache_miss_tokens": 43
            }
        }))
        .expect("usage");
        assert_eq!(usage.input_tokens, 123);
        assert_eq!(usage.output_tokens, 45);
        assert_eq!(usage.input_cache_hit_tokens, Some(80));
        assert_eq!(usage.input_cache_miss_tokens, Some(43));
    }

    #[test]
    fn calculates_exact_cost_from_cache_usage() {
        let cost = super::actual_run_cost_micros(
            &super::GenerationUsage {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                input_cache_hit_tokens: Some(500_000),
                input_cache_miss_tokens: Some(500_000),
            },
            20_000,
            1_000_000,
            4_000_000,
        );
        assert_eq!(cost, Some(4_510_000));
    }

    #[test]
    fn run_history_keeps_records_after_model_profile_is_deleted() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-ai-run-history-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager
            .create(&root, "运行记录测试")
            .expect("create project");
        let profile = manager
            .upsert_model_profile(super::ModelProfileInput {
                id: None,
                name: "待删除模型".into(),
                provider: super::ModelProvider::DeepSeek,
                capability: super::ModelCapability::Chat,
                base_url: "https://api.deepseek.com".into(),
                model_id: "deepseek-chat".into(),
                context_window: 32_768,
                max_output_tokens: 4_096,
                privacy_level: super::PrivacyLevel::AllowCloud,
                timeout_seconds: 30,
                retry_limit: 1,
                input_price_micros_per_million: 1_000_000,
                output_price_micros_per_million: 2_000_000,
                price_currency: "CNY".into(),
            })
            .expect("create model profile");
        let run_id = manager
            .start_ai_run(super::AiRunStart {
                task: super::AiTaskKind::WorkDesign,
                source: super::AiRunSource::Planning,
                job_id: None,
                chapter_id: None,
                display_title: "保留运行记录",
                profile_id: profile.id,
                prompt_version: "test-v1",
                estimated_input_tokens: 128,
            })
            .expect("start run");
        manager
            .current
            .as_ref()
            .expect("project session")
            .database
            .connection
            .execute(
                "DELETE FROM model_profiles WHERE id=?1",
                [profile.id.to_string()],
            )
            .expect("delete model profile");

        let runs = manager
            .list_ai_runs(Some(10))
            .expect("list run history");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run_id);
        assert_eq!(runs[0].profile_name, "已删除模型");

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn context_insufficient_output_requires_input_instead_of_becoming_prose() {
        let validation = super::validate_ai_output(
            novel_domain::AiAction::Draft,
            "[上下文不足]\n- 主角卡：未建立\n- 境界规则：缺失",
        );
        assert_eq!(validation.status, "NEEDS_INPUT");
        assert!(
            validation
                .messages
                .iter()
                .any(|message| message.contains("没有生成可用结果"))
        );
    }

    #[test]
    fn consistency_report_parser_classifies_findings_and_admission() {
        let report = super::parse_consistency_report(
            "审核结论：阻断\n[阻断] 主角姓名未确定｜主角卡未建立｜先确定主角姓名并建立主角卡。\n[提示] 开场动机可以更具体｜执行卡只写了寻找师父｜补充动机来源。",
        );
        assert_eq!(report.verdict, super::AiConsistencyVerdict::Blocked);
        assert_eq!(report.findings.len(), 2);
        assert_eq!(
            report.findings[0].severity,
            super::AiConsistencySeverity::Blocker
        );
        assert_eq!(report.findings[0].problem, "主角姓名未确定");
        assert_eq!(report.findings[0].evidence, "主角卡未建立");
        assert_eq!(
            report.findings[0].suggestion,
            "先确定主角姓名并建立主角卡。"
        );

        let passed = super::parse_consistency_report("审核结论：通过（未发现冲突）");
        assert_eq!(passed.verdict, super::AiConsistencyVerdict::Pass);

        let incomplete = super::parse_consistency_report("[严重] 境界边界冲突");
        assert_eq!(incomplete.findings.len(), 1);
        assert!(!incomplete.parse_warnings.is_empty());
    }

    #[test]
    fn provider_statuses_are_stable() {
        assert_eq!(
            super::map_status(reqwest::StatusCode::UNAUTHORIZED).code(),
            "PROVIDER_AUTHENTICATION"
        );
        assert_eq!(
            super::map_status(reqwest::StatusCode::TOO_MANY_REQUESTS).code(),
            "PROVIDER_RATE_LIMITED"
        );
        assert_eq!(
            super::provider_str(novel_domain::ModelProvider::SiliconFlow),
            "SILICON_FLOW"
        );
    }

    #[test]
    fn ai_task_defaults_match_product_recommendations() {
        let cases: [(super::AiTaskKind, f64, u32); 8] = [
            (super::AiTaskKind::WorkDesign, 0.45, 4_096),
            (super::AiTaskKind::Outline, 0.6, 6_144),
            (super::AiTaskKind::VolumePlanning, 0.55, 6_144),
            (super::AiTaskKind::ChapterSplit, 0.3, 4_096),
            (super::AiTaskKind::ChapterPlan, 0.35, 4_096),
            (super::AiTaskKind::ConsistencyReview, 0.2, 8_192),
            (super::AiTaskKind::Writing, 0.9, 8_192),
            (super::AiTaskKind::KnowledgeExtraction, 0.1, 4_096),
        ];

        for (task, temperature, max_output_tokens) in cases {
            assert_eq!(task.default_temperature().to_bits(), temperature.to_bits());
            assert_eq!(task.default_max_output_tokens(), max_output_tokens);
        }
    }

    #[test]
    fn model_profile_store_is_available_without_an_open_project() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        let saved = store
            .upsert(novel_domain::ModelProfileInput {
                id: None,
                name: "应用级模型".into(),
                provider: novel_domain::ModelProvider::DeepSeek,
                capability: novel_domain::ModelCapability::Chat,
                base_url: "https://api.deepseek.com".into(),
                model_id: "deepseek-v4-flash".into(),
                context_window: 128_000,
                max_output_tokens: 8_192,
                privacy_level: novel_domain::PrivacyLevel::AllowCloud,
                timeout_seconds: 120,
                retry_limit: 1,
                input_price_micros_per_million: 2_000_000,
                output_price_micros_per_million: 4_000_000,
                price_currency: "USD".into(),
            })
            .expect("save profile");

        let saved = store
            .set_secret_ref(saved.id, Some("model-profile:test"))
            .expect("save secret reference");
        assert!(saved.has_secret);
        assert_eq!(store.list().expect("list profiles").len(), 1);
    }

    #[test]
    fn ai_task_model_preferences_round_trip_without_an_open_project() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        let chat = store
            .upsert(novel_domain::ModelProfileInput {
                id: None,
                name: "任务模型".into(),
                provider: novel_domain::ModelProvider::DeepSeek,
                capability: novel_domain::ModelCapability::Chat,
                base_url: "https://api.deepseek.com".into(),
                model_id: "deepseek-v4-flash".into(),
                context_window: 128_000,
                max_output_tokens: 8_192,
                privacy_level: novel_domain::PrivacyLevel::AllowCloud,
                timeout_seconds: 120,
                retry_limit: 1,
                input_price_micros_per_million: 2_000_000,
                output_price_micros_per_million: 4_000_000,
                price_currency: "USD".into(),
            })
            .expect("chat profile");
        let fallback = store
            .upsert(novel_domain::ModelProfileInput {
                id: None,
                name: "备用任务模型".into(),
                provider: novel_domain::ModelProvider::OpenAi,
                capability: novel_domain::ModelCapability::Chat,
                base_url: "https://api.openai.com/v1".into(),
                model_id: "gpt-test".into(),
                context_window: 128_000,
                max_output_tokens: 8_192,
                privacy_level: novel_domain::PrivacyLevel::AllowCloud,
                timeout_seconds: 120,
                retry_limit: 1,
                input_price_micros_per_million: 1_000_000,
                output_price_micros_per_million: 2_000_000,
                price_currency: "USD".into(),
            })
            .expect("fallback profile");
        let preference = super::AiTaskPreference {
            profile_id: Some(chat.id),
            fallback_profile_id: Some(fallback.id),
            temperature: Some(0.8),
            max_output_tokens: Some(4_096),
            prompt: super::AiTaskPromptPreference {
                system_prompt: Some("优先保持人物视角一致。".into()),
                instruction_template: Some("章节：{{chapterTitle}}".into()),
                context: super::AiTaskContextPreference {
                    include_project_context: Some(true),
                    include_reference_content: Some(false),
                    include_project_knowledge: Some(true),
                    include_current_draft: Some(false),
                    include_chapter_plan: Some(true),
                    input_token_budget: Some(24_576),
                },
            },
        };
        let preferences = super::AiTaskPreferences {
            work_design: preference.clone(),
            outline: preference.clone(),
            volume_planning: preference.clone(),
            chapter_split: preference.clone(),
            chapter_plan: preference.clone(),
            consistency_review: preference.clone(),
            writing: preference.clone(),
            knowledge_extraction: preference,
        };

        let saved = store
            .save_ai_task_preferences(&preferences)
            .expect("save preferences");
        assert_eq!(saved, preferences);
        assert_eq!(
            store.get_ai_task_preferences().expect("read preferences"),
            preferences
        );
    }

    #[test]
    fn ai_budget_settings_round_trip_and_normalize_currency() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        assert_eq!(
            store.get_ai_budget_settings().expect("default settings"),
            super::AiBudgetSettings::default()
        );
        let saved = store
            .save_ai_budget_settings(&super::AiBudgetSettings {
                currency: " cny ".into(),
                daily_limit_micros: Some(10_000_000),
                project_limit_micros: Some(100_000_000),
            })
            .expect("save budget");
        assert_eq!(saved.currency, "CNY");
        assert_eq!(store.get_ai_budget_settings().expect("read budget"), saved);
    }

    #[test]
    fn ai_task_preferences_read_legacy_profile_ids() {
        let profile_id = uuid::Uuid::new_v4();
        let preferences: super::AiTaskPreferences = serde_json::from_str(&format!(
            r#"{{"workDesign":"{profile_id}","outline":null}}"#
        ))
        .expect("legacy preferences");

        assert_eq!(preferences.work_design.profile_id, Some(profile_id));
        assert_eq!(preferences.work_design.temperature, None);
        assert_eq!(preferences.work_design.max_output_tokens, None);
        assert_eq!(
            preferences.work_design.prompt,
            super::AiTaskPromptPreference::default()
        );
        assert_eq!(preferences.outline, super::AiTaskPreference::default());
    }

    #[test]
    fn ai_task_preferences_read_fills_missing_tuning_with_recommendations() {
        let store = super::ModelProfileStore::in_memory().expect("settings store");
        let profile_id = uuid::Uuid::new_v4();
        store
            .database
            .connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)",
                rusqlite::params![
                    super::AI_TASK_PREFERENCES_KEY,
                    format!(
                        r#"{{"workDesign":"{profile_id}","outline":{{"profileId":null,"temperature":null,"maxOutputTokens":null}}}}"#
                    )
                ],
            )
            .expect("legacy preferences");

        let preferences = store.get_ai_task_preferences().expect("read preferences");

        assert_eq!(preferences.work_design.profile_id, Some(profile_id));
        assert_eq!(preferences.work_design.temperature, Some(0.45));
        assert_eq!(preferences.work_design.max_output_tokens, Some(4_096));
        assert_eq!(preferences.outline.temperature, Some(0.6));
        assert_eq!(preferences.outline.max_output_tokens, Some(6_144));
        assert_eq!(preferences.volume_planning.temperature, Some(0.55));
        assert_eq!(preferences.volume_planning.max_output_tokens, Some(6_144));
        assert_eq!(preferences.chapter_split.temperature, Some(0.3));
        assert_eq!(preferences.chapter_split.max_output_tokens, Some(4_096));
        assert_eq!(preferences.chapter_plan.temperature, Some(0.35));
        assert_eq!(preferences.chapter_plan.max_output_tokens, Some(4_096));
        assert_eq!(preferences.consistency_review.temperature, Some(0.2));
        assert_eq!(
            preferences.consistency_review.max_output_tokens,
            Some(8_192)
        );
        assert_eq!(preferences.writing.temperature, Some(0.9));
        assert_eq!(preferences.writing.max_output_tokens, Some(8_192));
        assert_eq!(preferences.knowledge_extraction.temperature, Some(0.1));
        assert_eq!(
            preferences.knowledge_extraction.max_output_tokens,
            Some(4_096)
        );
    }

    #[test]
    fn ai_task_preferences_save_fills_defaults_without_overriding_user_tuning() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        let mut preferences = super::AiTaskPreferences {
            work_design: super::AiTaskPreference::default(),
            outline: super::AiTaskPreference::default(),
            volume_planning: super::AiTaskPreference::default(),
            chapter_split: super::AiTaskPreference::default(),
            chapter_plan: super::AiTaskPreference::default(),
            consistency_review: super::AiTaskPreference::default(),
            writing: super::AiTaskPreference::default(),
            knowledge_extraction: super::AiTaskPreference::default(),
        };
        preferences.outline.temperature = Some(0.75);
        preferences.outline.max_output_tokens = Some(3_200);
        preferences
            .chapter_split
            .prompt
            .context
            .include_project_knowledge = Some(false);

        let saved = store
            .save_ai_task_preferences(&preferences)
            .expect("save preferences");

        assert_eq!(saved.work_design.temperature, Some(0.45));
        assert_eq!(saved.work_design.max_output_tokens, Some(4_096));
        assert_eq!(saved.outline.temperature, Some(0.75));
        assert_eq!(saved.outline.max_output_tokens, Some(3_200));
        assert_eq!(
            saved.chapter_split.prompt.context.include_project_knowledge,
            Some(false)
        );
        assert_eq!(saved.chapter_plan.temperature, Some(0.35));
        assert_eq!(saved.chapter_plan.max_output_tokens, Some(4_096));
        assert_eq!(saved.consistency_review.temperature, Some(0.2));
        assert_eq!(saved.consistency_review.max_output_tokens, Some(8_192));
        assert_eq!(saved.writing.temperature, Some(0.9));
        assert_eq!(saved.writing.max_output_tokens, Some(8_192));
        assert_eq!(
            store.get_ai_task_preferences().expect("read preferences"),
            saved
        );
    }

    #[test]
    fn task_prompt_preferences_render_variables_and_change_context_versions() {
        let mut context = novel_application::ContextPackage::connection_test();
        let original_prompt_version = context.prompt_version.clone();
        let original_context_version = context.context_version.clone();
        let preference = super::AiTaskPreference {
            prompt: super::AiTaskPromptPreference {
                system_prompt: Some("你是严谨的执行编辑。".into()),
                instruction_template: Some(
                    "章节：{{chapterTitle}}\n作者意见：{{userInstruction}}".into(),
                ),
                context: super::AiTaskContextPreference::default(),
            },
            ..super::AiTaskPreference::default()
        };

        super::apply_task_prompt_preferences(
            &mut context,
            &preference,
            &[
                ("chapterTitle", "雨夜来客"),
                ("userInstruction", "让冲突先藏后露"),
            ],
        );

        assert_eq!(context.system_prompt, "你是严谨的执行编辑。");
        assert!(
            context
                .user_prompt
                .ends_with("[P0 自定义任务模板]\n章节：雨夜来客\n作者意见：让冲突先藏后露")
        );
        assert_ne!(context.prompt_version, original_prompt_version);
        assert_ne!(context.context_version, original_context_version);
    }

    #[test]
    fn request_preview_applies_and_clamps_generation_options() {
        let gateway = super::ModelGateway::default();
        let (_, body) = gateway.request_preview_with_options(
            &profile("https://example.invalid/v1".into(), 9),
            &context(),
            false,
            false,
            super::GenerationOptions {
                temperature: Some(0.5),
                max_output_tokens: Some(99_999),
            },
        );

        assert_eq!(body["temperature"], serde_json::json!(0.5));
        assert_eq!(body["max_tokens"], serde_json::json!(512));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires unsandboxed Windows credential or DPAPI storage access"]
    fn windows_secret_store_round_trips() {
        let secret_ref = format!("test:{}", uuid::Uuid::new_v4());
        super::SecretStore::set(&secret_ref, "temporary-test-secret").expect("write credential");
        assert_eq!(
            super::SecretStore::get(&secret_ref).expect("read credential"),
            "temporary-test-secret"
        );
        super::SecretStore::delete(&secret_ref).expect("delete credential");
    }

    #[tokio::test]
    async fn gateway_reads_non_streaming_and_streaming_responses() {
        let gateway = super::ModelGateway::default();
        let non_stream_url = serve(
            r#"{"choices":[{"message":{"content":"候选正文"}}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(non_stream_url, 3),
                Some("test-key"),
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("non-stream response");
        assert_eq!(output, "候选正文");

        let stream_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"候选\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"正文\"}}]}\n\ndata: [DONE]\n\n",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(stream_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("stream response");
        assert_eq!(output, "候选正文");

        let json_stream_url = serve(
            r#"{"choices":[{"message":{"content":"非流式候选"}}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(json_stream_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("json fallback response");
        assert_eq!(output, "非流式候选");

        let unterminated_stream_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"无结束空行\"}}]}",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(unterminated_stream_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("unterminated stream response");
        assert_eq!(output, "无结束空行");
    }

    #[tokio::test]
    async fn gateway_reports_length_limits_and_interrupted_streams() {
        let gateway = super::ModelGateway::default();
        let length_url = serve(
            r#"{"choices":[{"message":{"content":"正文只写到一半"},"finish_reason":"length"}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let output = gateway
            .generate_detailed(
                &profile(length_url, 3),
                None,
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("length-limited response");
        assert_eq!(output.output, "正文只写到一半");
        assert_eq!(output.completion, super::GenerationCompletion::LengthLimit);
        assert_eq!(output.finish_reason.as_deref(), Some("length"));

        let stream_length_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"流式半截\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate_detailed(
                &profile(stream_length_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("stream length limit");
        assert_eq!(output.output, "流式半截");
        assert_eq!(output.completion, super::GenerationCompletion::LengthLimit);

        let reasoning_only_length_url = serve(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先分析人物、规则和时间线\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate_detailed(
                &profile(reasoning_only_length_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("reasoning-only stream length limit");
        assert!(output.output.is_empty());
        assert_eq!(output.completion, super::GenerationCompletion::LengthLimit);
        assert_eq!(output.finish_reason.as_deref(), Some("length"));

        let interrupted_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"连接中断\"}}]}\n\n",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate_detailed(
                &profile(interrupted_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("interrupted stream");
        assert_eq!(output.output, "连接中断");
        assert_eq!(output.completion, super::GenerationCompletion::Interrupted);

        let stopped_without_done_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"已正常结束\"},\"finish_reason\":\"stop\"}]}\n\n",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate_detailed(
                &profile(stopped_without_done_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("stopped stream without DONE");
        assert_eq!(output.output, "已正常结束");
        assert_eq!(output.completion, super::GenerationCompletion::Complete);
    }

    #[tokio::test]
    async fn deepseek_requests_enable_thinking_mode() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock provider");
        let address = listener.local_addr().expect("mock address");
        let request = Arc::new(Mutex::new(String::new()));
        let request_capture = Arc::clone(&request);
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 16_384];
            let count = stream.read(&mut buffer).expect("read request");
            *request_capture.lock().expect("request lock") =
                String::from_utf8_lossy(&buffer[..count]).into_owned();
            let body = r#"{"choices":[{"message":{"content":"连接成功"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let mut profile = profile(format!("http://{address}/v1"), 3);
        profile.provider = novel_domain::ModelProvider::DeepSeek;
        let output = super::ModelGateway::default()
            .generate(
                &profile,
                Some("test-key"),
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("DeepSeek response");

        assert_eq!(output, "连接成功");
        assert!(
            request
                .lock()
                .expect("request lock")
                .contains(r#""thinking":{"type":"enabled"}"#)
        );
    }

    #[tokio::test]
    async fn gateway_honors_cancellation_and_timeout() {
        let gateway = super::ModelGateway::default();
        let cancelled = Arc::new(AtomicBool::new(true));
        assert!(matches!(
            gateway
                .generate(
                    &profile("https://example.invalid/v1".into(), 3),
                    None,
                    &context(),
                    false,
                    false,
                    cancelled,
                    |_| {},
                )
                .await,
            Err(super::AiError::Cancelled)
        ));

        let timeout_url = serve(
            r#"{"choices":[{"message":{"content":"too late"}}]}"#,
            "application/json",
            Duration::from_millis(1_200),
        );
        let result = gateway
            .generate(
                &profile(timeout_url, 1),
                None,
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await;
        assert!(matches!(result, Err(super::AiError::Timeout)));
    }

    #[tokio::test]
    async fn embedding_gateway_reads_vectors_and_rejects_chat_profiles() {
        let gateway = super::EmbeddingGateway::default();
        let embedding_url = serve(
            r#"{"data":[{"embedding":[0.25,-0.5,0.75]}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let mut embedding_profile = profile(embedding_url, 3);
        embedding_profile.provider = novel_domain::ModelProvider::SiliconFlow;
        embedding_profile.capability = novel_domain::ModelCapability::Embedding;
        let vector = gateway
            .embed(&embedding_profile, "test-key", "测试文本")
            .await
            .expect("embedding");
        assert_eq!(vector, vec![0.25, -0.5, 0.75]);

        let batch_url = serve(
            r#"{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}"#,
            "application/json",
            Duration::ZERO,
        );
        embedding_profile.base_url = batch_url;
        let vectors = gateway
            .embed_many(
                &embedding_profile,
                "test-key",
                &["first".to_owned(), "second".to_owned()],
            )
            .await
            .expect("batch embeddings");
        assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);

        assert!(matches!(
            gateway
                .embed(
                    &profile("https://example.invalid/v1".into(), 3),
                    "test-key",
                    "text"
                )
                .await,
            Err(super::AiError::Contract(
                novel_domain::AiContractError::InvalidProviderCapability
            ))
        ));
    }
}
