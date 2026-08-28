use super::*;

#[derive(Debug, Error)]
pub enum EntityStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("entity does not exist: {0}")]
    MissingEntity(Uuid),
    #[error("entity revision does not exist: {0}")]
    MissingRevision(Uuid),
    #[error(transparent)]
    Contract(#[from] EntityError),
    #[error("entity sqlite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("entity database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl ProjectManager {
    pub fn list_entities(&self, include_archived: bool) -> Result<Vec<Entity>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        session
            .database
            .list_entities(session.manifest.project_id, include_archived)
    }

    pub fn upsert_entity(&mut self, input: EntityInput) -> Result<Entity, EntityStoreError> {
        input.validate()?;
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        session
            .database
            .upsert_entity(session.manifest.project_id, input)
    }

    pub fn list_entity_revisions(
        &self,
        entity_id: Uuid,
    ) -> Result<Vec<EntityRevision>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        session.database.list_entity_revisions(entity_id)
    }

    pub fn set_entity_archived(
        &mut self,
        id: Uuid,
        archived: bool,
        expected_version: i64,
    ) -> Result<Entity, EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        session.database.set_entity_archived(
            session.manifest.project_id,
            id,
            archived,
            expected_version,
        )
    }
}

fn entity_type_str(value: EntityType) -> &'static str {
    match value {
        EntityType::Character => "CHARACTER",
        EntityType::Location => "LOCATION",
        EntityType::Faction => "FACTION",
        EntityType::Item => "ITEM",
        EntityType::Concept => "CONCEPT",
    }
}

