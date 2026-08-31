use super::*;

#[derive(Debug, Error)]
pub enum MaterialsStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("material database operation failed: {0}")]
    Database(#[from] DatabaseError),
    #[error("material content cannot be empty")]
    EmptyContent,
}

impl ProjectManager {
    pub fn list_summary_materials(&self) -> Result<Vec<SummaryMaterial>, MaterialsStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(MaterialsStoreError::NoProject)?;
        session
            .database
            .list_summary_materials(session.manifest.project_id)
            .map_err(Into::into)
    }

    pub fn upsert_summary_material(
        &mut self,
        mut material: SummaryMaterial,
    ) -> Result<SummaryMaterial, MaterialsStoreError> {
        if material.content.trim().is_empty() {
            return Err(MaterialsStoreError::EmptyContent);
        }
        let session = self
            .current
            .as_mut()
            .ok_or(MaterialsStoreError::NoProject)?;
        material.project_id = session.manifest.project_id;
        session
            .database
            .upsert_summary_material(session.manifest.project_id, material)
            .map_err(Into::into)
    }

    pub fn list_writing_cards(
        &self,
        card_type: Option<String>,
    ) -> Result<Vec<WritingCard>, MaterialsStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(MaterialsStoreError::NoProject)?;
        session
            .database
            .list_writing_cards(session.manifest.project_id, card_type.as_deref())
            .map_err(Into::into)
    }

    pub fn upsert_writing_card(
        &mut self,
        mut card: WritingCard,
    ) -> Result<WritingCard, MaterialsStoreError> {
        if card.title.trim().is_empty() || card.content.trim().is_empty() {
            return Err(MaterialsStoreError::EmptyContent);
        }
        let session = self
            .current
            .as_mut()
            .ok_or(MaterialsStoreError::NoProject)?;
        card.project_id = session.manifest.project_id;
        session
            .database
            .upsert_writing_card(session.manifest.project_id, card)
            .map_err(Into::into)
    }

    pub fn set_writing_card_enabled(
        &mut self,
        id: Uuid,
        enabled: bool,
    ) -> Result<WritingCard, MaterialsStoreError> {
        let session = self
            .current
            .as_mut()
            .ok_or(MaterialsStoreError::NoProject)?;
        session
            .database
            .set_writing_card_enabled(session.manifest.project_id, id, enabled)
            .map_err(Into::into)
    }

    pub fn set_summary_material_lifecycle(
        &mut self,
        id: Uuid,
        lifecycle_status: String,
    ) -> Result<SummaryMaterial, MaterialsStoreError> {
        let session = self
            .current
            .as_mut()
            .ok_or(MaterialsStoreError::NoProject)?;
        session
            .database
            .set_summary_material_lifecycle(session.manifest.project_id, id, lifecycle_status)
            .map_err(Into::into)
    }

    pub fn rebuild_summary_material(
        &mut self,
        id: Uuid,
    ) -> Result<SummaryMaterial, MaterialsStoreError> {
        let session = self
            .current
            .as_mut()
            .ok_or(MaterialsStoreError::NoProject)?;
        session
            .database
            .rebuild_summary_material(session.manifest.project_id, id)
            .map_err(Into::into)
    }
}

