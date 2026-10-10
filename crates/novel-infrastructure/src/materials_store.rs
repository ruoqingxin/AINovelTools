use super::*;

#[derive(Debug, Error)]
pub enum MaterialsStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("material database operation failed: {0}")]
    Database(#[from] DatabaseError),
    #[error("material content cannot be empty")]
    EmptyContent,
    #[error("material does not belong to the expected project or no longer exists")]
    InvalidTarget,
}

impl ProjectManager {
    pub fn get_summary_material(
        &self,
        id: Uuid,
        project_id: Uuid,
    ) -> Result<SummaryMaterial, MaterialsStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(MaterialsStoreError::NoProject)?;
        if session.manifest.project_id != project_id {
            return Err(MaterialsStoreError::InvalidTarget);
        }
        session
            .database
            .get_summary_material(project_id, id)?
            .ok_or(MaterialsStoreError::InvalidTarget)
    }

    pub fn get_writing_card(
        &self,
        id: Uuid,
        project_id: Uuid,
    ) -> Result<WritingCard, MaterialsStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(MaterialsStoreError::NoProject)?;
        if session.manifest.project_id != project_id {
            return Err(MaterialsStoreError::InvalidTarget);
        }
        session
            .database
            .get_writing_card(project_id, id)?
            .ok_or(MaterialsStoreError::InvalidTarget)
    }

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
        let result = session
            .database
            .upsert_summary_material(session.manifest.project_id, material)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(result)
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
        let result = session
            .database
            .upsert_writing_card(session.manifest.project_id, card)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(result)
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
        let result =
            session
                .database
                .set_writing_card_enabled(session.manifest.project_id, id, enabled)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(result)
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
        let result = session.database.set_summary_material_lifecycle(
            session.manifest.project_id,
            id,
            lifecycle_status,
        )?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(result)
    }

    pub fn rebuild_summary_material(
        &mut self,
        id: Uuid,
    ) -> Result<SummaryMaterial, MaterialsStoreError> {
        let session = self
            .current
            .as_mut()
            .ok_or(MaterialsStoreError::NoProject)?;
        let result = session
            .database
            .rebuild_summary_material(session.manifest.project_id, id)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(result)
    }
}

impl Database {
    fn get_summary_material(
        &self,
        project_id: Uuid,
        id: Uuid,
    ) -> Result<Option<SummaryMaterial>, DatabaseError> {
        self.connection.query_row(
            "SELECT id, project_id, kind, precision, source_id, source_version, content, generation_mode, lifecycle_status, created_at, updated_at FROM summary_materials WHERE project_id = ?1 AND id = ?2",
            rusqlite::params![project_id.to_string(), id.to_string()],
            summary_from_row,
        ).optional().map_err(Into::into)
    }

    fn get_writing_card(
        &self,
        project_id: Uuid,
        id: Uuid,
    ) -> Result<Option<WritingCard>, DatabaseError> {
        self.connection.query_row(
            "SELECT id, project_id, card_type, title, content, source_version, scope, enabled, sort_order, created_at, updated_at FROM writing_cards WHERE project_id = ?1 AND id = ?2",
            rusqlite::params![project_id.to_string(), id.to_string()],
            card_from_row,
        ).optional().map_err(Into::into)
    }

