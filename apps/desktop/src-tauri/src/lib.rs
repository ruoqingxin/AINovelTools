#![allow(clippy::needless_pass_by_value)]

use std::collections::HashMap;
use std::sync::Mutex;

mod commands;
mod errors;
mod state;

use commands::ai::{
    cancel_ai_task, decide_ai_proposal, delete_model_secret, generate_ai_proposal,
    list_ai_proposals, list_model_profiles, save_model_secret, test_model_profile,
    upsert_model_profile,
};
use commands::core::{bootstrap_status, feature_catalog, health_query};
use commands::entities::{
    list_entities, list_entity_revisions, set_entity_archived, upsert_entity,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectState {
            manager: Mutex::new(novel_infrastructure::ProjectManager::new()),
            gateway: novel_infrastructure::ModelGateway::default(),
            embedding_gateway: novel_infrastructure::EmbeddingGateway::default(),
            ai_cancellations: Mutex::new(HashMap::new()),
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
            list_summary_materials,
            upsert_summary_material,
            list_writing_cards,
            upsert_writing_card,
            set_writing_card_enabled,
            set_summary_material_lifecycle,
            rebuild_summary_material,
            rebuild_search_index,
            search_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn bootstrap_reports_all_linked_layers() {
        let status = super::bootstrap_status();
        assert_eq!(status.layers, ["domain", "application", "infrastructure"]);
    }
}
