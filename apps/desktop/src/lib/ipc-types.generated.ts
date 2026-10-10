// Generated from Rust/Serde. Run `pnpm generate:ipc`; do not edit.
export type InputExtractionItemStatus = "PENDING_REVIEW" | "ACCEPTED" | "DEFERRED" | "REJECTED";
export type InputPlanningStoryState = "UNSET" | "UNKNOWN" | "DEFERRED" | "AUTHOR_RESERVED" | "AI_SUGGESTED" | "CONFIRMED" | "LOCKED" | "RETIRED";
export type InputAiAction = "DRAFT" | "CONTINUE" | "REWRITE" | "POLISH" | "SUMMARIZE" | "CONSISTENCY_CHECK";
export type InputEntityType = "CHARACTER" | "LOCATION" | "FACTION" | "ITEM" | "CONCEPT";
export type InputKnowledgeLifecycleStatus = "ACTIVE" | "NEEDS_REVIEW" | "ARCHIVED";
export type InputDiscussionCandidateKind = "NOTE" | "PLANNING" | "SETTING" | "FORESHADOWING";
export type InputDiscussionScopeKind = "PROJECT" | "VOLUME" | "CHAPTER" | "SCENE" | "SELECTION";
export type InputDiscussionTopicKind = "FREE" | "CHARACTER" | "ITEM" | "LOCATION" | "PLOT";
export type InputCandidateStatus = "PENDING" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "FINALIZED";
export type InputReviewDecision = "APPROVE" | "REJECT" | "NEEDS_REVIEW";
export type InputPlanNodeKind = "WORK_DESIGN" | "OUTLINE" | "VOLUME_MANAGER" | "VOLUME" | "CHAPTER" | "SCENE";
export type InputAiProposalStatus = "PENDING" | "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED";
export type InputDiscussionCandidateStatus = "PENDING" | "PROMOTED" | "DISMISSED";
export type InputJobType = "BACKUP" | "RESTORE_VERIFY" | "HEALTH_SCAN" | "REBUILD_SEARCH_INDEX" | "REFRESH_CHAPTER_SUMMARY" | "REFRESH_PROJECT_SETTING_SUMMARY" | "AI_PLANNING_GENERATE" | "AI_PLANNING_EXTRACT";
export type InputAiTaskKind = "discussion" | "discussionDesign" | "workDesign" | "outline" | "volumePlanning" | "chapterSplit" | "chapterPlan" | "consistencyReview" | "writing" | "knowledgeExtraction";
export type InputReviewPurpose = "ADMISSION" | "MANUSCRIPT";
export type InputAiProposalFeedbackRating = "HELPFUL" | "NOT_HELPFUL";
export type InputAiTaskPreference = string | InputAiTaskPreferenceDetails | null;
export type InputWritingReviewPolicy = "ADVISORY" | "BALANCED" | "REQUIRED";
export type InputModelCapability = "CHAT" | "EMBEDDING";
export type InputPrivacyLevel = "LOCAL_ONLY" | "ALLOW_CLOUD";
export type InputModelProvider = "SILICON_FLOW" | "DEEP_SEEK" | "OPEN_AI" | "OPEN_AI_COMPATIBLE";
export type InputSummaryKind = "CHAPTER" | "CHARACTER" | "SETTING";
export type InputSummaryPrecision = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export type ExtractionItemKind = "ENTITY" | "FACT" | "RELATION" | "EVENT" | "FORESHADOWING";
export type ExtractionItemStatus = "PENDING_REVIEW" | "ACCEPTED" | "DEFERRED" | "REJECTED";
export type PlanNodeKind = "WORK_DESIGN" | "OUTLINE" | "VOLUME_MANAGER" | "VOLUME" | "CHAPTER" | "SCENE";
export type PlanningStoryState = "UNSET" | "UNKNOWN" | "DEFERRED" | "AUTHOR_RESERVED" | "AI_SUGGESTED" | "CONFIRMED" | "LOCKED" | "RETIRED";
export type DiscussionMessageRole = "USER" | "ASSISTANT";
export type AiAction = "DRAFT" | "CONTINUE" | "REWRITE" | "POLISH" | "SUMMARIZE" | "CONSISTENCY_CHECK";
export type ContextAuthority = "PROJECT_SETTING" | "AUTHORITATIVE_FACT" | "TASK_MATERIAL" | "REFERENCE";
export type RetrievalMethod = "STRUCTURED" | "KEYWORD" | "SEMANTIC";
export type ContextSectionKind = "TASK_CONTRACT" | "USER_INSTRUCTION" | "PROJECT_SETTINGS" | "AUTHORITATIVE_FACTS" | "CHAPTER_PLAN" | "CURRENT_STATE" | "CURRENT_DRAFT" | "STYLE_RULES" | "REFERENCES";
export type AiTaskRole = "DRAFT_WRITER" | "SELECTION_REVISER" | "CHAPTER_SUMMARIZER" | "CONTINUITY_AUDITOR" | "REVIEW_CLAIM_EXTRACTOR" | "REVIEW_SEMANTIC_ADJUDICATOR" | "DISCUSSION_FACILITATOR" | "API_CONNECTION_TESTER";
export type JobType = "BACKUP" | "RESTORE_VERIFY" | "HEALTH_SCAN" | "REBUILD_SEARCH_INDEX" | "REFRESH_CHAPTER_SUMMARY" | "REFRESH_PROJECT_SETTING_SUMMARY" | "AI_PLANNING_GENERATE" | "AI_PLANNING_EXTRACT";
export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type KnowledgeLifecycleStatus = "ACTIVE" | "NEEDS_REVIEW" | "ARCHIVED";
export type DiscussionCandidateKind = "NOTE" | "PLANNING" | "SETTING" | "FORESHADOWING";
export type DiscussionCandidateStatus = "PENDING" | "PROMOTED" | "DISMISSED";
export type DiscussionScopeKind = "PROJECT" | "VOLUME" | "CHAPTER" | "SCENE" | "SELECTION";
export type CandidateStatus = "PENDING" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "FINALIZED";
export type ReviewDecision = "APPROVE" | "REJECT" | "NEEDS_REVIEW";
export type ReviewPurpose = "ADMISSION" | "MANUSCRIPT";
export type AiProposalStatus = "PENDING" | "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED";
export type ModelCapability = "CHAT" | "EMBEDDING";
export type PrivacyLevel = "LOCAL_ONLY" | "ALLOW_CLOUD";
export type ModelProvider = "SILICON_FLOW" | "DEEP_SEEK" | "OPEN_AI" | "OPEN_AI_COMPATIBLE";
export type KnowledgeConflictKind = "DUPLICATE_FACT" | "CONTRADICTORY_OBJECT";
export type ChapterExtractionProposalStatus = "PENDING_REVIEW" | "PARTIALLY_ACCEPTED" | "DEFERRED" | "ACCEPTED" | "REJECTED";
export type FeatureStatus = "IMPLEMENTED" | "PARTIAL" | "DECLARED" | "DISABLED";
export type ChangeSetStatus = "DRAFT" | "IN_REVIEW" | "BLOCKED" | "FINALIZED" | "REJECTED";
export type EntityType = "CHARACTER" | "LOCATION" | "FACTION" | "ITEM" | "CONCEPT";
export type EntityLifecycleStatus = "ACTIVE" | "ARCHIVED";
export type ReviewClaimType = "CHARACTER_STATUS" | "CHARACTER_LOCATION" | "ABILITY_OR_REALM" | "ITEM_POSSESSION" | "RELATION" | "KNOWLEDGE_BOUNDARY" | "REQUIRED_EVENT" | "FORBIDDEN_EVENT" | "ALLOWED_CHARACTER" | "TIME_WINDOW" | "STAGE_BOUNDARY" | "FORESHADOWING_WINDOW" | "PLAN_DEPENDENCY";
export type FindingSource = "RULE" | "LLM" | "MERGED";
export type ReviewStatus = "PASS" | "NOTICE" | "WARNING" | "BLOCK" | "UNKNOWN";
export type EvidenceAuthority = "LOCKED_RULE" | "CONFIRMED_FACT" | "CURRENT_STATE" | "CHAPTER_CONTRACT" | "APPROVED_EVENT" | "PLAN_REFERENCE" | "SUMMARY_REFERENCE" | "UNCONFIRMED";
export type ReviewEvidenceSource = "ENTITY" | "FACT" | "WORLD_STATE" | "RELATION" | "BELIEF" | "EVENT" | "FORESHADOWING" | "LOCKED_RULE" | "CHAPTER_CONTRACT";
export type ReviewStage = "CLAIM_EXTRACTION" | "DETERMINISTIC_RULES" | "SEMANTIC_REVIEW" | "MERGE";
export type DiscussionTopicKind = "FREE" | "CHARACTER" | "ITEM" | "LOCATION" | "PLOT";
export type SummaryKind = "CHAPTER" | "CHARACTER" | "SETTING";
export type SummaryPrecision = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export type WritingReviewPolicy = "ADVISORY" | "BALANCED" | "REQUIRED";
export type AiConsistencySeverity = "BLOCKER" | "MAJOR" | "MINOR" | "INFO";
export type AiConsistencyVerdict = "PASS" | "REVIEW" | "BLOCKED" | "NEEDS_INPUT" | "UNPARSED";
export type ConsistencyReviewFreshness = "MISSING" | "FRESH" | "STALE" | "UNVERIFIED";
export type AiProposalFeedbackRating = "HELPFUL" | "NOT_HELPFUL";
export type IpcContracts = {
    errors: IpcErrors;
    events: IpcEvents;
    requests: IpcRequests;
    responses: IpcResponses;
};
export type IpcErrors = {
    acknowledge_failed_jobs: ApiError;
    adopt_extraction_item: ApiError;
    adopt_plan_batch: ApiError;
    ask_project_discussion: ApiError;
    assemble_context_with_project_knowledge: ApiError;
    bootstrap_status: null;
    cancel_ai_task: ApiError;
    cancel_job: ApiError;
    claim_next_job: ApiError;
    clear_planning_embedding: ApiError;
    clear_recovery_logs: ApiError;
    close_project: null;
    commit_manuscript_draft: ApiError;
    confirm_discussion_design: ApiError;
    create_belief: ApiError;
    create_diagnostic_package: ApiError;
    create_discussion_candidate: ApiError;
    create_discussion_session: ApiError;
    create_event: ApiError;
    create_evidence_anchor: ApiError;
    create_foreshadowing: ApiError;
    create_knowledge_candidate: ApiError;
    create_plan_node: ApiError;
    create_project: ApiError;
    create_relation: ApiError;
    current_manuscript: ApiError;
    current_manuscript_draft: ApiError;
    current_project: string;
    decide_ai_proposal: ApiError;
    decide_extraction_item: ApiError;
    delete_model_secret: ApiError;
    detect_candidate_conflicts: ApiError;
    discard_manuscript_draft: ApiError;
    dismiss_discussion_candidate: ApiError;
    enqueue_chapter_summary_refresh: ApiError;
    enqueue_job: ApiError;
    enqueue_planning_ai_job: ApiError;
    enqueue_project_setting_summary_refresh: ApiError;
    extract_chapter_candidates: ApiError;
    extract_entities_from_text: ApiError;
    feature_catalog: null;
    finalize_knowledge_candidates: ApiError;
    generate_ai_proposal: ApiError;
    generate_planning_content: ApiError;
    generate_planning_embedding: ApiError;
    get_ai_budget_settings: ApiError;
    get_ai_quality_summary: ApiError;
    get_ai_run_request: ApiError;
    get_ai_task_preferences: ApiError;
    get_ai_usage_summary: ApiError;
    get_audit_flow_settings: ApiError;
    get_chapter_entity_references: ApiError;
    get_consistency_review_trace: ApiError;
    get_discussion_source: ApiError;
    get_discussion_workspace: ApiError;
    get_manuscript_source: ApiError;
    get_planning_ai_job_request: ApiError;
    get_project_ai_task_overrides: ApiError;
    get_summary_material: ApiError;
    get_writing_card: ApiError;
    get_writing_review_policy: ApiError;
    health_query: string;
    health_scan: ApiError;
    import_entities: ApiError;
    list_ai_proposals: ApiError;
    list_ai_runs: ApiError;
    list_all_recovery_logs: ApiError;
    list_author_settings: ApiError;
    list_beliefs: ApiError;
    list_chapter_extractions: ApiError;
    list_current_facts: ApiError;
    list_discussion_candidates: ApiError;
    list_discussion_design_proposals: ApiError;
    list_discussion_draft_revisions: ApiError;
    list_discussion_messages: ApiError;
    list_discussion_sessions: ApiError;
    list_entities: ApiError;
    list_entity_cards: ApiError;
    list_entity_chapters: ApiError;
    list_entity_revisions: ApiError;
    list_events: ApiError;
    list_evidence_anchors: ApiError;
    list_foreshadowings: ApiError;
    list_job_events: ApiError;
    list_jobs: ApiError;
    list_knowledge_candidates: ApiError;
    list_manuscript_revisions: ApiError;
    list_model_profiles: ApiError;
    list_plan_nodes: ApiError;
    list_planning_discussion_sources: ApiError;
    list_planning_embeddings: ApiError;
    list_planning_sections: ApiError;
    list_recent_projects: ApiError;
    list_recovery_logs: ApiError;
    list_relations: ApiError;
    list_summary_materials: ApiError;
    list_writing_cards: ApiError;
    merge_manuscript: ApiError;
    move_plan_node: ApiError;
    open_project: ApiError;
    promote_discussion_candidate: ApiError;
    promote_discussion_candidate_to_foreshadowing_review: ApiError;
    rate_ai_proposal: ApiError;
    rebuild_search_index: ApiError;
    rebuild_summary_material: ApiError;
    rebuild_world_state: ApiError;
    remove_project_ai_task_override: ApiError;
    retry_job: ApiError;
    review_knowledge_candidate: ApiError;
    run_next_job: ApiError;
    save_ai_budget_settings: ApiError;
    save_ai_task_preferences: ApiError;
    save_audit_flow_settings: ApiError;
    save_chapter_entity_references: ApiError;
    save_discussion_workspace: ApiError;
    save_manuscript_draft: ApiError;
    save_model_secret: ApiError;
    save_planning_section_checked: ApiError;
    save_project_ai_task_override: ApiError;
    save_project_ai_task_overrides: ApiError;
    save_recovery_log: ApiError;
    save_writing_review_policy: ApiError;
    search_project: ApiError;
    set_entity_archived: ApiError;
    set_summary_material_lifecycle: ApiError;
    set_writing_card_enabled: ApiError;
    startup_recovery_report: ApiError;
    summarize_discussion_design: ApiError;
    test_model_profile: ApiError;
    update_belief: ApiError;
    update_event: ApiError;
    update_extraction_item: ApiError;
    update_foreshadowing: ApiError;
    update_plan_node_checked: ApiError;
    update_relation: ApiError;
    upsert_entity: ApiError;
    upsert_model_profile: ApiError;
    upsert_summary_material: ApiError;
    upsert_writing_card: ApiError;
};
export type ApiError = {
    code: string;
    message: string;
};
export type IpcEvents = {
    "ai-task-attempt": AiTaskAttempt;
    "ai-task-chunk": AiStreamChunk;
    "ai-task-started": AiTaskStarted;
};
export type AiTaskAttempt = {
    attempt: number;
    fallbackReason: string | null;
    profileName: string;
    taskId: string;
};
export type AiStreamChunk = {
    chunk: string;
    taskId: string;
};
export type AiTaskStarted = {
    taskId: string;
};
export type IpcRequests = {
    acknowledge_failed_jobs: InputArgsAcknowledgeFailedJobs;
    adopt_extraction_item: InputArgsAdoptExtractionItem;
    adopt_plan_batch: InputArgsAdoptPlanBatch;
    ask_project_discussion: InputArgsAskProjectDiscussion;
    assemble_context_with_project_knowledge: InputArgsAssembleContextWithProjectKnowledge;
    bootstrap_status: InputArgsBootstrapStatus;
    cancel_ai_task: InputArgsCancelAiTask;
    cancel_job: InputArgsCancelJob;
    claim_next_job: InputArgsClaimNextJob;
    clear_planning_embedding: InputArgsClearPlanningEmbedding;
    clear_recovery_logs: InputArgsClearRecoveryLogs;
    close_project: InputArgsCloseProject;
    commit_manuscript_draft: InputArgsCommitManuscriptDraft;
    confirm_discussion_design: InputArgsConfirmDiscussionDesign;
    create_belief: InputArgsCreateBelief;
    create_diagnostic_package: InputArgsCreateDiagnosticPackage;
    create_discussion_candidate: InputArgsCreateDiscussionCandidate;
    create_discussion_session: InputArgsCreateDiscussionSession;
    create_event: InputArgsCreateEvent;
    create_evidence_anchor: InputArgsCreateEvidenceAnchor;
    create_foreshadowing: InputArgsCreateForeshadowing;
    create_knowledge_candidate: InputArgsCreateKnowledgeCandidate;
    create_plan_node: InputArgsCreatePlanNode;
    create_project: InputArgsCreateProject;
    create_relation: InputArgsCreateRelation;
    current_manuscript: InputArgsCurrentManuscript;
    current_manuscript_draft: InputArgsCurrentManuscriptDraft;
    current_project: InputArgsCurrentProject;
    decide_ai_proposal: InputArgsDecideAiProposal;
    decide_extraction_item: InputArgsDecideExtractionItem;
    delete_model_secret: InputArgsDeleteModelSecret;
    detect_candidate_conflicts: InputArgsDetectCandidateConflicts;
    discard_manuscript_draft: InputArgsDiscardManuscriptDraft;
    dismiss_discussion_candidate: InputArgsDismissDiscussionCandidate;
    enqueue_chapter_summary_refresh: InputArgsEnqueueChapterSummaryRefresh;
    enqueue_job: InputArgsEnqueueJob;
    enqueue_planning_ai_job: InputArgsEnqueuePlanningAiJob;
    enqueue_project_setting_summary_refresh: InputArgsEnqueueProjectSettingSummaryRefresh;
    extract_chapter_candidates: InputArgsExtractChapterCandidates;
    extract_entities_from_text: InputArgsExtractEntitiesFromText;
    feature_catalog: InputArgsFeatureCatalog;
    finalize_knowledge_candidates: InputArgsFinalizeKnowledgeCandidates;
    generate_ai_proposal: InputArgsGenerateAiProposal;
    generate_planning_content: InputArgsGeneratePlanningContent;
    generate_planning_embedding: InputArgsGeneratePlanningEmbedding;
    get_ai_budget_settings: InputArgsGetAiBudgetSettings;
    get_ai_quality_summary: InputArgsGetAiQualitySummary;
    get_ai_run_request: InputArgsGetAiRunRequest;
    get_ai_task_preferences: InputArgsGetAiTaskPreferences;
    get_ai_usage_summary: InputArgsGetAiUsageSummary;
    get_audit_flow_settings: InputArgsGetAuditFlowSettings;
    get_chapter_entity_references: InputArgsGetChapterEntityReferences;
    get_consistency_review_trace: InputArgsGetConsistencyReviewTrace;
    get_discussion_source: InputArgsGetDiscussionSource;
    get_discussion_workspace: InputArgsGetDiscussionWorkspace;
    get_manuscript_source: InputArgsGetManuscriptSource;
    get_planning_ai_job_request: InputArgsGetPlanningAiJobRequest;
    get_project_ai_task_overrides: InputArgsGetProjectAiTaskOverrides;
    get_summary_material: InputArgsGetSummaryMaterial;
    get_writing_card: InputArgsGetWritingCard;
    get_writing_review_policy: InputArgsGetWritingReviewPolicy;
    health_query: InputArgsHealthQuery;
    health_scan: InputArgsHealthScan;
    import_entities: InputArgsImportEntities;
    list_ai_proposals: InputArgsListAiProposals;
    list_ai_runs: InputArgsListAiRuns;
    list_all_recovery_logs: InputArgsListAllRecoveryLogs;
    list_author_settings: InputArgsListAuthorSettings;
    list_beliefs: InputArgsListBeliefs;
    list_chapter_extractions: InputArgsListChapterExtractions;
    list_current_facts: InputArgsListCurrentFacts;
    list_discussion_candidates: InputArgsListDiscussionCandidates;
    list_discussion_design_proposals: InputArgsListDiscussionDesignProposals;
    list_discussion_draft_revisions: InputArgsListDiscussionDraftRevisions;
    list_discussion_messages: InputArgsListDiscussionMessages;
    list_discussion_sessions: InputArgsListDiscussionSessions;
    list_entities: InputArgsListEntities;
    list_entity_cards: InputArgsListEntityCards;
    list_entity_chapters: InputArgsListEntityChapters;
    list_entity_revisions: InputArgsListEntityRevisions;
    list_events: InputArgsListEvents;
    list_evidence_anchors: InputArgsListEvidenceAnchors;
    list_foreshadowings: InputArgsListForeshadowings;
    list_job_events: InputArgsListJobEvents;
    list_jobs: InputArgsListJobs;
    list_knowledge_candidates: InputArgsListKnowledgeCandidates;
    list_manuscript_revisions: InputArgsListManuscriptRevisions;
    list_model_profiles: InputArgsListModelProfiles;
    list_plan_nodes: InputArgsListPlanNodes;
    list_planning_discussion_sources: InputArgsListPlanningDiscussionSources;
    list_planning_embeddings: InputArgsListPlanningEmbeddings;
    list_planning_sections: InputArgsListPlanningSections;
    list_recent_projects: InputArgsListRecentProjects;
    list_recovery_logs: InputArgsListRecoveryLogs;
    list_relations: InputArgsListRelations;
    list_summary_materials: InputArgsListSummaryMaterials;
    list_writing_cards: InputArgsListWritingCards;
    merge_manuscript: InputArgsMergeManuscript;
    move_plan_node: InputArgsMovePlanNode;
    open_project: InputArgsOpenProject;
    promote_discussion_candidate: InputArgsPromoteDiscussionCandidate;
    promote_discussion_candidate_to_foreshadowing_review: InputArgsPromoteDiscussionCandidateToForeshadowingReview;
    rate_ai_proposal: InputArgsRateAiProposal;
    rebuild_search_index: InputArgsRebuildSearchIndex;
    rebuild_summary_material: InputArgsRebuildSummaryMaterial;
    rebuild_world_state: InputArgsRebuildWorldState;
    remove_project_ai_task_override: InputArgsRemoveProjectAiTaskOverride;
    retry_job: InputArgsRetryJob;
    review_knowledge_candidate: InputArgsReviewKnowledgeCandidate;
    run_next_job: InputArgsRunNextJob;
    save_ai_budget_settings: InputArgsSaveAiBudgetSettings;
    save_ai_task_preferences: InputArgsSaveAiTaskPreferences;
    save_audit_flow_settings: InputArgsSaveAuditFlowSettings;
    save_chapter_entity_references: InputArgsSaveChapterEntityReferences;
    save_discussion_workspace: InputArgsSaveDiscussionWorkspace;
    save_manuscript_draft: InputArgsSaveManuscriptDraft;
    save_model_secret: InputArgsSaveModelSecret;
    save_planning_section_checked: InputArgsSavePlanningSectionChecked;
    save_project_ai_task_override: InputArgsSaveProjectAiTaskOverride;
    save_project_ai_task_overrides: InputArgsSaveProjectAiTaskOverrides;
    save_recovery_log: InputArgsSaveRecoveryLog;
    save_writing_review_policy: InputArgsSaveWritingReviewPolicy;
    search_project: InputArgsSearchProject;
    set_entity_archived: InputArgsSetEntityArchived;
    set_summary_material_lifecycle: InputArgsSetSummaryMaterialLifecycle;
    set_writing_card_enabled: InputArgsSetWritingCardEnabled;
    startup_recovery_report: InputArgsStartupRecoveryReport;
    summarize_discussion_design: InputArgsSummarizeDiscussionDesign;
    test_model_profile: InputArgsTestModelProfile;
    update_belief: InputArgsUpdateBelief;
    update_event: InputArgsUpdateEvent;
    update_extraction_item: InputArgsUpdateExtractionItem;
    update_foreshadowing: InputArgsUpdateForeshadowing;
    update_plan_node_checked: InputArgsUpdatePlanNodeChecked;
    update_relation: InputArgsUpdateRelation;
    upsert_entity: InputArgsUpsertEntity;
    upsert_model_profile: InputArgsUpsertModelProfile;
    upsert_summary_material: InputArgsUpsertSummaryMaterial;
    upsert_writing_card: InputArgsUpsertWritingCard;
};
export type InputArgsAcknowledgeFailedJobs = {};
export type InputArgsAdoptExtractionItem = {
    target: InputExtractionItemTarget;
};
export type InputExtractionItemTarget = {
    chapterId: string;
    expectedStatus: InputExtractionItemStatus;
    expectedVersion: number;
    id: string;
    projectId: string;
};
export type InputArgsAdoptPlanBatch = {
    input: InputPlanBatchInput;
};
export type InputPlanBatchInput = {
    candidates: InputPlanBatchCandidate[];
    expectedParentRevision: number;
    expectedProjectId: string;
    expectedSourceVersion: number;
    parentId: string;
    source: InputPlanningSection;
};
export type InputPlanBatchCandidate = {
    content: string;
    title: string;
};
export type InputPlanningSection = {
    consequence: string;
    content: string;
    id: string;
    pendingContent: string;
    rationale: string;
    references: string[];
    storyState: InputPlanningStoryState;
    updatedAt: string;
};
export type InputArgsAskProjectDiscussion = {
    input: InputAskProjectDiscussionInput;
};
export type InputAskProjectDiscussionInput = {
    maxOutputTokens?: number | null;
    message: string;
    profileId: string;
    sessionId: string;
    temperature?: number | null;
};
export type InputArgsAssembleContextWithProjectKnowledge = {
    input: InputAssembleContextInput;
    objectIds?: string[] | null;
};
export type InputAssembleContextInput = {
    action: InputAiAction;
    chapterId: string;
    chapterPlan: string;
    chapterTitle: string;
    documentJson: string;
    inputTokenBudget: number;
    instruction?: string | null;
    selection?: string | null;
    targetRevisionId?: string | null;
    volumePlan: string;
};
export type InputArgsBootstrapStatus = {};
export type InputArgsCancelAiTask = {
    taskId: string;
};
export type InputArgsCancelJob = {
    id: string;
};
export type InputArgsClaimNextJob = {};
export type InputArgsClearPlanningEmbedding = {
    sectionId: string;
};
export type InputArgsClearRecoveryLogs = {
    chapterId: string;
};
export type InputArgsCloseProject = {};
export type InputArgsCommitManuscriptDraft = {
    baseRevisionId?: string | null;
    chapterId: string;
    documentJson: string;
    expectedVersion: number;
};
export type InputArgsConfirmDiscussionDesign = {
    entities: InputDiscussionDesignEntity[];
    id: string;
};
export type InputDiscussionDesignEntity = {
    aliases?: string[];
    attributes?: unknown;
    description: string;
    entityType: InputEntityType;
    expectedEntityVersion?: number | null;
    name: string;
    settings?: string[];
    tags?: string[];
    targetEntityId?: string | null;
    visibility?: string;
};
export type InputArgsCreateBelief = {
    belief: InputBelief;
};
export type InputBelief = {
    beliefVersion: number;
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    holderKnowledgeId: string;
    id: string;
    lifecycleStatus: InputKnowledgeLifecycleStatus;
    projectId: string;
    proposition: string;
    updatedAt: string;
};
export type InputArgsCreateDiagnosticPackage = {};
export type InputArgsCreateDiscussionCandidate = {
    content: string;
    kind: InputDiscussionCandidateKind;
    messageId: string;
    sessionId: string;
    targetSectionId?: string | null;
};
export type InputArgsCreateDiscussionSession = {
    linkedEntityId?: string | null;
    scopeId?: string | null;
    scopeKind: InputDiscussionScopeKind;
    scopeText?: string | null;
    title: string;
    topicKind?: InputDiscussionTopicKind | null;
};
export type InputArgsCreateEvent = {
    event: InputEvent;
};
export type InputEvent = {
    createdAt: string;
    createdBy: string;
    eventVersion: number;
    evidenceAnchorIds: string[];
    id: string;
    lifecycleStatus: InputKnowledgeLifecycleStatus;
    name: string;
    occurredAt: string;
    participantFactIds: string[];
    projectId: string;
    updatedAt: string;
};
export type InputArgsCreateEvidenceAnchor = {
    anchor: InputEvidenceAnchor;
};
export type InputEvidenceAnchor = {
    blockId: string;
    chapterId: string;
    createdAt: string;
    createdBy: string;
    endOffset: number;
    id: string;
    lifecycleStatus: InputKnowledgeLifecycleStatus;
    projectId: string;
    sourceHash: string;
    sourceRevisionId: string;
    sourceVersion: string;
    startOffset: number;
    updatedAt: string;
};
export type InputArgsCreateForeshadowing = {
    foreshadowing: InputForeshadowing;
};
export type InputForeshadowing = {
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    foreshadowingVersion: number;
    id: string;
    lifecycleStatus: InputKnowledgeLifecycleStatus;
    projectId: string;
    status: string;
    targetChapterId?: string | null;
    title: string;
    updatedAt: string;
};
export type InputArgsCreateKnowledgeCandidate = {
    candidate: InputKnowledgeCandidate;
};
export type InputKnowledgeCandidate = {
    candidateStatus: InputCandidateStatus;
    chapterId: string;
    createdAt: string;
    fact: InputFact;
    id: string;
    projectId: string;
    proposalId?: string | null;
    reviewDecision?: InputReviewDecision | null;
    reviewedAt?: string | null;
    reviewer?: string | null;
    updatedAt: string;
};
export type InputFact = {
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    knowledgeId: string;
    knowledgeVersion: number;
    lifecycleStatus: InputKnowledgeLifecycleStatus;
    object: string;
    predicate: string;
    projectId: string;
    sourceRevisionId: string;
    subject: string;
    updatedAt: string;
};
export type InputArgsCreatePlanNode = {
    kind: InputPlanNodeKind;
    parentId?: string | null;
    title: string;
};
export type InputArgsCreateProject = {
    name: string;
    root: string;
};
export type InputArgsCreateRelation = {
    relation: InputRelation;
};
export type InputRelation = {
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    fromKnowledgeId: string;
    id: string;
    lifecycleStatus: InputKnowledgeLifecycleStatus;
    projectId: string;
    relationType: string;
    relationVersion: number;
    toKnowledgeId: string;
    updatedAt: string;
};
export type InputArgsCurrentManuscript = {
    chapterId: string;
};
export type InputArgsCurrentManuscriptDraft = {
    chapterId: string;
};
export type InputArgsCurrentProject = {};
export type InputArgsDecideAiProposal = {
    acceptedText?: string | null;
    id: string;
    status: InputAiProposalStatus;
};
export type InputArgsDecideExtractionItem = {
    decision: InputExtractionItemStatus;
    target: InputExtractionItemTarget;
};
export type InputArgsDeleteModelSecret = {
    profileId: string;
};
export type InputArgsDetectCandidateConflicts = {
    chapterId: string;
};
export type InputArgsDiscardManuscriptDraft = {
    chapterId: string;
    expectedVersion: number;
};
export type InputArgsDismissDiscussionCandidate = {
    expectedStatus: InputDiscussionCandidateStatus;
    id: string;
};
export type InputArgsEnqueueChapterSummaryRefresh = {
    chapterId: string;
};
export type InputArgsEnqueueJob = {
    jobType: InputJobType;
    payload: string;
};
export type InputArgsEnqueuePlanningAiJob = {
    input: InputPlanningAiJobInput;
};
export type InputPlanningAiJobInput = {
    allowRewrite: boolean;
    existingContext: string;
    finalRequestBody?: string | null;
    finalRequestEndpoint?: string | null;
    finalRequestEstimatedInputTokens?: number | null;
    maxOutputTokens?: number | null;
    mode: string;
    profileId: string;
    referenceContent: string;
    sectionId: string;
    sectionPrompt: string;
    sectionTitle: string;
    sourceName?: string[] | null;
    systemPromptSnapshot?: string | null;
    taskKey?: InputAiTaskKind | null;
    temperature?: number | null;
    userGuidance: string;
    userPromptSnapshot?: string | null;
};
export type InputArgsEnqueueProjectSettingSummaryRefresh = {};
export type InputArgsExtractChapterCandidates = {
    input: InputExtractChapterCandidatesInput;
};
export type InputExtractChapterCandidatesInput = {
    chapterId: string;
    maxOutputTokens?: number | null;
    profileId: string;
    sourceRevisionId?: string | null;
    temperature?: number | null;
    userGuidance?: string | null;
};
export type InputArgsExtractEntitiesFromText = {
    input: InputExtractEntitiesInput;
};
export type InputExtractEntitiesInput = {
    applicabilityScope: string;
    briefSummary: string;
    entityName: string;
    entityType: InputEntityType;
    maxOutputTokens?: number | null;
    profileId: string;
    sourceText: string;
    temperature?: number | null;
    userGuidance?: string | null;
};
export type InputArgsFeatureCatalog = {};
export type InputArgsFinalizeKnowledgeCandidates = {
    actor: string;
    candidateIds: string[];
    chapterId: string;
};
export type InputArgsGenerateAiProposal = {
    action: InputAiAction;
    chapterId: string;
    chapterPlan: string;
    chapterTitle: string;
    documentJson: string;
    instruction?: string | null;
    maxOutputTokens?: number | null;
    profileId: string;
    reviewPurpose?: InputReviewPurpose | null;
    selection?: string | null;
    stream: boolean;
    temperature?: number | null;
    volumePlan: string;
};
export type InputArgsGeneratePlanningContent = {
    allowRewrite: boolean;
    existingContext: string;
    mode: string;
    profileId: string;
    referenceContent: string;
    sectionPrompt: string;
    sectionTitle: string;
    userGuidance: string;
};
export type InputArgsGeneratePlanningEmbedding = {
    profileId: string;
    sectionId: string;
};
export type InputArgsGetAiBudgetSettings = {};
export type InputArgsGetAiQualitySummary = {
    days?: number | null;
    limit?: number | null;
};
export type InputArgsGetAiRunRequest = {
    runId: string;
};
export type InputArgsGetAiTaskPreferences = {};
export type InputArgsGetAiUsageSummary = {
    days?: number | null;
};
export type InputArgsGetAuditFlowSettings = {};
export type InputArgsGetChapterEntityReferences = {
    chapterId: string;
    projectId: string;
};
export type InputArgsGetConsistencyReviewTrace = {
    proposalId: string;
};
export type InputArgsGetDiscussionSource = {
    request: InputDiscussionSourceRequest;
};
export type InputDiscussionSourceRequest = {
    candidateId: string;
    projectId?: string | null;
    sectionId?: string | null;
    sessionId?: string | null;
};
export type InputArgsGetDiscussionWorkspace = {
    sessionId: string;
};
export type InputArgsGetManuscriptSource = {
    request: InputManuscriptSourceRequest;
};
export type InputManuscriptSourceRequest = {
    blockId?: string | null;
    chapterId?: string | null;
    evidenceAnchorId?: string | null;
    projectId?: string | null;
    revisionId?: string | null;
};
export type InputArgsGetPlanningAiJobRequest = {
    jobId: string;
};
export type InputArgsGetProjectAiTaskOverrides = {};
export type InputArgsGetSummaryMaterial = {
    id: string;
    projectId: string;
};
export type InputArgsGetWritingCard = {
    id: string;
    projectId: string;
};
export type InputArgsGetWritingReviewPolicy = {};
export type InputArgsHealthQuery = {};
export type InputArgsHealthScan = {};
export type InputArgsImportEntities = {
    input: InputImportEntitiesInput;
};
export type InputImportEntitiesInput = {
    expectedProjectId: string;
    items: InputEntityInput[];
};
export type InputEntityInput = {
    aliases: string[];
    baseRevisionId?: string | null;
    description: string;
    entityType: InputEntityType;
    expectedVersion?: number | null;
    fixedAttributesJson: string;
    id?: string | null;
    name: string;
    sourceVersion?: string | null;
    tags: string[];
};
export type InputArgsListAiProposals = {
    chapterId: string;
    chapterPlan: string;
    chapterTitle: string;
    documentJson: string;
    instruction?: string | null;
    reviewPurpose?: InputReviewPurpose | null;
    volumePlan: string;
};
export type InputArgsListAiRuns = {
    limit?: number | null;
};
export type InputArgsListAllRecoveryLogs = {};
export type InputArgsListAuthorSettings = {};
export type InputArgsListBeliefs = {};
export type InputArgsListChapterExtractions = {
    chapterId: string;
};
export type InputArgsListCurrentFacts = {};
export type InputArgsListDiscussionCandidates = {
    sessionId: string;
};
export type InputArgsListDiscussionDesignProposals = {
    beforeId?: string | null;
    sessionId: string;
};
export type InputArgsListDiscussionDraftRevisions = {
    beforeVersion?: number | null;
    sessionId: string;
};
export type InputArgsListDiscussionMessages = {
    beforeMessageId?: string | null;
    limit?: number | null;
    sessionId: string;
};
export type InputArgsListDiscussionSessions = {};
export type InputArgsListEntities = {
    includeArchived: boolean;
};
export type InputArgsListEntityCards = {
    includeArchived: boolean;
};
export type InputArgsListEntityChapters = {
    entityId: string;
    projectId: string;
};
export type InputArgsListEntityRevisions = {
    entityId: string;
};
export type InputArgsListEvents = {};
export type InputArgsListEvidenceAnchors = {};
export type InputArgsListForeshadowings = {};
export type InputArgsListJobEvents = {
    jobId: string;
};
export type InputArgsListJobs = {};
export type InputArgsListKnowledgeCandidates = {
    chapterId: string;
};
export type InputArgsListManuscriptRevisions = {
    chapterId: string;
};
export type InputArgsListModelProfiles = {};
export type InputArgsListPlanNodes = {};
export type InputArgsListPlanningDiscussionSources = {
    limit?: number | null;
    offset?: number | null;
    projectId: string;
    sectionId: string;
};
export type InputArgsListPlanningEmbeddings = {};
export type InputArgsListPlanningSections = {};
export type InputArgsListRecentProjects = {};
export type InputArgsListRecoveryLogs = {
    chapterId: string;
};
export type InputArgsListRelations = {};
export type InputArgsListSummaryMaterials = {};
export type InputArgsListWritingCards = {
    cardType?: string | null;
};
export type InputArgsMergeManuscript = {
    base: string;
    current: string;
    draft: string;
};
export type InputArgsMovePlanNode = {
    expectedVersion: number;
    id: string;
    parentId?: string | null;
};
export type InputArgsOpenProject = {
    root: string;
};
export type InputArgsPromoteDiscussionCandidate = {
    expectedStatus: InputDiscussionCandidateStatus;
    id: string;
};
export type InputArgsPromoteDiscussionCandidateToForeshadowingReview = {
    evidenceAnchorId: string;
    expectedStatus: InputDiscussionCandidateStatus;
    id: string;
};
export type InputArgsRateAiProposal = {
    id: string;
    note?: string | null;
    rating: InputAiProposalFeedbackRating;
};
export type InputArgsRebuildSearchIndex = {};
export type InputArgsRebuildSummaryMaterial = {
    id: string;
};
export type InputArgsRebuildWorldState = {
    actor: string;
};
export type InputArgsRemoveProjectAiTaskOverride = {
    task: InputAiTaskKind;
};
export type InputArgsRetryJob = {
    id: string;
};
export type InputArgsReviewKnowledgeCandidate = {
    decision: InputReviewDecision;
    expectedStatus: InputCandidateStatus;
    id: string;
    reviewer: string;
};
export type InputArgsRunNextJob = {};
export type InputArgsSaveAiBudgetSettings = {
    settings: InputAiBudgetSettings;
};
export type InputAiBudgetSettings = {
    currency?: string;
    dailyLimitMicros?: number | null;
    projectLimitMicros?: number | null;
};
export type InputArgsSaveAiTaskPreferences = {
    preferences: InputAiTaskPreferences;
};
export type InputAiTaskPreferences = {
    chapterPlan?: InputAiTaskPreference;
    chapterSplit?: InputAiTaskPreference;
    consistencyReview?: InputAiTaskPreference;
    discussion?: InputAiTaskPreference;
    discussionDesign?: InputAiTaskPreference;
    knowledgeExtraction?: InputAiTaskPreference;
    outline?: InputAiTaskPreference;
    volumePlanning?: InputAiTaskPreference;
    workDesign?: InputAiTaskPreference;
    writing?: InputAiTaskPreference;
};
export type InputAiTaskPreferenceDetails = {
    fallbackProfileId?: string | null;
    maxOutputTokens?: number | null;
    profileId?: string | null;
    prompt?: InputAiTaskPromptPreference;
    temperature?: number | null;
};
export type InputAiTaskPromptPreference = {
    context?: InputAiTaskContextPreference;
    instructionTemplate?: string | null;
    systemPrompt?: string | null;
};
export type InputAiTaskContextPreference = {
    includeChapterPlan?: boolean | null;
    includeCurrentDraft?: boolean | null;
    includeProjectContext?: boolean | null;
    includeProjectKnowledge?: boolean | null;
    includeReferenceContent?: boolean | null;
    inputTokenBudget?: number | null;
};
export type InputArgsSaveAuditFlowSettings = {
    settings: InputAuditFlowSettings;
};
export type InputAuditFlowSettings = {
    admission: boolean;
    knowledge: boolean;
    manuscript: boolean;
};
export type InputArgsSaveChapterEntityReferences = {
    input: InputChapterEntitySave;
};
export type InputChapterEntitySave = {
    chapterId: string;
    entityIds: string[];
    expectedVersion: number;
    projectId: string;
};
export type InputArgsSaveDiscussionWorkspace = {
    workspace: InputDiscussionWorkspace;
};
export type InputDiscussionWorkspace = {
    draft: InputDiscussionDraft;
    linkedEntityId?: string | null;
    sessionId: string;
    topicKind: InputDiscussionTopicKind;
    version: number;
};
export type InputDiscussionDraft = {
    alternatives: string;
    chosen: string;
    questions: string;
};
export type InputArgsSaveManuscriptDraft = {
    baseRevisionId?: string | null;
    chapterId: string;
    documentJson: string;
    expectedVersion: number;
};
export type InputArgsSaveModelSecret = {
    profileId: string;
    secret: string;
};
export type InputArgsSavePlanningSectionChecked = {
    expectedVersion: number;
    section: InputPlanningSection;
};
export type InputArgsSaveProjectAiTaskOverride = {
    preference: InputAiTaskPreference;
    task: InputAiTaskKind;
};
export type InputArgsSaveProjectAiTaskOverrides = {
    preferences: InputAiTaskPreferences;
};
export type InputArgsSaveRecoveryLog = {
    chapterId: string;
    documentJson: string;
};
export type InputArgsSaveWritingReviewPolicy = {
    policy: InputWritingReviewPolicy;
};
export type InputArgsSearchProject = {
    limit: number;
    objectType?: string | null;
    offset: number;
    query: string;
};
export type InputArgsSetEntityArchived = {
    archived: boolean;
    expectedVersion: number;
    id: string;
};
export type InputArgsSetSummaryMaterialLifecycle = {
    id: string;
    lifecycleStatus: string;
};
export type InputArgsSetWritingCardEnabled = {
    enabled: boolean;
    id: string;
};
export type InputArgsStartupRecoveryReport = {};
export type InputArgsSummarizeDiscussionDesign = {
    input: InputSummarizeDiscussionDesignInput;
};
export type InputSummarizeDiscussionDesignInput = {
    expectedWorkspaceVersion: number;
    maxOutputTokens?: number | null;
    profileId: string;
    sessionId: string;
    temperature?: number | null;
};
export type InputArgsTestModelProfile = {
    profileId: string;
};
export type InputArgsUpdateBelief = {
    belief: InputBelief;
    expectedVersion: number;
};
export type InputArgsUpdateEvent = {
    event: InputEvent;
    expectedVersion: number;
};
export type InputArgsUpdateExtractionItem = {
    payload: unknown;
    target: InputExtractionItemTarget;
};
export type InputArgsUpdateForeshadowing = {
    expectedVersion: number;
    foreshadowing: InputForeshadowing;
};
export type InputArgsUpdatePlanNodeChecked = {
    archived: boolean;
    expectedVersion: number;
    id: string;
    title: string;
};
export type InputArgsUpdateRelation = {
    expectedVersion: number;
    relation: InputRelation;
};
export type InputArgsUpsertEntity = {
    input: InputEntityInput;
};
export type InputArgsUpsertModelProfile = {
    input: InputModelProfileInput;
};
export type InputModelProfileInput = {
    baseUrl: string;
    capability: InputModelCapability;
    contextWindow: number;
    id?: string | null;
    inputPriceMicrosPerMillion: number;
    maxOutputTokens: number;
    modelId: string;
    name: string;
    outputPriceMicrosPerMillion: number;
    priceCurrency: string;
    privacyLevel: InputPrivacyLevel;
    provider: InputModelProvider;
    retryLimit: number;
    timeoutSeconds: number;
};
export type InputArgsUpsertSummaryMaterial = {
    material: InputSummaryMaterial;
};
export type InputSummaryMaterial = {
    content: string;
    createdAt: string;
    generationMode: string;
    id: string;
    kind: InputSummaryKind;
    lifecycleStatus: string;
    precision: InputSummaryPrecision;
    projectId: string;
    sourceId?: string | null;
    sourceVersion?: string | null;
    updatedAt: string;
};
export type InputArgsUpsertWritingCard = {
    card: InputWritingCard;
};
export type InputWritingCard = {
    cardType: string;
    content: string;
    createdAt: string;
    enabled: boolean;
    id: string;
    projectId: string;
    scope: string;
    sortOrder: number;
    sourceVersion?: string | null;
    title: string;
    updatedAt: string;
};
export type IpcResponses = {
    acknowledge_failed_jobs: number;
    adopt_extraction_item: ChapterExtractionItem;
    adopt_plan_batch: PlanBatchReceipt;
    ask_project_discussion: DiscussionExchange;
    assemble_context_with_project_knowledge: ContextPackage;
    bootstrap_status: BootstrapStatus;
    cancel_ai_task: null;
    cancel_job: Job;
    claim_next_job: Job | null;
    clear_planning_embedding: null;
    clear_recovery_logs: null;
    close_project: ProjectManifest | null;
    commit_manuscript_draft: ManuscriptDraftCommit;
    confirm_discussion_design: string[];
    create_belief: Belief;
    create_diagnostic_package: string;
    create_discussion_candidate: DiscussionCandidate;
    create_discussion_session: DiscussionSession;
    create_event: Event;
    create_evidence_anchor: EvidenceAnchor;
    create_foreshadowing: Foreshadowing;
    create_knowledge_candidate: KnowledgeCandidate;
    create_plan_node: PlanNode;
    create_project: ProjectManifest;
    create_relation: Relation;
    current_manuscript: ManuscriptRevision | null;
    current_manuscript_draft: ManuscriptDraft;
    current_project: ProjectManifest | null;
    decide_ai_proposal: AiProposal;
    decide_extraction_item: ChapterExtractionItem;
    delete_model_secret: ModelProfile;
    detect_candidate_conflicts: KnowledgeConflict[];
    discard_manuscript_draft: ManuscriptDraft;
    dismiss_discussion_candidate: DiscussionCandidate;
    enqueue_chapter_summary_refresh: Job;
    enqueue_job: Job;
    enqueue_planning_ai_job: Job;
    enqueue_project_setting_summary_refresh: Job;
    extract_chapter_candidates: ChapterExtractionProposal;
    extract_entities_from_text: ExtractedEntity[];
    feature_catalog: FeatureDescriptor[];
    finalize_knowledge_candidates: ChangeSet;
    generate_ai_proposal: AiProposal;
    generate_planning_content: string;
    generate_planning_embedding: PlanningEmbedding;
    get_ai_budget_settings: AiBudgetSettings;
    get_ai_quality_summary: AiQualitySummary;
    get_ai_run_request: AiRunRequest;
    get_ai_task_preferences: AiTaskPreferences;
    get_ai_usage_summary: AiUsageSummary;
    get_audit_flow_settings: AuditFlowSettings;
    get_chapter_entity_references: ChapterEntityReferences;
    get_consistency_review_trace: ReviewTrace;
    get_discussion_source: DiscussionSource;
    get_discussion_workspace: DiscussionWorkspace;
    get_manuscript_source: ManuscriptSource;
    get_planning_ai_job_request: PlanningAiRequestPreview;
    get_project_ai_task_overrides: ProjectAiTaskOverrides;
    get_summary_material: SummaryMaterial;
    get_writing_card: WritingCard;
    get_writing_review_policy: WritingReviewPolicy;
    health_query: DatabaseHealthResponse;
    health_scan: HealthScanReport;
    import_entities: Entity[];
    list_ai_proposals: AiProposalReview[];
    list_ai_runs: AiRun[];
    list_all_recovery_logs: RecoveryLog[];
    list_author_settings: AuthorSetting[];
    list_beliefs: Belief[];
    list_chapter_extractions: ChapterExtractionProposal[];
    list_current_facts: Fact[];
    list_discussion_candidates: DiscussionCandidate[];
    list_discussion_design_proposals: DiscussionDesignProposal[];
    list_discussion_draft_revisions: DiscussionWorkspace[];
    list_discussion_messages: DiscussionMessage[];
    list_discussion_sessions: DiscussionSession[];
    list_entities: Entity[];
    list_entity_cards: EntityCard[];
    list_entity_chapters: EntityChapter[];
    list_entity_revisions: EntityRevision[];
    list_events: Event[];
    list_evidence_anchors: EvidenceAnchor[];
    list_foreshadowings: Foreshadowing[];
    list_job_events: JobEvent[];
    list_jobs: Job[];
    list_knowledge_candidates: KnowledgeCandidate[];
    list_manuscript_revisions: ManuscriptRevision[];
    list_model_profiles: ModelProfile[];
    list_plan_nodes: PlanNode[];
    list_planning_discussion_sources: PlanningDiscussionSource[];
    list_planning_embeddings: PlanningEmbedding[];
    list_planning_sections: VersionedPlanningSection[];
    list_recent_projects: RecentProject[];
    list_recovery_logs: RecoveryLog[];
    list_relations: Relation[];
    list_summary_materials: SummaryMaterial[];
    list_writing_cards: WritingCard[];
    merge_manuscript: MergeResult;
    move_plan_node: PlanNode;
    open_project: ProjectManifest;
    promote_discussion_candidate: DiscussionCandidate;
    promote_discussion_candidate_to_foreshadowing_review: DiscussionCandidate;
    rate_ai_proposal: AiProposalFeedback;
    rebuild_search_index: null;
    rebuild_summary_material: SummaryMaterial;
    rebuild_world_state: WorldState;
    remove_project_ai_task_override: ProjectAiTaskOverrides;
    retry_job: Job;
    review_knowledge_candidate: KnowledgeCandidate;
    run_next_job: Job | null;
    save_ai_budget_settings: AiBudgetSettings;
    save_ai_task_preferences: AiTaskPreferences;
    save_audit_flow_settings: AuditFlowSettings;
    save_chapter_entity_references: ChapterEntityReferences;
    save_discussion_workspace: DiscussionWorkspace;
    save_manuscript_draft: ManuscriptDraft;
    save_model_secret: ModelProfile;
    save_planning_section_checked: VersionedPlanningSection;
    save_project_ai_task_override: ProjectAiTaskOverrides;
    save_project_ai_task_overrides: ProjectAiTaskOverrides;
    save_recovery_log: null;
    save_writing_review_policy: WritingReviewPolicy;
    search_project: SearchResult[];
    set_entity_archived: Entity;
    set_summary_material_lifecycle: SummaryMaterial;
    set_writing_card_enabled: WritingCard;
    startup_recovery_report: StartupRecoveryReport;
    summarize_discussion_design: DiscussionDesignProposal;
    test_model_profile: ModelConnectionResponse;
    update_belief: Belief;
    update_event: Event;
    update_extraction_item: ChapterExtractionItem;
    update_foreshadowing: Foreshadowing;
    update_plan_node_checked: PlanNode;
    update_relation: Relation;
    upsert_entity: Entity;
    upsert_model_profile: ModelProfile;
    upsert_summary_material: SummaryMaterial;
    upsert_writing_card: WritingCard;
};
export type ChapterExtractionItem = {
    createdAt: string;
    evidenceAnchorId: string;
    finalObjectId: string | null;
    id: string;
    kind: ExtractionItemKind;
    payload: unknown;
    proposalId: string;
    status: ExtractionItemStatus;
    updatedAt: string;
    version: number;
};
export type PlanBatchReceipt = {
    nodes: PlanNode[];
    source: VersionedPlanningSection;
};
export type PlanNode = {
    archived: boolean;
    id: string;
    kind: PlanNodeKind;
    parentId: string | null;
    revision: number;
    sortOrder: number;
    title: string;
};
export type VersionedPlanningSection = {
    consequence: string;
    content: string;
    id: string;
    pendingContent: string;
    rationale: string;
    references: string[];
    storyState: PlanningStoryState;
    updatedAt: string;
    version: number;
};
export type DiscussionExchange = {
    assistantMessage: DiscussionMessage;
    userMessage: DiscussionMessage;
};
export type DiscussionMessage = {
    content: string;
    contextSummary: string | null;
    contextVersion: string | null;
    createdAt: string;
    id: string;
    profileId: string | null;
    role: DiscussionMessageRole;
    sessionId: string;
};
export type ContextPackage = {
    action: AiAction;
    chapterId: string;
    contextVersion: string;
    entitySourceStatus: string;
    estimatedInputTokens: number;
    promptVersion: string;
    retrievalEvidence: ContextEvidenceRef[];
    sectionAudit: ContextSectionAudit[];
    systemPrompt: string;
    targetRevisionId: string | null;
    taskContract: AiTaskContract;
    truncated: boolean;
    userPrompt: string;
};
export type ContextEvidenceRef = {
    authority: ContextAuthority;
    chunkId: string;
    method: RetrievalMethod;
    sourceHash: string;
    sourceId: string;
    sourceRevision: string;
};
export type ContextSectionAudit = {
    includedChars: number;
    kind: ContextSectionKind;
    priority: number;
    sourceCount: number;
    truncated: boolean;
};
export type AiTaskContract = {
    acceptanceCriteria: string[];
    forbiddenActions: string[];
    goal: string;
    outputContract: string;
    permissions: string[];
    role: AiTaskRole;
    targetId: string;
    targetRevisionId: string | null;
    targetType: string;
    uncertaintyPolicy: string;
};
export type BootstrapStatus = {
    appVersion: string;
    layers: [
        string,
        string,
        string
    ];
};
export type Job = {
    acknowledgedAt: string | null;
    attemptCount: number;
    cancelRequested: boolean;
    createdAt: string;
    errorSummary: string | null;
    id: string;
    jobType: JobType;
    payload: string;
    progress: number;
    status: JobStatus;
    updatedAt: string;
};
export type ProjectManifest = {
    createdAt: string;
    formatVersion: number;
    name: string;
    projectId: string;
};
export type ManuscriptDraftCommit = {
    draft: ManuscriptDraft;
    revision: ManuscriptRevision;
};
export type ManuscriptDraft = {
    baseDocumentJson: string;
    baseRevisionId: string | null;
    chapterId: string;
    documentJson: string | null;
    updatedAt: string;
    version: number;
};
export type ManuscriptRevision = {
    baseRevisionId: string | null;
    chapterId: string;
    contentHash: string;
    createdAt: string;
    creationReason: string;
    documentJson: string;
    documentSchemaVersion: number;
    id: string;
    parentRevisionId: string | null;
};
export type Belief = {
    beliefVersion: number;
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    holderKnowledgeId: string;
    id: string;
    lifecycleStatus: KnowledgeLifecycleStatus;
    projectId: string;
    proposition: string;
    updatedAt: string;
};
export type DiscussionCandidate = {
    content: string;
    createdAt: string;
    id: string;
    kind: DiscussionCandidateKind;
    messageId: string;
    promotedObjectId: string | null;
    sessionId: string;
    status: DiscussionCandidateStatus;
    targetSectionId: string | null;
    updatedAt: string;
};
export type DiscussionSession = {
    createdAt: string;
    id: string;
    projectId: string;
    scopeId: string | null;
    scopeKind: DiscussionScopeKind;
    scopeText: string | null;
    summary: string;
    title: string;
    updatedAt: string;
};
export type Event = {
    createdAt: string;
    createdBy: string;
    eventVersion: number;
    evidenceAnchorIds: string[];
    id: string;
    lifecycleStatus: KnowledgeLifecycleStatus;
    name: string;
    occurredAt: string;
    participantFactIds: string[];
    projectId: string;
    updatedAt: string;
};
export type EvidenceAnchor = {
    blockId: string;
    chapterId: string;
    createdAt: string;
    createdBy: string;
    endOffset: number;
    id: string;
    lifecycleStatus: KnowledgeLifecycleStatus;
    projectId: string;
    sourceHash: string;
    sourceRevisionId: string;
    sourceVersion: string;
    startOffset: number;
    updatedAt: string;
};
export type Foreshadowing = {
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    foreshadowingVersion: number;
    id: string;
    lifecycleStatus: KnowledgeLifecycleStatus;
    projectId: string;
    status: string;
    targetChapterId: string | null;
    title: string;
    updatedAt: string;
};
export type KnowledgeCandidate = {
    candidateStatus: CandidateStatus;
    chapterId: string;
    createdAt: string;
    fact: Fact;
    id: string;
    projectId: string;
    proposalId: string | null;
    reviewDecision: ReviewDecision | null;
    reviewedAt: string | null;
    reviewer: string | null;
    updatedAt: string;
};
export type Fact = {
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    knowledgeId: string;
    knowledgeVersion: number;
    lifecycleStatus: KnowledgeLifecycleStatus;
    object: string;
    predicate: string;
    projectId: string;
    sourceRevisionId: string;
    subject: string;
    updatedAt: string;
};
export type Relation = {
    createdAt: string;
    createdBy: string;
    evidenceAnchorIds: string[];
    fromKnowledgeId: string;
    id: string;
    lifecycleStatus: KnowledgeLifecycleStatus;
    projectId: string;
    relationType: string;
    relationVersion: number;
    toKnowledgeId: string;
    updatedAt: string;
};
export type AiProposal = {
    acceptedText: string | null;
    action: AiAction;
    chapterId: string;
    contextVersion: string;
    createdAt: string;
    decidedAt: string | null;
    id: string;
    outputText: string;
    promptVersion: string;
    reviewPurpose: ReviewPurpose;
    status: AiProposalStatus;
    targetRevisionId: string | null;
    taskId: string;
};
export type ModelProfile = {
    baseUrl: string;
    capability: ModelCapability;
    contextWindow: number;
    createdAt: string;
    hasSecret: boolean;
    id: string;
    inputPriceMicrosPerMillion: number;
    maxOutputTokens: number;
    modelId: string;
    name: string;
    outputPriceMicrosPerMillion: number;
    priceCurrency: string;
    privacyLevel: PrivacyLevel;
    provider: ModelProvider;
    retryLimit: number;
    secretRef: string | null;
    timeoutSeconds: number;
    updatedAt: string;
};
export type KnowledgeConflict = {
    candidateIds: string[];
    highRisk: boolean;
    kind: KnowledgeConflictKind;
    objects: string[];
    predicate: string;
    subject: string;
};
export type ChapterExtractionProposal = {
    aiRunId: string | null;
    chapterId: string;
    createdAt: string;
    id: string;
    items: ChapterExtractionItem[];
    projectId: string;
    sourceRevisionId: string;
    status: ChapterExtractionProposalStatus;
    updatedAt: string;
};
export type ExtractedEntity = {
    aliases: string[];
    description: string;
    name: string;
    tags: string[];
};
export type FeatureDescriptor = {
    displayName: string;
    id: string;
    stage: string;
    status: FeatureStatus;
    unavailableReason: string | null;
};
export type ChangeSet = {
    candidateIds: string[];
    chapterId: string;
    createdAt: string;
    createdBy: string;
    id: string;
    projectId: string;
    sourceRevisionId: string;
    status: ChangeSetStatus;
    updatedAt: string;
};
export type PlanningEmbedding = {
    contentHash: string;
    dimensions: number;
    modelId: string;
    profileId: string;
    sectionId: string;
    updatedAt: string;
    vector: number[];
};
export type AiBudgetSettings = {
    currency: string;
    dailyLimitMicros: number | null;
    projectLimitMicros: number | null;
};
export type AiQualitySummary = {
    groups: AiQualityGroup[];
    totalHelpful: number;
    totalProposals: number;
    totalRated: number;
    totalWithIssues: number;
};
export type AiQualityGroup = {
    acceptedCount: number;
    action: string;
    helpfulCount: number;
    invalidCount: number;
    needsInputCount: number;
    notHelpfulCount: number;
    profileName: string;
    promptVersion: string;
    proposalCount: number;
    ratedCount: number;
    taskKey: string;
    validCount: number;
    warningCount: number;
};
export type AiRunRequest = {
    endpoint: string | null;
    requestBody: string | null;
};
export type AiTaskPreferences = {
    chapterPlan: AiTaskPreference;
    chapterSplit: AiTaskPreference;
    consistencyReview: AiTaskPreference;
    discussion: AiTaskPreference;
    discussionDesign: AiTaskPreference;
    knowledgeExtraction: AiTaskPreference;
    outline: AiTaskPreference;
    volumePlanning: AiTaskPreference;
    workDesign: AiTaskPreference;
    writing: AiTaskPreference;
};
export type AiTaskPreference = {
    fallbackProfileId: string | null;
    maxOutputTokens: number | null;
    profileId: string | null;
    prompt: AiTaskPromptPreference;
    temperature: number | null;
};
export type AiTaskPromptPreference = {
    context: AiTaskContextPreference;
    instructionTemplate: string | null;
    systemPrompt: string | null;
};
export type AiTaskContextPreference = {
    includeChapterPlan: boolean | null;
    includeCurrentDraft: boolean | null;
    includeProjectContext: boolean | null;
    includeProjectKnowledge: boolean | null;
    includeReferenceContent: boolean | null;
    inputTokenBudget: number | null;
};
export type AiUsageSummary = {
    byTask: AiUsageTaskSummary[];
    daily: AiUsageDailySummary[];
    days: number;
    total: AiUsageCurrencySummary[];
};
export type AiUsageTaskSummary = {
    currency: string;
    estimatedCostMicros: number | null;
    inputTokens: number;
    outputTokens: number;
    runCount: number;
    taskKey: string;
};
export type AiUsageDailySummary = {
    currency: string;
    date: string;
    estimatedCostMicros: number | null;
    inputTokens: number;
    outputTokens: number;
    runCount: number;
};
export type AiUsageCurrencySummary = {
    currency: string;
    estimatedCostMicros: number | null;
    inputTokens: number;
    outputTokens: number;
    runCount: number;
};
export type AuditFlowSettings = {
    admission: boolean;
    knowledge: boolean;
    manuscript: boolean;
};
export type ChapterEntityReferences = {
    chapterId: string;
    entities: EntityCard[];
    projectId: string;
    version: number;
};
export type EntityCard = {
    entity: Entity;
    revision: EntityRevision;
};
export type Entity = {
    createdAt: string;
    currentRevisionId: string;
    entityType: EntityType;
    id: string;
    lifecycleStatus: EntityLifecycleStatus;
    projectId: string;
    updatedAt: string;
    version: number;
};
export type EntityRevision = {
    aliases: string[];
    baseRevisionId: string | null;
    createdAt: string;
    description: string;
    entityId: string;
    fixedAttributesJson: string;
    id: string;
    name: string;
    revision: number;
    sourceVersion: string | null;
    tags: string[];
};
export type ReviewTrace = {
    chapterId: string;
    claims: ReviewClaim[];
    contextVersion: string;
    deterministicFindings: ReviewFinding[];
    evidence: ReviewEvidence[];
    modelFindings: ReviewFinding[];
    omittedItems: ReviewOmittedItem[];
    reviewPurpose: ReviewPurpose;
    runId: string;
    stageRequests: ReviewStageRequest[];
    targetRevisionId: string | null;
};
export type ReviewClaim = {
    blockId: string;
    claimType: ReviewClaimType;
    confidence: number;
    endOffset: number;
    id: string;
    importance: number;
    object: string;
    predicate: string;
    quote: string;
    startOffset: number;
    subject: string;
};
export type ReviewFinding = {
    claimId: string;
    confidence: number;
    evidenceIds: string[];
    id: string;
    priority: number;
    problem: string;
    ruleEffectiveAt: string | null;
    ruleId: string | null;
    ruleScope: string | null;
    ruleVersion: string | null;
    severity: string;
    sourceKind: FindingSource;
    status: ReviewStatus;
    suggestion: string;
};
export type ReviewEvidence = {
    authority: EvidenceAuthority;
    claimId: string;
    excerpt: string;
    id: string;
    relevance: number;
    sourceKind: ReviewEvidenceSource;
    sourceRecordId: string;
    sourceRevision: string;
};
export type ReviewOmittedItem = {
    claimId: string | null;
    itemType: string;
    label: string;
    reason: string;
};
export type ReviewStageRequest = {
    fallbackReason: string | null;
    modelId: string | null;
    parseResult: string;
    profileId: string | null;
    requestContextVersion: string;
    requestSnapshot: string | null;
    responsePreview: string | null;
    stage: ReviewStage;
};
export type DiscussionSource = {
    candidate: DiscussionCandidate;
    message: DiscussionMessage;
    planningTargetAvailable: boolean;
    planningTargetKind: string | null;
    session: DiscussionSession;
};
export type DiscussionWorkspace = {
    draft: DiscussionDraft;
    linkedEntityId: string | null;
    sessionId: string;
    topicKind: DiscussionTopicKind;
    version: number;
};
export type DiscussionDraft = {
    alternatives: string;
    chosen: string;
    questions: string;
};
export type ManuscriptSource = {
    blockId: string | null;
    blockText: string | null;
    chapterArchived: boolean;
    chapterTitle: string;
    evidenceAnchorId: string | null;
    isCurrentRevision: boolean;
    quote: string | null;
    revision: ManuscriptRevision;
};
export type PlanningAiRequestPreview = {
    endpoint: string | null;
    estimatedInputTokens: number | null;
    requestBody: string | null;
};
export type ProjectAiTaskOverrides = {
    available: boolean;
    chapterPlan: AiTaskPreference | null;
    chapterSplit: AiTaskPreference | null;
    consistencyReview: AiTaskPreference | null;
    discussion: AiTaskPreference | null;
    discussionDesign: AiTaskPreference | null;
    knowledgeExtraction: AiTaskPreference | null;
    outline: AiTaskPreference | null;
    volumePlanning: AiTaskPreference | null;
    workDesign: AiTaskPreference | null;
    writing: AiTaskPreference | null;
};
export type SummaryMaterial = {
    content: string;
    createdAt: string;
    generationMode: string;
    id: string;
    kind: SummaryKind;
    lifecycleStatus: string;
    precision: SummaryPrecision;
    projectId: string;
    sourceId: string | null;
    sourceVersion: string | null;
    updatedAt: string;
};
export type WritingCard = {
    cardType: string;
    content: string;
    createdAt: string;
    enabled: boolean;
    id: string;
    projectId: string;
    scope: string;
    sortOrder: number;
    sourceVersion: string | null;
    title: string;
    updatedAt: string;
};
export type DatabaseHealthResponse = {
    foreignKeysEnabled: boolean;
    journalMode: string;
    schemaVersion: number;
    sqliteVersion: string;
    status: string;
};
export type HealthScanReport = {
    errors: string[];
    ftsRows: number;
    schemaVersion: number;
    sqliteIntegrity: string;
    status: string;
    warnings: string[];
};
export type AiProposalReview = {
    consistency: AiConsistencyReport | null;
    consistencyFreshness: ConsistencyReviewFreshness | null;
    feedback: AiProposalFeedback | null;
    hasReviewTrace: boolean;
    proposal: AiProposal;
    validation: AiOutputValidation;
};
export type AiConsistencyReport = {
    findings: AiConsistencyFinding[];
    parseWarnings: string[];
    summary: string;
    verdict: AiConsistencyVerdict;
};
export type AiConsistencyFinding = {
    evidence: string;
    problem: string;
    severity: AiConsistencySeverity;
    suggestion: string;
};
export type AiProposalFeedback = {
    createdAt: string;
    note: string | null;
    proposalId: string;
    rating: AiProposalFeedbackRating;
    updatedAt: string;
};
export type AiOutputValidation = {
    characterCount: number;
    estimatedOutputTokens: number;
    messages: string[];
    paragraphCount: number;
    status: string;
};
export type AiRun = {
    action: string;
    attemptCount: number;
    chapterId: string | null;
    chapterTitle: string;
    createdAt: string;
    errorCode: string | null;
    estimatedCostMicros: number | null;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    finishedAt: string | null;
    id: string;
    priceCurrency: string;
    profileName: string;
    promptVersion: string;
    retryReason: string | null;
    reviewPurpose: ReviewPurpose;
    source: string;
    status: string;
    taskKey: string;
};
export type RecoveryLog = {
    chapterId: string;
    createdAt: string;
    documentJson: string;
    id: string;
};
export type AuthorSetting = {
    content: string;
    createdAt: string;
    entityId: string;
    entityName: string;
    entityRevisionId: string;
    id: string;
    sessionId: string;
    sourceProposalId: string;
    visibility: string;
};
export type DiscussionDesignProposal = {
    contextVersion: string;
    createdAt: string;
    entities: DiscussionDesignEntity[];
    id: string;
    omittedMessageCount: number;
    promotedEntityIds: string[];
    sessionId: string;
    sourceMessageIds: string[];
    status: string;
    workspaceVersion: number;
};
export type DiscussionDesignEntity = {
    aliases: string[];
    attributes: unknown;
    description: string;
    entityType: EntityType;
    expectedEntityVersion: number | null;
    name: string;
    settings: string[];
    tags: string[];
    targetEntityId: string | null;
    visibility: string;
};
export type EntityChapter = {
    archived: boolean;
    chapterId: string;
    title: string;
};
export type JobEvent = {
    createdAt: string;
    id: string;
    jobId: string;
    message: string;
    progress: number;
    stage: string;
};
export type PlanningDiscussionSource = {
    candidate: DiscussionCandidate;
    projectId: string;
    sessionTitle: string;
};
export type RecentProject = {
    lastOpenedAt: string;
    name: string;
    root: string;
};
export type MergeResult = {
    conflicts: MergeConflict[];
    documentJson: string;
};
export type MergeConflict = {
    base: string | null;
    blockId: string;
    current: string | null;
    draft: string | null;
};
export type WorldState = {
    createdAt: string;
    entries: WorldStateEntry[];
    id: string;
    knowledgeVersionId: string;
    projectId: string;
};
export type WorldStateEntry = {
    factKnowledgeId: string;
    factVersion: number;
    object: string;
    predicate: string;
    subject: string;
};
export type SearchResult = {
    blockId: string | null;
    objectId: string;
    objectType: string;
    snippet: string;
    sourceVersion: string | null;
};
export type StartupRecoveryReport = {
    actions: string[];
    crashMarkerPresent: boolean;
    migrationInterrupted: boolean;
    recoveryLogCount: number;
    tempFileCount: number;
    unfinishedJobCount: number;
    walPresent: boolean;
};
export type ModelConnectionResponse = {
    capability: ModelCapability;
    detail: string;
    modelId: string;
    provider: ModelProvider;
};
