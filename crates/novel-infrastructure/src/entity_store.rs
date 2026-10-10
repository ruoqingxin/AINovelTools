use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityCard {
    pub entity: Entity,
    pub revision: EntityRevision,
}

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
    pub fn list_entity_cards(
        &self,
        include_archived: bool,
    ) -> Result<Vec<EntityCard>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        session
            .database
            .list_entity_cards(session.manifest.project_id, include_archived)
    }

    pub fn list_entities(&self, include_archived: bool) -> Result<Vec<Entity>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        session
            .database
            .list_entities(session.manifest.project_id, include_archived)
    }

    pub fn upsert_entity(&mut self, input: EntityInput) -> Result<Entity, EntityStoreError> {
        input.validate()?;
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        let entity = session
            .database
            .upsert_entity(session.manifest.project_id, input)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(entity)
    }

    pub fn list_entity_revisions(
        &self,
        entity_id: Uuid,
    ) -> Result<Vec<EntityRevision>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        session.database.list_entity_revisions(entity_id)
    }

    pub(crate) fn list_current_entity_revisions(
        &self,
    ) -> Result<Vec<(Entity, EntityRevision)>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        session
            .database
            .list_current_entity_revisions(session.manifest.project_id)
    }

    pub fn set_entity_archived(
        &mut self,
        id: Uuid,
        archived: bool,
        expected_version: i64,
    ) -> Result<Entity, EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        let entity = session.database.set_entity_archived(
            session.manifest.project_id,
            id,
            archived,
            expected_version,
        )?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(entity)
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