    fn list_summary_materials(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<SummaryMaterial>, DatabaseError> {
        let mut stmt = self.connection.prepare("SELECT id, project_id, kind, precision, source_id, source_version, content, generation_mode, lifecycle_status, created_at, updated_at FROM summary_materials WHERE project_id = ?1 ORDER BY kind, precision")?;
        let rows = stmt.query_map([project_id.to_string()], summary_from_row)?;
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
            card_from_row,
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

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SummaryMaterial> {
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
}

fn card_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WritingCard> {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        manager: ProjectManager,
        root: PathBuf,
        project_id: Uuid,
        summary_id: Uuid,
        card_id: Uuid,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                PathBuf::from("target").join(format!("material-navigation-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager
                .create(&root, "Material navigation")
                .unwrap()
                .project_id;
            let summary_id = Uuid::new_v4();
            let card_id = Uuid::new_v4();
            manager
                .upsert_summary_material(SummaryMaterial {
                    id: summary_id,
                    project_id,
                    kind: SummaryKind::Chapter,
                    precision: SummaryPrecision::L0,
                    source_id: None,
                    source_version: Some("author:reference".into()),
                    content: "Original memory".into(),
                    generation_mode: "MANUAL_REFERENCE".into(),
                    lifecycle_status: "ACTIVE".into(),
                    created_at: String::new(),
                    updated_at: String::new(),
                })
                .unwrap();
            manager
                .upsert_writing_card(WritingCard {
                    id: card_id,
                    project_id,
                    card_type: "STYLE_RULE".into(),
                    title: "Short sentences".into(),
                    content: "Original card".into(),
                    source_version: None,
                    scope: "PROJECT".into(),
                    enabled: true,
                    sort_order: 0,
                    created_at: String::new(),
                    updated_at: String::new(),
                })
                .unwrap();
            Self {
                manager,
                root,
                project_id,
                summary_id,
                card_id,
            }
        }

        fn db(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.close();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn exact_material_reads_show_current_content_without_writing_or_changing_status() {
        let mut f = Fixture::new();
        let mut card = f.manager.get_writing_card(f.card_id, f.project_id).unwrap();
        card.content = "Updated card".into();
        f.manager.upsert_writing_card(card).unwrap();
        f.manager
            .set_writing_card_enabled(f.card_id, false)
            .unwrap();
        f.manager
            .set_summary_material_lifecycle(f.summary_id, "STALE".into())
            .unwrap();
        let changes = f.db().connection.total_changes();
        let summary = f
            .manager
            .get_summary_material(f.summary_id, f.project_id)
            .unwrap();
        let card = f.manager.get_writing_card(f.card_id, f.project_id).unwrap();
        assert_eq!(summary.content, "Original memory");
        assert_eq!(summary.lifecycle_status, "STALE");
        assert_eq!(card.content, "Updated card");
        assert!(!card.enabled);
        assert_eq!(card.id, f.card_id);
        assert_eq!(summary.id, f.summary_id);
        assert_eq!(f.db().connection.total_changes(), changes);
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(
            f.manager
                .get_writing_card(f.card_id, f.project_id)
                .unwrap()
                .content,
            "Updated card"
        );
        assert_eq!(
            f.manager
                .get_summary_material(f.summary_id, f.project_id)
                .unwrap()
                .lifecycle_status,
            "STALE"
        );
    }

    #[test]
    fn exact_material_reads_reject_wrong_project_missing_id_and_wrong_object_kind() {
        let f = Fixture::new();
        let changes = f.db().connection.total_changes();
        for (id, project_id) in [
            (Uuid::new_v4(), f.project_id),
            (f.summary_id, Uuid::new_v4()),
            (f.card_id, f.project_id),
        ] {
            assert!(matches!(
                f.manager.get_summary_material(id, project_id),
                Err(MaterialsStoreError::InvalidTarget)
            ));
        }
        for (id, project_id) in [
            (Uuid::new_v4(), f.project_id),
            (f.card_id, Uuid::new_v4()),
            (f.summary_id, f.project_id),
        ] {
            assert!(matches!(
                f.manager.get_writing_card(id, project_id),
                Err(MaterialsStoreError::InvalidTarget)
            ));
        }
        assert_eq!(f.db().connection.total_changes(), changes);
        assert!(matches!(
            ProjectManager::new().get_summary_material(f.summary_id, f.project_id),
            Err(MaterialsStoreError::NoProject)
        ));
        assert!(matches!(
            ProjectManager::new().get_writing_card(f.card_id, f.project_id),
            Err(MaterialsStoreError::NoProject)
        ));
    }

    #[test]
    fn exact_material_queries_filter_stored_project_ownership() {
        let f = Fixture::new();
        let foreign = Uuid::new_v4();
        for (table, id) in [
            ("summary_materials", f.summary_id),
            ("writing_cards", f.card_id),
        ] {
            f.db()
                .connection
                .execute(
                    &format!("UPDATE {table} SET project_id=?1 WHERE id=?2"),
                    rusqlite::params![foreign.to_string(), id.to_string()],
                )
                .unwrap();
        }
        let changes = f.db().connection.total_changes();
        assert!(matches!(
            f.manager.get_summary_material(f.summary_id, f.project_id),
            Err(MaterialsStoreError::InvalidTarget)
        ));
        assert!(matches!(
            f.manager.get_writing_card(f.card_id, f.project_id),
            Err(MaterialsStoreError::InvalidTarget)
        ));
        assert_eq!(f.db().connection.total_changes(), changes);
    }
}
