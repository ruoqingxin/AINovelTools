//! Opt-in measurements and synthetic project preparation, never provider calls.
use super::*;
use std::collections::HashMap;
use std::time::Instant;

const FIXTURE: &str = include_str!("../../../../tools/fixtures/coauthor-evaluation.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("evaluation fixture")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().expect(key)
}

fn seed_sources(manager: &mut ProjectManager, scope: &CoauthorScope) -> HashMap<String, String> {
    fixture()["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| {
            let entity = manager
                .upsert_entity(EntityInput {
                    id: None,
                    entity_type: EntityType::Concept,
                    name: text(source, "title").into(),
                    aliases: serde_json::from_value(source["aliases"].clone()).unwrap(),
                    description: text(source, "content").into(),
                    fixed_attributes_json: "{\"settingScope\":\"PROJECT\"}".into(),
                    tags: vec![],
                    base_revision_id: None,
                    source_version: None,
                    expected_version: None,
                })
                .unwrap();
            assert_eq!(entity.project_id, scope.project_id);
            (text(source, "id").into(), format!("ENTITY:{}", entity.id))
        })
        .collect()
}

fn seed_noise(manager: &mut ProjectManager, scope: &CoauthorScope, scale: &Value) {
    let db = &manager.current.as_ref().unwrap().database;
    let tx = db.connection.unchecked_transaction().unwrap();
    for index in 0..scale["entities"].as_u64().unwrap() {
        let id = Uuid::new_v4().to_string();
        let revision = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO entities(id,project_id,entity_type,current_revision_id) VALUES (?1,?2,'LOCATION',?3)",
            rusqlite::params![id,scope.project_id.to_string(),revision],
        ).unwrap();
        tx.execute(
            "INSERT INTO entity_revisions(id,entity_id,revision,name,description) VALUES (?1,?2,1,?3,?4)",
            rusqlite::params![revision,id,format!("背景地点{index}"),"山间茶铺只卖清茶，船工在雨中清点绳索。".repeat(80)],
        ).unwrap();
    }
    for index in 0..scale["messages"].as_u64().unwrap() {
        tx.execute(
            "INSERT INTO discussion_messages(id,session_id,role,content) VALUES (?1,?2,'USER',?3)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                scope.session_id.to_string(),
                format!("第{index}次讨论雨日集市与茶铺，不涉及力量体系。")
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    for index in 0..scale["chapters"].as_u64().unwrap() {
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, format!("行旅{index}"))
            .unwrap();
        manager.save_manuscript(chapter.id, serde_json::json!({
            "type":"doc","content":[{"type":"paragraph","attrs":{"id":format!("eval-{index}")},
            "content":[{"type":"text","text":"远山下起细雨，船工收起绳索。".repeat(100)}]}]
        }).to_string(), "synthetic-evaluation".into()).unwrap();
    }
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn emit(value: Value) {
    println!("COAUTHOR_EVAL {value}");
}

#[test]
fn evaluation_fixture_has_unique_cases_and_valid_relevance_labels() {
    let data = fixture();
    let sources = data["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| text(s, "id"))
        .collect::<std::collections::HashSet<_>>();
    let cases = data["cases"].as_array().unwrap();
    let ids = cases
        .iter()
        .map(|c| text(c, "id"))
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), cases.len());
    for case in cases {
        assert!(!case["turns"].as_array().unwrap().is_empty());
        assert!(!case["rubric"].as_array().unwrap().is_empty());
        for id in case["retrieval"]["relevant"].as_array().unwrap() {
            assert!(sources.contains(id.as_str().unwrap()));
        }
    }
}