pub(super) fn map_entity(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entity> {
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
    map_entity_revision_at(row, 0)
}

fn map_entity_revision_at(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<EntityRevision> {
    let parse_uuid = |index: usize| -> rusqlite::Result<Uuid> {
        let index = index + offset;
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
        revision: row.get(2 + offset)?,
        name: row.get(3 + offset)?,
        aliases: serde_json::from_str(&row.get::<_, String>(4 + offset)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4 + offset,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        description: row.get(5 + offset)?,
        fixed_attributes_json: row.get(6 + offset)?,
        tags: serde_json::from_str(&row.get::<_, String>(7 + offset)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7 + offset,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        base_revision_id: row
            .get::<_, Option<String>>(8 + offset)?
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8 + offset,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
        source_version: row.get(9 + offset)?,
        created_at: row.get(10 + offset)?,
    })
}

impl Database {
    pub(super) fn list_entity_cards(
        &self,
        project_id: Uuid,
        include_archived: bool,
    ) -> Result<Vec<EntityCard>, EntityStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT e.id, e.project_id, e.entity_type, e.lifecycle_status, e.current_revision_id, e.version, e.created_at, e.updated_at,
                    r.id, r.entity_id, r.revision, r.name, r.aliases_json, r.description, r.fixed_attributes_json, r.tags_json, r.base_revision_id, r.source_version, r.created_at
             FROM entities e JOIN entity_revisions r ON r.id = e.current_revision_id AND r.entity_id = e.id
             WHERE e.project_id = ?1 AND (?2 OR e.lifecycle_status = 'ACTIVE')
             ORDER BY e.updated_at DESC, e.id",
        )?;
        let rows = statement.query_map(
            rusqlite::params![project_id.to_string(), include_archived],
            |row| {
                Ok(EntityCard {
                    entity: map_entity(row)?,
                    revision: map_entity_revision_at(row, 8)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn list_current_entity_revisions(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<(Entity, EntityRevision)>, EntityStoreError> {
        let mut statement = self.connection.prepare_cached(
            "SELECT e.id, e.project_id, e.entity_type, e.lifecycle_status, e.current_revision_id, e.version, e.created_at, e.updated_at,
                    r.id, r.entity_id, r.revision, r.name, r.aliases_json, r.description, r.fixed_attributes_json, r.tags_json, r.base_revision_id, r.source_version, r.created_at
             FROM entities e JOIN entity_revisions r ON r.id = e.current_revision_id AND r.entity_id = e.id
             WHERE e.project_id = ?1 AND e.lifecycle_status = 'ACTIVE'
             ORDER BY e.updated_at DESC, e.created_at DESC",
        )?;
        let rows = statement.query_map([project_id.to_string()], |row| {
            Ok((map_entity(row)?, map_entity_revision_at(row, 8)?))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

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
        let transaction = self.connection.transaction()?;
        let entity_id = Self::upsert_entity_in_tx(&transaction, project_id, input)?;
        transaction.commit()?;
        self.get_entity(project_id, entity_id)
    }

    pub(super) fn upsert_entity_in_tx(
        tx: &rusqlite::Transaction<'_>,
        project_id: Uuid,
        input: EntityInput,
    ) -> Result<Uuid, EntityStoreError> {
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
        let existing: Option<(i64, String)> = tx
            .query_row(
                "SELECT version, entity_type FROM entities WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![entity_id.to_string(), project_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let is_existing = existing.is_some();
        let previous_revision_id: Option<String> = if is_existing {
            Some(tx.query_row(
                "SELECT current_revision_id FROM entities WHERE id=?1 AND project_id=?2",
                rusqlite::params![entity_id.to_string(), project_id.to_string()],
                |row| row.get(0),
            )?)
        } else {
            None
        };
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
            let current_revision: i64 = tx.query_row(
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
            tx.execute(
                "INSERT INTO entities (id, project_id, entity_type, current_revision_id, version) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![entity_id.to_string(), project_id.to_string(), entity_type_str(input.entity_type), revision_id.to_string(), version],
            )?;
        }
        tx.execute(
            "INSERT INTO entity_revisions (id, entity_id, revision, name, aliases_json, description, fixed_attributes_json, tags_json, base_revision_id, source_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                revision_id.to_string(), entity_id.to_string(), revision, input.name.trim(), aliases_json,
                input.description, input.fixed_attributes_json, tags_json,
                base_revision_id.map(|id| id.to_string()), input.source_version,
            ],
        )?;
        if is_existing {
            tx.execute(
                "UPDATE entities SET current_revision_id = ?1, version = ?2, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?3 AND project_id = ?4",
                rusqlite::params![revision_id.to_string(), version, entity_id.to_string(), project_id.to_string()],
            )?;
        }
        // Ordinary entity edits retain author rules; a confirmed discussion supplies a replacement snapshot.
        if let Some(previous_id) = previous_revision_id
            && !input
                .source_version
                .as_deref()
                .is_some_and(|value| value.starts_with("discussion:"))
        {
            let settings = {
                let mut statement = tx.prepare(
                    "SELECT content,visibility,source_proposal_id FROM author_settings WHERE entity_revision_id=?1",
                )?;
                let rows = statement.query_map([previous_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (content, visibility, source_id) in settings {
                tx.execute(
                    "INSERT INTO author_settings
                     (id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![Uuid::new_v4().to_string(), project_id.to_string(),
                        entity_id.to_string(), revision_id.to_string(), content, visibility, source_id],
                )?;
            }
        }
        Ok(entity_id)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> EntityInput {
        EntityInput {
            id: None,
            entity_type: EntityType::Character,
            name: name.into(),
            aliases: vec!["alias".into()],
            description: format!("{name} description"),
            fixed_attributes_json: r#"{"role":"main"}"#.into(),
            tags: vec!["tag".into()],
            base_revision_id: None,
            source_version: Some("test:1".into()),
            expected_version: None,
        }
    }

    #[test]
    fn current_entity_lookup_includes_only_active_current_revisions_in_the_project() {
        let mut database = Database::in_memory().expect("database");
        let project_id = Uuid::new_v4();
        let first = database
            .upsert_entity(project_id, input("old name"))
            .expect("entity");
        let mut update = input("current name");
        update.id = Some(first.id);
        update.expected_version = Some(first.version);
        update.base_revision_id = Some(first.current_revision_id);
        update.source_version = Some("test:2".into());
        let current = database.upsert_entity(project_id, update).expect("update");
        let archived = database
            .upsert_entity(project_id, input("archived"))
            .expect("archived entity");
        database
            .set_entity_archived(project_id, archived.id, true, archived.version)
            .expect("archive");
        database
            .upsert_entity(Uuid::new_v4(), input("other project"))
            .expect("other entity");

        let records = database
            .list_current_entity_revisions(project_id)
            .expect("current records");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].0, current);
        let revision = &records[0].1;
        assert_eq!(
            revision,
            &database.list_entity_revisions(first.id).expect("history")[0]
        );
        assert_eq!(revision.name, "current name");
        assert_eq!(revision.source_version.as_deref(), Some("test:2"));
        assert_eq!(revision.aliases, vec!["alias"]);
        assert_eq!(revision.tags, vec!["tag"]);
        assert_eq!(revision.base_revision_id, Some(first.current_revision_id));
    }

    #[test]
    fn entity_cards_read_only_exact_current_revisions_and_filter_project_and_archive() {
        let mut database = Database::in_memory().unwrap();
        let project_id = Uuid::new_v4();
        let first = database
            .upsert_entity(project_id, input("old name"))
            .unwrap();
        let mut update = input("current name");
        update.id = Some(first.id);
        update.expected_version = Some(first.version);
        update.base_revision_id = Some(first.current_revision_id);
        let current = database.upsert_entity(project_id, update).unwrap();
        let archived = database
            .upsert_entity(project_id, input("archived"))
            .unwrap();
        database
            .set_entity_archived(project_id, archived.id, true, archived.version)
            .unwrap();
        database
            .upsert_entity(Uuid::new_v4(), input("foreign"))
            .unwrap();
        let before = database.connection.total_changes();
        let active = database.list_entity_cards(project_id, false).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].entity, current);
        assert_eq!(active[0].revision.id, current.current_revision_id);
        assert_eq!(active[0].revision.name, "current name");
        let all = database.list_entity_cards(project_id, true).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|card| card.entity.id == archived.id));
        assert_eq!(database.connection.total_changes(), before);
        // A dangling current pointer must not silently return an older revision.
        database
            .connection
            .execute(
                "UPDATE entities SET current_revision_id=?1 WHERE id=?2",
                rusqlite::params![Uuid::new_v4().to_string(), first.id.to_string()],
            )
            .unwrap();
        assert!(
            database
                .list_entity_cards(project_id, false)
                .unwrap()
                .is_empty()
        );
    }
}
