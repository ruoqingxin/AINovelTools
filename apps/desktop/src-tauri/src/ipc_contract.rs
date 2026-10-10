//! Build-time IPC contracts. This module never runs in the normal desktop app.
#![allow(
    dead_code,
    non_camel_case_types,
    unused_imports,
    clippy::wildcard_imports
)]

use crate::commands::ai::*;
use crate::commands::discussion::*;
use crate::errors::ApiError;
use crate::state::*;

type SchemaProperties = serde_json::Map<String, serde_json::Value>;

struct CollectedSchema {
    requests: SchemaProperties,
    responses: SchemaProperties,
    errors: SchemaProperties,
    events: SchemaProperties,
}

include!(concat!(env!("OUT_DIR"), "/ipc_schema.rs"));

fn root(
    title: &str,
    properties: SchemaProperties,
    definitions: &SchemaProperties,
) -> serde_json::Value {
    serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": title,
        "type": "object",
        "required": properties.keys().collect::<Vec<_>>(),
        "properties": properties,
        "additionalProperties": false,
        "definitions": definitions,
    })
}

/// Exports both Serde directions for every registered command and emitted event.
#[must_use]
pub fn schema() -> serde_json::Value {
    let mut input = schemars::generate::SchemaSettings::draft07()
        .for_deserialize()
        .into_generator();
    let mut output = schemars::generate::SchemaSettings::draft07()
        .for_serialize()
        .into_generator();
    let CollectedSchema {
        requests,
        responses,
        errors,
        events,
    } = collect(&mut input, &mut output);
    serde_json::json!({
        "requests": root("IpcRequests", requests, input.definitions()),
        "responses": root("IpcResponses", responses, output.definitions()),
        "errors": root("IpcErrors", errors, output.definitions()),
        "events": root("IpcEvents", events, output.definitions()),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    fn definition<'a>(schema: &'a Value, direction: &str, name: &str) -> &'a Value {
        &schema[direction]["definitions"][name]
    }

    fn required(schema: &Value, field: &str) -> bool {
        schema["required"]
            .as_array()
            .is_some_and(|fields| fields.contains(&json!(field)))
    }

    #[test]
    fn every_registered_command_has_both_directions_and_an_error_contract() {
        let schema = super::schema();
        let keys = |direction: &str| {
            schema[direction]["properties"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(keys("requests"), keys("responses"));
        assert_eq!(keys("requests"), keys("errors"));
        assert_eq!(keys("requests").len(), 139);
        assert_eq!(
            keys("events"),
            ["ai-task-attempt", "ai-task-chunk", "ai-task-started"]
        );
    }

    #[test]
    fn extraction_scope_and_cas_are_mandatory_in_generated_requests() {
        let schema = super::schema();
        let target = definition(&schema, "requests", "ExtractionItemTarget");
        for field in [
            "id",
            "projectId",
            "chapterId",
            "expectedStatus",
            "expectedVersion",
        ] {
            assert!(required(target, field), "{field} must be required");
        }
        for command in [
            "adopt_extraction_item",
            "update_extraction_item",
            "decide_extraction_item",
        ] {
            let arguments = definition(&schema, "requests", &format!("Args_{command}"));
            assert!(required(arguments, "target"));
        }
        let batch = definition(&schema, "requests", "PlanBatchInput");
        for field in [
            "expectedProjectId",
            "parentId",
            "expectedParentRevision",
            "expectedSourceVersion",
            "source",
            "candidates",
        ] {
            assert!(required(batch, field), "{field} must be required");
        }
        assert!(required(
            definition(&schema, "requests", "PlanBatchCandidate"),
            "title"
        ));
    }

    #[test]
    fn serde_defaults_and_options_are_optional_only_on_the_input_side() {
        let schema = super::schema();
        let input = definition(&schema, "requests", "AiBudgetSettings");
        let output = definition(&schema, "responses", "AiBudgetSettings");
        for field in ["currency", "dailyLimitMicros", "projectLimitMicros"] {
            assert!(!required(input, field));
            assert!(required(output, field));
        }
        let request = definition(&schema, "requests", "ModelProfileInput");
        assert!(!required(request, "id"));
        assert!(required(request, "name"));
        assert!(required(request, "modelId"));
        let profile = definition(&schema, "responses", "ModelProfile");
        assert!(required(profile, "secretRef"));
        assert!(required(profile, "hasSecret"));
        assert!(request["properties"].get("secretRef").is_none());
    }

    #[test]
    fn planning_flatten_matches_the_actual_versioned_serialization() {
        let schema = super::schema();
        let output = definition(&schema, "responses", "VersionedPlanningSection");
        let section = novel_infrastructure::VersionedPlanningSection {
            version: 7,
            section: novel_infrastructure::PlanningSection {
                id: "plan".into(),
                content: String::new(),
                pending_content: String::new(),
                story_state: novel_infrastructure::PlanningStoryState::Unset,
                rationale: String::new(),
                consequence: String::new(),
                references: vec![],
                updated_at: String::new(),
            },
        };
        let serialized = serde_json::to_value(section).unwrap();
        let actual = serialized.as_object().unwrap().keys().collect::<Vec<_>>();
        let generated = output["properties"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>();
        assert_eq!(actual, generated);
        assert!(required(output, "version"));
        assert!(output["properties"].get("section").is_none());
        assert!(required(
            definition(&schema, "requests", "Args_save_planning_section_checked"),
            "expectedVersion"
        ));
    }

    #[test]
    fn serialized_option_fields_are_required_nullable_and_json_stays_unvalidated() {
        let schema = super::schema();
        let conflict = definition(&schema, "responses", "MergeConflict");
        for field in ["base", "current", "draft"] {
            assert!(required(conflict, field));
            assert!(
                conflict["properties"][field]["type"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("null"))
            );
        }
        let item = definition(&schema, "responses", "ChapterExtractionItem");
        assert_eq!(item["properties"]["payload"], json!(true));
        assert!(required(item, "version"));
        let revision = definition(&schema, "responses", "ManuscriptRevision");
        for field in ["documentSchemaVersion", "baseRevisionId", "createdAt"] {
            assert!(required(revision, field));
        }
    }

    #[test]
    fn enum_spellings_and_string_fields_follow_rust_not_ui_assumptions() {
        let schema = super::schema();
        let status = definition(&schema, "responses", "ExtractionItemStatus");
        assert_eq!(
            status["enum"],
            json!(["PENDING_REVIEW", "ACCEPTED", "DEFERRED", "REJECTED"])
        );
        let health = definition(&schema, "responses", "DatabaseHealthResponse");
        assert_eq!(health["properties"]["status"]["type"], "string");
        assert!(health["properties"]["status"].get("enum").is_none());
        let bootstrap = definition(&schema, "responses", "BootstrapStatus");
        assert_eq!(bootstrap["properties"]["layers"]["minItems"], 3);
        assert_eq!(bootstrap["properties"]["layers"]["maxItems"], 3);
    }

    #[test]
    fn custom_preference_schema_covers_legacy_inputs_and_normalized_outputs() {
        let schema = super::schema();
        let input = definition(&schema, "requests", "AiTaskPreference");
        let variants = input["anyOf"].as_array().unwrap();
        assert_eq!(variants.len(), 3);
        assert_eq!(variants[0]["type"], "string");
        assert_eq!(variants[2]["type"], "null");
        let output = definition(&schema, "responses", "AiTaskPreference");
        for value in [
            json!(null),
            json!("00000000-0000-0000-0000-000000000001"),
            json!({}),
        ] {
            let preference: novel_infrastructure::AiTaskPreference =
                serde_json::from_value(value).unwrap();
            let serialized = serde_json::to_value(preference).unwrap();
            assert_eq!(
                serialized.as_object().unwrap().keys().collect::<Vec<_>>(),
                output["properties"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>(),
            );
            for field in [
                "profileId",
                "fallbackProfileId",
                "temperature",
                "maxOutputTokens",
                "prompt",
            ] {
                assert!(required(output, field));
            }
        }
    }

    #[test]
    fn event_none_is_serialized_as_null_instead_of_an_omitted_field() {
        let schema = super::schema();
        let event = super::AiTaskAttempt {
            task_id: uuid::Uuid::nil(),
            attempt: 1,
            profile_name: "model".into(),
            fallback_reason: None,
        };
        let serialized = serde_json::to_value(event).unwrap();
        assert_eq!(serialized["fallbackReason"], Value::Null);
        assert!(
            serialized
                .as_object()
                .unwrap()
                .contains_key("fallbackReason")
        );
        assert!(required(
            definition(&schema, "events", "AiTaskAttempt"),
            "fallbackReason"
        ));
    }

    #[test]
    fn string_command_errors_are_not_misrepresented_as_api_errors() {
        let schema = super::schema();
        assert_eq!(
            schema["errors"]["properties"]["health_query"]["type"],
            "string"
        );
        assert_eq!(
            schema["errors"]["properties"]["current_project"]["type"],
            "string"
        );
        assert_eq!(
            schema["errors"]["properties"]["close_project"]["type"],
            "null"
        );
        assert_eq!(
            schema["errors"]["properties"]["adopt_plan_batch"]["$ref"],
            "#/definitions/ApiError"
        );
    }
}