impl Database {
    fn list_summary_materials(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<SummaryMaterial>, DatabaseError> {
        let mut stmt = self.connection.prepare("SELECT id, project_id, kind, precision, source_id, source_version, content, generation_mode, lifecycle_status, created_at, updated_at FROM summary_materials WHERE project_id = ?1 ORDER BY kind, precision")?;
        let rows = stmt.query_map([project_id.to_string()], |row| {
            Ok(SummaryMaterial {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap(),
                project_id: Uuid::parse_str(&row.get::<_, String>(1)?).unwrap(),
                kind: parse_summary_kind(&row.get::<_, String>(2)?),
                precision: parse_precision(&row.get::<_, String>(3)?),
                source_id: row
                    .get::<_, Option<String>>(4)?
                    .and_then(|v| Uuid::parse_str(&v).ok()),
                source_version: row.get(5)?,
                content: row.get(6)?,
                generation_mode: row.get(7)?,
                lifecycle_status: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    fn upsert_summary_material(
        &mut self,
        project_id: Uuid,
        material: SummaryMaterial,
    ) -> Result<SummaryMaterial, DatabaseError> {
        self.connection.execute("INSERT INTO summary_materials (id, project_id, kind, precision, source_id, source_version, content, generation_mode, lifecycle_status, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,(strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ON CONFLICT(id) DO UPDATE SET content=excluded.content, source_id=excluded.source_id, source_version=excluded.source_version, generation_mode=excluded.generation_mode, lifecycle_status=excluded.lifecycle_status, updated_at=excluded.updated_at", rusqlite::params![material.id.to_string(), project_id.to_string(), summary_kind_str(material.kind), precision_str(material.precision), material.source_id.map(|v| v.to_string()), material.source_version, material.content, material.generation_mode, material.lifecycle_status])?;
        Ok(material)
    }
    fn list_writing_cards(
        &self,
        project_id: Uuid,
        card_type: Option<&str>,
    ) -> Result<Vec<WritingCard>, DatabaseError> {
        let mut stmt = self.connection.prepare("SELECT id, project_id, card_type, title, content, source_version, scope, enabled, sort_order, created_at, updated_at FROM writing_cards WHERE project_id = ?1 AND (?2 IS NULL OR card_type = ?2) ORDER BY sort_order, updated_at DESC")?;
        let rows = stmt.query_map(
            rusqlite::params![project_id.to_string(), card_type],
            |row| {
                Ok(WritingCard {
                    id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap(),
                    project_id: Uuid::parse_str(&row.get::<_, String>(1)?).unwrap(),
                    card_type: row.get(2)?,
                    title: row.get(3)?,
                    content: row.get(4)?,
                    source_version: row.get(5)?,
                    scope: row.get(6)?,
                    enabled: row.get::<_, i64>(7)? == 1,
                    sort_order: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
    fn upsert_writing_card(
        &mut self,
        project_id: Uuid,
        card: WritingCard,
    ) -> Result<WritingCard, DatabaseError> {
        self.connection.execute("INSERT INTO writing_cards (id, project_id, card_type, title, content, source_version, scope, enabled, sort_order, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,(strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, source_version=excluded.source_version, scope=excluded.scope, enabled=excluded.enabled, sort_order=excluded.sort_order, updated_at=excluded.updated_at", rusqlite::params![card.id.to_string(), project_id.to_string(), card.card_type, card.title, card.content, card.source_version, card.scope, i64::from(card.enabled), card.sort_order])?;
        Ok(card)
    }

    fn set_writing_card_enabled(
        &mut self,
        project_id: Uuid,
        id: Uuid,
        enabled: bool,
    ) -> Result<WritingCard, DatabaseError> {
        self.connection.execute(
            "UPDATE writing_cards SET enabled = ?1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![i64::from(enabled), id.to_string(), project_id.to_string()],
        )?;
        self.connection
            .query_row(
                "SELECT id, project_id, card_type, title, content, source_version, scope, enabled, sort_order, created_at, updated_at FROM writing_cards WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![id.to_string(), project_id.to_string()],
                |row| Ok(WritingCard { id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap(), project_id: Uuid::parse_str(&row.get::<_, String>(1)?).unwrap(), card_type: row.get(2)?, title: row.get(3)?, content: row.get(4)?, source_version: row.get(5)?, scope: row.get(6)?, enabled: row.get::<_, i64>(7)? == 1, sort_order: row.get(8)?, created_at: row.get(9)?, updated_at: row.get(10)? }),
            )
            .map_err(DatabaseError::from)
    }

    fn set_summary_material_lifecycle(
        &mut self,
        project_id: Uuid,
        id: Uuid,
        lifecycle_status: String,
    ) -> Result<SummaryMaterial, DatabaseError> {
        self.connection.execute("UPDATE summary_materials SET lifecycle_status = ?1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?2 AND project_id = ?3", rusqlite::params![lifecycle_status, id.to_string(), project_id.to_string()])?;
        self.connection.query_row("SELECT id, project_id, kind, precision, source_id, source_version, content, generation_mode, lifecycle_status, created_at, updated_at FROM summary_materials WHERE id = ?1 AND project_id = ?2", rusqlite::params![id.to_string(), project_id.to_string()], |row| Ok(SummaryMaterial { id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap(), project_id: Uuid::parse_str(&row.get::<_, String>(1)?).unwrap(), kind: parse_summary_kind(&row.get::<_, String>(2)?), precision: parse_precision(&row.get::<_, String>(3)?), source_id: row.get::<_, Option<String>>(4)?.and_then(|v| Uuid::parse_str(&v).ok()), source_version: row.get(5)?, content: row.get(6)?, generation_mode: row.get(7)?, lifecycle_status: row.get(8)?, created_at: row.get(9)?, updated_at: row.get(10)? })).map_err(DatabaseError::from)
    }

    fn rebuild_summary_material(
        &mut self,
        project_id: Uuid,
        id: Uuid,
    ) -> Result<SummaryMaterial, DatabaseError> {
        self.connection.execute("UPDATE summary_materials SET lifecycle_status = 'ACTIVE', generation_mode = 'MANUAL_REBUILD', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?1 AND project_id = ?2", rusqlite::params![id.to_string(), project_id.to_string()])?;
        self.connection.query_row("SELECT id, project_id, kind, precision, source_id, source_version, content, generation_mode, lifecycle_status, created_at, updated_at FROM summary_materials WHERE id = ?1 AND project_id = ?2", rusqlite::params![id.to_string(), project_id.to_string()], |row| Ok(SummaryMaterial { id: Uuid::parse_str(&row.get::<_, String>(0)?).unwrap(), project_id: Uuid::parse_str(&row.get::<_, String>(1)?).unwrap(), kind: parse_summary_kind(&row.get::<_, String>(2)?), precision: parse_precision(&row.get::<_, String>(3)?), source_id: row.get::<_, Option<String>>(4)?.and_then(|v| Uuid::parse_str(&v).ok()), source_version: row.get(5)?, content: row.get(6)?, generation_mode: row.get(7)?, lifecycle_status: row.get(8)?, created_at: row.get(9)?, updated_at: row.get(10)? })).map_err(DatabaseError::from)
    }
}

fn summary_kind_str(value: SummaryKind) -> &'static str {
    match value {
        SummaryKind::Chapter => "CHAPTER",
        SummaryKind::Character => "CHARACTER",
        SummaryKind::Setting => "SETTING",
    }
}
fn parse_summary_kind(value: &str) -> SummaryKind {
    match value {
        "CHARACTER" => SummaryKind::Character,
        "SETTING" => SummaryKind::Setting,
        _ => SummaryKind::Chapter,
    }
}
fn precision_str(value: SummaryPrecision) -> &'static str {
    match value {
        SummaryPrecision::L0 => "L0",
        SummaryPrecision::L1 => "L1",
        SummaryPrecision::L2 => "L2",
        SummaryPrecision::L3 => "L3",
        SummaryPrecision::L4 => "L4",
        SummaryPrecision::L5 => "L5",
    }
}
fn parse_precision(value: &str) -> SummaryPrecision {
    match value {
        "L1" => SummaryPrecision::L1,
        "L2" => SummaryPrecision::L2,
        "L3" => SummaryPrecision::L3,
        "L4" => SummaryPrecision::L4,
        "L5" => SummaryPrecision::L5,
        _ => SummaryPrecision::L0,
    }
}