fn parse_entity_type(value: &str) -> rusqlite::Result<EntityType> {
    match value {
        "CHARACTER" => Ok(EntityType::Character),
        "LOCATION" => Ok(EntityType::Location),
        "FACTION" => Ok(EntityType::Faction),
        "ITEM" => Ok(EntityType::Item),
        "CONCEPT" => Ok(EntityType::Concept),
        _ => Err(rusqlite::Error::InvalidColumnType(
            2,
            "entity_type".to_owned(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn map_entity(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entity> {
    Ok(Entity {
        id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        project_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        entity_type: parse_entity_type(&row.get::<_, String>(2)?)?,
        lifecycle_status: match row.get::<_, String>(3)?.as_str() {
            "ACTIVE" => EntityLifecycleStatus::Active,
            "ARCHIVED" => EntityLifecycleStatus::Archived,
            _ => EntityLifecycleStatus::Active,
        },
        current_revision_id: Uuid::parse_str(&row.get::<_, String>(4)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        version: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_entity_revision(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntityRevision> {
    let parse_uuid = |index: usize| -> rusqlite::Result<Uuid> {
        Uuid::parse_str(&row.get::<_, String>(index)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    };
    Ok(EntityRevision {
        id: parse_uuid(0)?,
        entity_id: parse_uuid(1)?,
        revision: row.get(2)?,
        name: row.get(3)?,
        aliases: serde_json::from_str(&row.get::<_, String>(4)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        description: row.get(5)?,
        fixed_attributes_json: row.get(6)?,
        tags: serde_json::from_str(&row.get::<_, String>(7)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        base_revision_id: row
            .get::<_, Option<String>>(8)?
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
        source_version: row.get(9)?,
        created_at: row.get(10)?,
    })
}

impl Database {
    fn list_entities(
        &self,
        project_id: Uuid,
        include_archived: bool,
    ) -> Result<Vec<Entity>, EntityStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, entity_type, lifecycle_status, current_revision_id, version, created_at, updated_at
             FROM entities WHERE project_id = ?1 AND (?2 = 1 OR lifecycle_status = 'ACTIVE')
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows = statement.query_map(
            rusqlite::params![project_id.to_string(), i64::from(include_archived)],
            map_entity,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(EntityStoreError::from)
    }

    fn upsert_entity(
        &mut self,
        project_id: Uuid,
        input: EntityInput,
    ) -> Result<Entity, EntityStoreError> {
        let entity_id = input.id.unwrap_or_else(Uuid::new_v4);
        let aliases_json = serde_json::to_string(&input.aliases).map_err(|error| {
            EntityStoreError::Database(DatabaseError::Sqlite(
                rusqlite::Error::ToSqlConversionFailure(Box::new(error)),
            ))
        })?;
        let tags_json = serde_json::to_string(&input.tags).map_err(|error| {
            EntityStoreError::Database(DatabaseError::Sqlite(
                rusqlite::Error::ToSqlConversionFailure(Box::new(error)),
            ))
        })?;
        let revision_id = Uuid::new_v4();
        let transaction = self.connection.transaction()?;
        let existing: Option<(i64, String)> = transaction
            .query_row(
                "SELECT version, entity_type FROM entities WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![entity_id.to_string(), project_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let is_existing = existing.is_some();
        let (version, revision, base_revision_id) = if let Some((version, entity_type)) = existing {
            if input.expected_version != Some(version) {
                return Err(EntityStoreError::Contract(EntityError::Conflict {
                    expected: input.expected_version.unwrap_or(-1),
                    actual: version,
                }));
            }
            if entity_type != entity_type_str(input.entity_type) {
                return Err(EntityStoreError::Database(DatabaseError::Sqlite(
                    rusqlite::Error::InvalidParameterName("entity_type cannot change".to_owned()),
                )));
            }
            let current_revision: i64 = transaction.query_row(
                "SELECT revision FROM entity_revisions WHERE id = (SELECT current_revision_id FROM entities WHERE id = ?1)",
                [entity_id.to_string()],
                |row| row.get(0),
            )?;
            (version + 1, current_revision + 1, input.base_revision_id)
        } else {
            if input.expected_version.is_some() {
                return Err(EntityStoreError::MissingEntity(entity_id));
            }
            (1, 1, input.base_revision_id)
        };
        if !is_existing {
            transaction.execute(
                "INSERT INTO entities (id, project_id, entity_type, current_revision_id, version) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![entity_id.to_string(), project_id.to_string(), entity_type_str(input.entity_type), revision_id.to_string(), version],
            )?;
        }
        transaction.execute(
            "INSERT INTO entity_revisions (id, entity_id, revision, name, aliases_json, description, fixed_attributes_json, tags_json, base_revision_id, source_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                revision_id.to_string(), entity_id.to_string(), revision, input.name.trim(), aliases_json,
                input.description, input.fixed_attributes_json, tags_json,
                base_revision_id.map(|id| id.to_string()), input.source_version,
            ],
        )?;
        if is_existing {
            transaction.execute(
                "UPDATE entities SET current_revision_id = ?1, version = ?2, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?3 AND project_id = ?4",
                rusqlite::params![revision_id.to_string(), version, entity_id.to_string(), project_id.to_string()],
            )?;
        }
        transaction.commit()?;
        self.get_entity(project_id, entity_id)
    }

    fn get_entity(&self, project_id: Uuid, id: Uuid) -> Result<Entity, EntityStoreError> {
        self.connection
            .query_row(
                "SELECT id, project_id, entity_type, lifecycle_status, current_revision_id, version, created_at, updated_at FROM entities WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![id.to_string(), project_id.to_string()],
                map_entity,
            )
            .optional()?
            .ok_or(EntityStoreError::MissingEntity(id))
    }

    fn list_entity_revisions(
        &self,
        entity_id: Uuid,
    ) -> Result<Vec<EntityRevision>, EntityStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, entity_id, revision, name, aliases_json, description, fixed_attributes_json, tags_json, base_revision_id, source_version, created_at
             FROM entity_revisions WHERE entity_id = ?1 ORDER BY revision DESC",
        )?;
        let rows = statement.query_map([entity_id.to_string()], map_entity_revision)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(EntityStoreError::from)
    }

    fn set_entity_archived(
        &mut self,
        project_id: Uuid,
        id: Uuid,
        archived: bool,
        expected_version: i64,
    ) -> Result<Entity, EntityStoreError> {
        let changed = self.connection.execute(
            "UPDATE entities SET lifecycle_status = ?1, version = version + 1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?2 AND project_id = ?3 AND version = ?4",
            rusqlite::params![if archived { "ARCHIVED" } else { "ACTIVE" }, id.to_string(), project_id.to_string(), expected_version],
        )?;
        if changed == 0 {
            if self.get_entity(project_id, id).is_err() {
                return Err(EntityStoreError::MissingEntity(id));
            }
            return Err(EntityStoreError::Contract(EntityError::Conflict {
                expected: expected_version,
                actual: self.get_entity(project_id, id)?.version,
            }));
        }
        self.get_entity(project_id, id)
    }
}
