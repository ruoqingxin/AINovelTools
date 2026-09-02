#![allow(clippy::needless_pass_by_value, clippy::too_many_lines)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

mod commands;
mod errors;
mod state;

use commands::ai::{
    assemble_context_with_project_knowledge, cancel_ai_task, decide_ai_proposal,
    delete_model_secret, generate_ai_proposal, list_ai_proposals, list_model_profiles,
    save_model_secret, test_model_profile, upsert_model_profile,
};
use commands::core::{bootstrap_status, feature_catalog, health_query};
use commands::entities::{
    list_entities, list_entity_revisions, set_entity_archived, upsert_entity,
};
use commands::jobs::{
    cancel_job, claim_next_job, create_diagnostic_package, enqueue_job, health_scan, list_jobs,
    retry_job, run_next_job, startup_recovery_report,
};
use commands::knowledge::{
    create_belief, create_event, create_evidence_anchor, create_foreshadowing,
    create_knowledge_candidate, create_relation, detect_candidate_conflicts,
    finalize_knowledge_candidates, list_beliefs, list_current_facts, list_events,
    list_evidence_anchors, list_foreshadowings, list_knowledge_candidates, list_relations,
    rebuild_world_state, review_knowledge_candidate, update_belief, update_event,
    update_foreshadowing, update_relation,
};
use commands::manuscript::{
    clear_recovery_logs, current_manuscript, list_all_recovery_logs, list_manuscript_revisions,
    list_recovery_logs, merge_manuscript, save_manuscript, save_manuscript_checked,
    save_recovery_log,
};
use commands::materials::{
    list_summary_materials, list_writing_cards, rebuild_summary_material,
    set_summary_material_lifecycle, set_writing_card_enabled, upsert_summary_material,
    upsert_writing_card,
};
use commands::planning::{
    create_plan_node, list_plan_nodes, move_plan_node, update_plan_node, update_plan_node_checked,
};
use commands::project::{close_project, create_project, current_project, open_project};
use commands::search::{rebuild_search_index, search_project};
use errors::ApiError;
use state::ProjectState;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the desktop application runtime.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or the application event loop fails.
pub fn run() {
    let settings_database = settings_database_path();
    let model_profiles = novel_infrastructure::ModelProfileStore::open(settings_database)
        .expect("application model settings database must initialize");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectState {
            manager: Mutex::new(novel_infrastructure::ProjectManager::new()),
            model_profiles: Mutex::new(model_profiles),
            gateway: novel_infrastructure::ModelGateway::default(),
            embedding_gateway: novel_infrastructure::EmbeddingGateway::default(),
            ai_cancellations: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut ticks = 0u32;
                loop {
                    if let Some(state) = handle.try_state::<ProjectState>()
                        && let Ok(mut manager) = state.manager.lock()
                    {
                        let _ = manager.run_next_job();
                        ticks = ticks.wrapping_add(1);
                        if ticks.is_multiple_of(120) {
                            let _ = manager.compact_recovery_logs(20);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            feature_catalog,
            health_query,
            list_entities,
            upsert_entity,
            list_entity_revisions,
            set_entity_archived,
            create_project,
            open_project,
            close_project,
            current_project,
            list_plan_nodes,
            create_plan_node,
            update_plan_node,
            update_plan_node_checked,
            move_plan_node,
            current_manuscript,
            list_manuscript_revisions,
            list_recovery_logs,
            list_all_recovery_logs,
            clear_recovery_logs,
            save_manuscript,
            save_manuscript_checked,
            merge_manuscript,
            save_recovery_log,
            list_model_profiles,
            upsert_model_profile,
            save_model_secret,
            delete_model_secret,
            test_model_profile,
            list_ai_proposals,
            decide_ai_proposal,
            generate_ai_proposal,
            cancel_ai_task,
            assemble_context_with_project_knowledge,
            list_summary_materials,
            upsert_summary_material,
            list_writing_cards,
            upsert_writing_card,
            set_writing_card_enabled,
            set_summary_material_lifecycle,
            rebuild_summary_material,
            rebuild_search_index,
            search_project,
            list_jobs,
            enqueue_job,
            cancel_job,
            retry_job,
            claim_next_job,
            run_next_job,
            health_scan,
            startup_recovery_report,
            create_diagnostic_package,
            create_evidence_anchor,
            create_relation,
            update_relation,
            create_event,
            update_event,
            create_belief,
            update_belief,
            create_foreshadowing,
            update_foreshadowing,
            list_evidence_anchors,
            list_current_facts,
            list_relations,
            list_events,
            list_beliefs,
            list_foreshadowings,
            create_knowledge_candidate,
            list_knowledge_candidates,
            review_knowledge_candidate,
            detect_candidate_conflicts,
            finalize_knowledge_candidates,
            rebuild_world_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn settings_database_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map_or_else(std::env::temp_dir, PathBuf::from)
        .join("AINovelTools")
        .join("settings.sqlite")
}

#[cfg(test)]
mod tests {
    #[test]
    fn bootstrap_reports_all_linked_layers() {
        let status = super::bootstrap_status();
        assert_eq!(status.layers, ["domain", "application", "infrastructure"]);
    }
}
