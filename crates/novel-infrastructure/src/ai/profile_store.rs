use super::*;

/// Application-wide model configuration store. It intentionally remains
/// independent from the currently open novel project.
pub struct ModelProfileStore {
    database: crate::Database,
}

impl ModelProfileStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        Ok(Self {
            database: crate::Database::open(path)?,
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, DatabaseError> {
        Ok(Self {
            database: crate::Database::in_memory()?,
        })
    }

    pub fn list(&self) -> Result<Vec<ModelProfile>, AiError> {
        let mut statement = self.database.connection.prepare(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles ORDER BY updated_at DESC"
        ).map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], read_profile)
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn get_ai_task_preferences(&self) -> Result<AiTaskPreferences, AiError> {
        let stored = self
            .database
            .connection
            .query_row(
                "SELECT value FROM app_metadata WHERE key = ?1",
                [AI_TASK_PREFERENCES_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        let mut preferences = stored.map_or_else(
            || Ok(AiTaskPreferences::default()),
            |value| serde_json::from_str(&value).map_err(|_| AiError::ContextSerialization),
        )?;
        preferences.set_recommended_defaults();
        Ok(preferences)
    }

    pub fn save_ai_task_preferences(
        &mut self,
        preferences: &AiTaskPreferences,
    ) -> Result<AiTaskPreferences, AiError> {
        let mut preferences = preferences.clone();
        preferences.set_recommended_defaults();
        let profiles = self.list()?;
        for preference in preferences.entries() {
            validate_ai_task_preference(preference, &profiles)?;
        }
        let value =
            serde_json::to_string(&preferences).map_err(|_| AiError::ContextSerialization)?;
        self.database
            .connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![AI_TASK_PREFERENCES_KEY, value],
            )
            .map_err(DatabaseError::from)?;
        Ok(preferences)
    }

    pub fn get_ai_budget_settings(&self) -> Result<AiBudgetSettings, AiError> {
        let stored = self
            .database
            .connection
            .query_row(
                "SELECT value FROM app_metadata WHERE key = ?1",
                [AI_BUDGET_SETTINGS_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        stored.map_or_else(
            || Ok(AiBudgetSettings::default()),
            |value| {
                let settings = serde_json::from_str::<AiBudgetSettings>(&value)
                    .map_err(|_| AiError::ContextSerialization)?;
                settings.validate()?;
                Ok(settings)
            },
        )
    }

    pub fn save_ai_budget_settings(
        &mut self,
        settings: &AiBudgetSettings,
    ) -> Result<AiBudgetSettings, AiError> {
        settings.validate()?;
        let mut normalized = settings.clone();
        normalized.currency = normalized.currency.trim().to_uppercase();
        let value =
            serde_json::to_string(&normalized).map_err(|_| AiError::ContextSerialization)?;
        self.database
            .connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![AI_BUDGET_SETTINGS_KEY, value],
            )
            .map_err(DatabaseError::from)?;
        Ok(normalized)
    }

    pub fn get(&self, id: Uuid) -> Result<ModelProfile, AiError> {
        self.database.connection.query_row(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles WHERE id = ?1",
            [id.to_string()], read_profile,
        ).optional().map_err(DatabaseError::from)?.ok_or(AiError::MissingProfile(id))
    }

    pub fn upsert(&mut self, input: ModelProfileInput) -> Result<ModelProfile, AiError> {
        input.validate()?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        self.database.connection.execute(
            "INSERT INTO model_profiles (id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, capability=excluded.capability, base_url=excluded.base_url, model_id=excluded.model_id, context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens, privacy_level=excluded.privacy_level, timeout_seconds=excluded.timeout_seconds, retry_limit=excluded.retry_limit, input_price_micros_per_million=excluded.input_price_micros_per_million, output_price_micros_per_million=excluded.output_price_micros_per_million, price_currency=excluded.price_currency, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id.to_string(), input.name.trim(), provider_str(input.provider), capability_str(input.capability), input.base_url.trim_end_matches('/'), input.model_id.trim(), input.context_window, input.max_output_tokens, privacy_str(input.privacy_level), input.timeout_seconds, input.retry_limit, i64::try_from(input.input_price_micros_per_million).unwrap_or(i64::MAX), i64::try_from(input.output_price_micros_per_million).unwrap_or(i64::MAX), input.price_currency.trim()],
        ).map_err(DatabaseError::from)?;
        self.get(id)
    }

    pub fn set_secret_ref(
        &mut self,
        id: Uuid,
        secret_ref: Option<&str>,
    ) -> Result<ModelProfile, AiError> {
        let changed = self.database.connection.execute(
            "UPDATE model_profiles SET secret_ref = ?2, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?1",
            rusqlite::params![id.to_string(), secret_ref],
        ).map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::MissingProfile(id));
        }
        self.get(id)
    }
}