#[test]
#[ignore = "explicit local evaluation; run alone via pnpm eval:coauthor"]
fn measure_retrieval_baseline() {
    let data = fixture();
    for scale in data["scales"].as_array().unwrap() {
        let (mut manager, root, scope) = tests::project();
        let keys = seed_sources(&mut manager, &scope);
        seed_noise(&mut manager, &scope, scale);
        // Cold means an unbuilt application index, not an OS page-cache flush.
        let start = Instant::now();
        let mut passes = 0;
        let mut pending;
        loop {
            let page = manager
                .search_coauthor_sources(&scope, "境界", false, 0)
                .unwrap();
            pending = page.pending_index_updates;
            passes += 1;
            if pending == 0 {
                break;
            }
            assert!(passes < 100, "index failed to drain");
        }
        emit(
            serde_json::json!({"type":"coldIndex","scale":scale,"elapsedMs":elapsed_ms(start),
            "passes":passes,"pending":pending,"modelRequests":0}),
        );
        for case in data["cases"].as_array().unwrap() {
            let query = text(&case["retrieval"], "query");
            let relevant = case["retrieval"]["relevant"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| keys[id.as_str().unwrap()].clone())
                .collect::<Vec<_>>();
            for sample in 0..30 {
                let start = Instant::now();
                let page = manager
                    .search_coauthor_sources(&scope, query, false, 0)
                    .unwrap();
                let ms = elapsed_ms(start);
                emit(
                    serde_json::json!({"type":"query","scale":scale["name"],"caseId":case["id"],
                    "sample":sample,"elapsedMs":ms,"expectedKeys":relevant,
                    "hits":page.hits.iter().map(|hit|serde_json::json!({
                        "key":hit.key,"chars":hit.content.chars().count(),
                        "utf8Bytes":hit.content.len()
                    })).collect::<Vec<_>>(),"pending":page.pending_index_updates,"hasMore":page.has_more}),
                );
            }
        }
        drop(manager);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "explicit isolated project export; no models or real author projects"]
fn prepare_model_evaluation_projects() {
    let output = PathBuf::from(std::env::var("COAUTHOR_EVAL_EXPORT_ROOT").expect("export root"));
    assert!(
        output.is_absolute() && !output.exists(),
        "must be a fresh absolute directory"
    );
    let parent = output.parent().unwrap().canonicalize().unwrap();
    let workspace_tmp = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.tmp")
        .canonicalize()
        .unwrap();
    assert!(
        parent.starts_with(workspace_tmp),
        "export only under workspace .tmp"
    );
    std::fs::create_dir(&output).unwrap();
    let selected = std::env::var("COAUTHOR_EVAL_CASES").unwrap_or_default();
    for case in fixture()["cases"].as_array().unwrap() {
        let id = text(case, "id");
        if !selected.is_empty() && !selected.split(',').any(|s| s == id) {
            continue;
        }
        let root = output.join(id);
        let mut manager = ProjectManager::new();
        let project = manager
            .create(&root, "Synthetic coauthor evaluation")
            .unwrap();
        let session = manager
            .create_discussion_session(id.into(), DiscussionScopeKind::Project, None, None)
            .unwrap();
        let scope = CoauthorScope {
            project_id: project.project_id,
            session_id: session.id,
        };
        let keys = seed_sources(&mut manager, &scope);
        let mut document = manager.coauthor_state(&scope).unwrap().document;
        document.content = case["draft"].as_str().unwrap_or_default().into();
        document.narrative_position = case["narrativePosition"]
            .as_str()
            .unwrap_or_default()
            .into();
        document.kind = CoauthorDocumentKind::Manuscript;
        let document = manager.save_coauthor_document(&scope, document).unwrap();
        let mut decisions = HashMap::<String, CoauthorDecision>::new();
        for decision in case["decisions"].as_array().into_iter().flatten() {
            let topic = text(decision, "topic");
            let quote = format!(
                "关于{topic}，明确决定：{}，状态为{}。",
                text(decision, "content"),
                text(decision, "status")
            );
            let run = manager
                .start_coauthor_run(&scope, Uuid::new_v4(), &quote, document.version)
                .unwrap();
            let previous = decisions.get(topic);
            let saved = manager
                .set_coauthor_decision(
                    &scope,
                    run.id,
                    CoauthorDecisionInput {
                        decision_id: previous.map(|d| d.id),
                        expected_version: previous.map_or(0, |d| d.version),
                        topic: topic.into(),
                        aliases: vec![],
                        content: text(decision, "content").into(),
                        status: text(decision, "status").into(),
                        quote,
                    },
                )
                .unwrap();
            decisions.insert(topic.into(), saved);
            manager
                .finish_coauthor_run(&scope, run.id, "COMPLETED", "已记录作者决定。", &[])
                .unwrap();
        }
        for index in 0..case["historyMessages"].as_u64().unwrap_or(0) {
            manager
                .append_discussion_message(
                    scope.session_id,
                    DiscussionMessageRole::User,
                    format!("第{index}轮只讨论茶铺颜色，不更改已定规则。"),
                    None,
                    None,
                    None,
                )
                .unwrap();
        }
        if let Some(secret) = case["otherBranchSecret"].as_str() {
            let other = manager
                .create_discussion_session(
                    "隔离分支".into(),
                    DiscussionScopeKind::Project,
                    None,
                    None,
                )
                .unwrap();
            manager
                .append_discussion_message(
                    other.id,
                    DiscussionMessageRole::User,
                    secret.into(),
                    None,
                    None,
                    None,
                )
                .unwrap();
        }
        emit(
            serde_json::json!({"type":"project","caseId":id,"root":root,"scope":scope,
            "sources":keys,"document":document,"modelRequests":0}),
        );
    }
}
