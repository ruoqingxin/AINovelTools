use serde::Serialize;

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ApiError {
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: message.into(),
        }
    }
}

impl From<novel_infrastructure::ManuscriptSourceError> for ApiError {
    fn from(error: novel_infrastructure::ManuscriptSourceError) -> Self {
        use novel_infrastructure::ManuscriptSourceError;
        let code = match error {
            ManuscriptSourceError::NoProject => "NO_PROJECT_OPEN",
            ManuscriptSourceError::NotFound => "SOURCE_NOT_FOUND",
            ManuscriptSourceError::Mismatch => "SOURCE_MISMATCH",
            ManuscriptSourceError::InvalidRequest | ManuscriptSourceError::InvalidDocument => {
                "INVALID_SOURCE"
            }
            ManuscriptSourceError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::ProjectError> for ApiError {
    fn from(error: novel_infrastructure::ProjectError) -> Self {
        let code = match error {
            novel_infrastructure::ProjectError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::ProjectError::InvalidPath(_) => "INVALID_INPUT",
            novel_infrastructure::ProjectError::AlreadyExists(_) => "PROJECT_ALREADY_EXISTS",
            novel_infrastructure::ProjectError::NotInitialized(_) => "PROJECT_NOT_INITIALIZED",
            novel_infrastructure::ProjectError::Io(_) => "FILE_SYSTEM_ERROR",
            novel_infrastructure::ProjectError::Manifest(_) => "INVALID_MANIFEST",
            novel_infrastructure::ProjectError::Database(_) => "DATABASE_ERROR",
            novel_infrastructure::ProjectError::PlanningConflict { .. } => "VERSION_CONFLICT",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::PlanError> for ApiError {
    fn from(error: novel_infrastructure::PlanError) -> Self {
        let code = match error {
            novel_infrastructure::PlanError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::PlanError::EmptyTitle
            | novel_infrastructure::PlanError::InvalidParentKind
            | novel_infrastructure::PlanError::Cycle => "INVALID_INPUT",
            novel_infrastructure::PlanError::MissingParent(_)
            | novel_infrastructure::PlanError::MissingNode(_) => "NOT_FOUND",
            novel_infrastructure::PlanError::Conflict { .. } => "VERSION_CONFLICT",
            novel_infrastructure::PlanError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::BatchStoreError> for ApiError {
    fn from(error: novel_infrastructure::BatchStoreError) -> Self {
        use novel_infrastructure::BatchStoreError;
        let code = match error {
            BatchStoreError::NoProject => "NO_PROJECT_OPEN",
            BatchStoreError::WrongProject => "SOURCE_MISMATCH",
            BatchStoreError::InvalidBatch => "INVALID_INPUT",
            BatchStoreError::InvalidTarget => "NOT_FOUND",
            BatchStoreError::Entity(error) => return error.into(),
            BatchStoreError::Plan(error) => return error.into(),
            BatchStoreError::Project(error) => return error.into(),
            BatchStoreError::Database(_) | BatchStoreError::Sqlite(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::ManuscriptError> for ApiError {
    fn from(error: novel_infrastructure::ManuscriptError) -> Self {
        let code = match error {
            novel_infrastructure::ManuscriptError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::ManuscriptError::MissingChapter(_) => "NOT_FOUND",
            novel_infrastructure::ManuscriptError::EmptyDocument
            | novel_infrastructure::ManuscriptError::InvalidDocument(_) => "INVALID_DOCUMENT",
            novel_infrastructure::ManuscriptError::Conflict { .. } => "VERSION_CONFLICT",
            novel_infrastructure::ManuscriptError::DraftConflict { .. } => "DRAFT_VERSION_CONFLICT",
            novel_infrastructure::ManuscriptError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::EntityStoreError> for ApiError {
    fn from(error: novel_infrastructure::EntityStoreError) -> Self {
        let code = match error {
            novel_infrastructure::EntityStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::EntityStoreError::MissingEntity(_)
            | novel_infrastructure::EntityStoreError::MissingRevision(_) => "NOT_FOUND",
            novel_infrastructure::EntityStoreError::Contract(
                novel_infrastructure::EntityError::Conflict { .. },
            ) => "VERSION_CONFLICT",
            novel_infrastructure::EntityStoreError::Contract(_) => "INVALID_INPUT",
            novel_infrastructure::EntityStoreError::Sqlite(_)
            | novel_infrastructure::EntityStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::EntityReferenceError> for ApiError {
    fn from(error: novel_infrastructure::EntityReferenceError) -> Self {
        use novel_infrastructure::EntityReferenceError;
        let code = match error {
            EntityReferenceError::NoProject => "NO_PROJECT_OPEN",
            EntityReferenceError::WrongProject => "SOURCE_MISMATCH",
            EntityReferenceError::InvalidChapter | EntityReferenceError::InvalidEntity => {
                "NOT_FOUND"
            }
            EntityReferenceError::InvalidSelection => "INVALID_INPUT",
            EntityReferenceError::Conflict => "VERSION_CONFLICT",
            EntityReferenceError::Entity(error) => return error.into(),
            EntityReferenceError::Sqlite(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::MaterialsStoreError> for ApiError {
    fn from(error: novel_infrastructure::MaterialsStoreError) -> Self {
        let code = match error {
            novel_infrastructure::MaterialsStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::MaterialsStoreError::EmptyContent => "INVALID_INPUT",
            novel_infrastructure::MaterialsStoreError::InvalidTarget => "INVALID_MATERIAL_TARGET",
            novel_infrastructure::MaterialsStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::SearchStoreError> for ApiError {
    fn from(error: novel_infrastructure::SearchStoreError) -> Self {
        let code = match error {
            novel_infrastructure::SearchStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::SearchStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::KnowledgeStoreError> for ApiError {
    fn from(error: novel_infrastructure::KnowledgeStoreError) -> Self {
        let code = match error {
            novel_infrastructure::KnowledgeStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::KnowledgeStoreError::MissingCandidate(_)
            | novel_infrastructure::KnowledgeStoreError::MissingAnchor(_)
            | novel_infrastructure::KnowledgeStoreError::MissingFact(_)
            | novel_infrastructure::KnowledgeStoreError::MissingSourceRevision(_) => "NOT_FOUND",
            novel_infrastructure::KnowledgeStoreError::Conflict => "VERSION_CONFLICT",
            novel_infrastructure::KnowledgeStoreError::HighRiskConflict => "KNOWLEDGE_CONFLICT",
            novel_infrastructure::KnowledgeStoreError::EmptyCandidates
            | novel_infrastructure::KnowledgeStoreError::Contract(_)
            | novel_infrastructure::KnowledgeStoreError::Expansion(_) => "INVALID_INPUT",
            novel_infrastructure::KnowledgeStoreError::Sqlite(_)
            | novel_infrastructure::KnowledgeStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::ExtractionStoreError> for ApiError {
    fn from(error: novel_infrastructure::ExtractionStoreError) -> Self {
        let code = match error {
            novel_infrastructure::ExtractionStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::ExtractionStoreError::MissingItem(_) => "NOT_FOUND",
            novel_infrastructure::ExtractionStoreError::Conflict => "VERSION_CONFLICT",
            novel_infrastructure::ExtractionStoreError::InvalidPayload => "INVALID_INPUT",
            novel_infrastructure::ExtractionStoreError::Entity(error) => return error.into(),
            novel_infrastructure::ExtractionStoreError::Knowledge(error) => return error.into(),
            novel_infrastructure::ExtractionStoreError::Sqlite(_)
            | novel_infrastructure::ExtractionStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::DiscussionStoreError> for ApiError {
    fn from(error: novel_infrastructure::DiscussionStoreError) -> Self {
        let code = match error {
            novel_infrastructure::DiscussionStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::DiscussionStoreError::MissingSession(_)
            | novel_infrastructure::DiscussionStoreError::MissingMessage(_)
            | novel_infrastructure::DiscussionStoreError::MissingCandidate(_)
            | novel_infrastructure::DiscussionStoreError::MissingEvidenceAnchor(_) => "NOT_FOUND",
            novel_infrastructure::DiscussionStoreError::Conflict => "VERSION_CONFLICT",
            novel_infrastructure::DiscussionStoreError::InvalidPromotion
            | novel_infrastructure::DiscussionStoreError::InvalidScope
            | novel_infrastructure::DiscussionStoreError::LimitExceeded(_) => "INVALID_INPUT",
            novel_infrastructure::DiscussionStoreError::Entity(error) => return error.into(),
            novel_infrastructure::DiscussionStoreError::Sqlite(_)
            | novel_infrastructure::DiscussionStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::AiError> for ApiError {
    fn from(error: novel_infrastructure::AiError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::ReviewStoreError> for ApiError {
    fn from(error: novel_infrastructure::ReviewStoreError) -> Self {
        let code = match error {
            novel_infrastructure::ReviewStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::ReviewStoreError::MissingTrace(_) => "NOT_FOUND",
            novel_infrastructure::ReviewStoreError::Serialization(_)
            | novel_infrastructure::ReviewStoreError::Evidence(_) => "INVALID_INPUT",
            novel_infrastructure::ReviewStoreError::Sqlite(_)
            | novel_infrastructure::ReviewStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}
