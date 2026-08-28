use serde::Serialize;

#[derive(Debug, Serialize)]
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

impl From<novel_infrastructure::ProjectError> for ApiError {
    fn from(error: novel_infrastructure::ProjectError) -> Self {
        let code = match error {
            novel_infrastructure::ProjectError::InvalidPath(_) => "INVALID_INPUT",
            novel_infrastructure::ProjectError::AlreadyExists(_) => "PROJECT_ALREADY_EXISTS",
            novel_infrastructure::ProjectError::NotInitialized(_) => "PROJECT_NOT_INITIALIZED",
            novel_infrastructure::ProjectError::Io(_) => "FILE_SYSTEM_ERROR",
            novel_infrastructure::ProjectError::Manifest(_) => "INVALID_MANIFEST",
            novel_infrastructure::ProjectError::Database(_) => "DATABASE_ERROR",
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

impl From<novel_infrastructure::ManuscriptError> for ApiError {
    fn from(error: novel_infrastructure::ManuscriptError) -> Self {
        let code = match error {
            novel_infrastructure::ManuscriptError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::ManuscriptError::MissingChapter(_) => "NOT_FOUND",
            novel_infrastructure::ManuscriptError::EmptyDocument
            | novel_infrastructure::ManuscriptError::InvalidDocument(_) => "INVALID_DOCUMENT",
            novel_infrastructure::ManuscriptError::Conflict { .. } => "VERSION_CONFLICT",
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

impl From<novel_infrastructure::AiError> for ApiError {
    fn from(error: novel_infrastructure::AiError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}
