use super::*;

const CHUNK_CHARS: usize = 1200;
const SEMANTIC_KINDS: [&str; 7] = [
    "MANUSCRIPT",
    "PLAN",
    "ENTITY",
    "FACT",
    "RELATION",
    "CARD",
    "SUMMARY",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSemanticSettings {
    pub version: i64,
    pub profile_id: Option<Uuid>,
    pub fingerprint: String,
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSemanticStatus {
    pub settings: CoauthorSemanticSettings,
    pub total_chunks: usize,
    pub indexed_chunks: usize,
    pub pending_source_updates: usize,
}

#[derive(Debug, Clone)]
pub struct CoauthorSemanticChunk {
    pub source_key: String,
    pub revision: String,
    pub index: usize,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct CoauthorSemanticBatch {
    pub settings: CoauthorSemanticSettings,
    pub chunks: Vec<CoauthorSemanticChunk>,
}

/// Credentials and timeouts do not define a vector space; provider and endpoint do.
#[must_use]
pub fn coauthor_embedding_fingerprint(profile: &ModelProfile) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "coauthor-chunks-v1\n{}\n{:?}\n{}\n{}\n{:?}",
            profile.id,
            profile.provider,
            profile.base_url.trim_end_matches('/'),
            profile.model_id,
            profile.privacy_level
        ))
    )
}

fn valid_vector(vector: &[f32]) -> bool {
    !vector.is_empty()
        && vector.len() <= 8192
        && vector.iter().all(|n| n.is_finite())
        && vector.iter().map(|n| f64::from(*n).powi(2)).sum::<f64>() > 0.0
}

fn sql_size(value: usize) -> Result<i64, CoauthorError> {
    i64::try_from(value).map_err(|_| CoauthorError::Invalid("索引范围过大。".into()))
}

fn count(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<usize> {
    usize::try_from(row.get::<_, i64>(index)?).map_err(|_| rusqlite::Error::InvalidQuery)
}

impl Database {
    pub(crate) fn migrate_coauthor_semantic(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS coauthor_semantic_settings (
                id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
                profile_id TEXT, fingerprint TEXT NOT NULL, kinds_json TEXT NOT NULL CHECK(json_valid(kinds_json)));
             INSERT OR IGNORE INTO coauthor_semantic_settings VALUES(1,0,NULL,'','[]');
             CREATE TABLE IF NOT EXISTS coauthor_semantic_chunks (
                source_key TEXT NOT NULL REFERENCES coauthor_sources(source_key) ON DELETE CASCADE,
                revision TEXT NOT NULL, chunk_index INTEGER NOT NULL, start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL, text TEXT NOT NULL,
                PRIMARY KEY(source_key,chunk_index));
             CREATE TABLE IF NOT EXISTS coauthor_semantic_vectors (
                source_key TEXT NOT NULL, chunk_index INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                dimensions INTEGER NOT NULL, vector_json TEXT NOT NULL CHECK(json_valid(vector_json)),
                PRIMARY KEY(source_key,chunk_index,fingerprint),
                FOREIGN KEY(source_key,chunk_index) REFERENCES coauthor_semantic_chunks(source_key,chunk_index) ON DELETE CASCADE);
             CREATE INDEX IF NOT EXISTS coauthor_semantic_space ON coauthor_semantic_vectors(fingerprint,dimensions);
             INSERT OR IGNORE INTO coauthor_source_queue SELECT kind,substr(source_key,instr(source_key,':')+1)
                FROM coauthor_sources WHERE session_id IS NULL;
             INSERT INTO schema_migrations(version,name) VALUES(59,'coauthor_semantic_retrieval');"
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn index_coauthor_semantic_chunks(
        &self,
        source: &CoauthorSource,
    ) -> Result<(), CoauthorError> {
        if !SEMANTIC_KINDS.contains(&source.kind.as_str()) || source.session_id.is_some() {
            return Ok(());
        }
        let chars: Vec<char> = source.content.chars().collect();
        for (index, chunk) in chars.chunks(CHUNK_CHARS).enumerate() {
            self.connection.execute(
                "INSERT INTO coauthor_semantic_chunks VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    source.key,
                    source.revision,
                    sql_size(index)?,
                    sql_size(index * CHUNK_CHARS)?,
                    sql_size(index * CHUNK_CHARS + chunk.len())?,
                    format!(
                        "{}\n{}",
                        source.title.chars().take(160).collect::<String>(),
                        chunk.iter().collect::<String>()
                    )
                ],
            )?;
        }
        Ok(())
    }

    fn semantic_settings(&self) -> Result<CoauthorSemanticSettings, CoauthorError> {
        let (version,profile,fingerprint,kinds): (i64,Option<String>,String,String) = self.connection.query_row(
            "SELECT version,profile_id,fingerprint,kinds_json FROM coauthor_semantic_settings WHERE id=1",[],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
        Ok(CoauthorSemanticSettings {
            version,
            profile_id: profile
                .map(|id| id.parse().map_err(|_| CoauthorError::NotFound))
                .transpose()?,
            fingerprint,
            kinds: decode(kinds)?,
        })
    }

    fn semantic_counts(
        &self,
        settings: &CoauthorSemanticSettings,
    ) -> Result<(usize, usize), CoauthorError> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(EXISTS(SELECT 1 FROM coauthor_semantic_vectors v
                WHERE v.source_key=c.source_key AND v.chunk_index=c.chunk_index AND v.fingerprint=?1)),0)
             FROM coauthor_semantic_chunks c JOIN coauthor_sources s ON s.source_key=c.source_key
             WHERE s.kind IN (SELECT value FROM json_each(?2)) AND NOT EXISTS(
                SELECT 1 FROM coauthor_source_queue q WHERE q.kind || ':' || q.source_id=c.source_key)",
            rusqlite::params![settings.fingerprint,encode(&settings.kinds)?],|row|Ok((count(row,0)?,count(row,1)?)))?)
    }
}

impl ProjectManager {
    pub fn clear_coauthor_semantic_cache(
        &self,
        scope: &CoauthorScope,
        expected_version: i64,
    ) -> Result<CoauthorSemanticStatus, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let settings = db.semantic_settings()?;
        if settings.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        tx.execute("DELETE FROM coauthor_semantic_vectors", [])?;
        tx.execute("INSERT OR IGNORE INTO coauthor_source_queue
            SELECT kind,substr(source_key,instr(source_key,':')+1) FROM coauthor_sources WHERE session_id IS NULL",[])?;
        tx.execute(
            "UPDATE coauthor_semantic_settings SET version=version+1 WHERE id=1",
            [],
        )?;
        tx.commit()?;
        self.coauthor_semantic_status(scope)
    }

    pub fn coauthor_semantic_settings(
        &self,
        scope: &CoauthorScope,
    ) -> Result<CoauthorSemanticSettings, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database
            .semantic_settings()
    }

    pub fn coauthor_semantic_status(
        &self,
        scope: &CoauthorScope,
    ) -> Result<CoauthorSemanticStatus, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let settings = db.semantic_settings()?;
        let (total_chunks, indexed_chunks) = db.semantic_counts(&settings)?;
        Ok(CoauthorSemanticStatus {
            settings,
            total_chunks,
            indexed_chunks,
            pending_source_updates: db.coauthor_pending_updates()?,
        })
    }

    pub fn save_coauthor_semantic_settings(
        &self,
        scope: &CoauthorScope,
        expected_version: i64,
        profile: Option<&ModelProfile>,
        mut kinds: Vec<String>,
    ) -> Result<CoauthorSemanticStatus, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        kinds.sort();
        kinds.dedup();
        if kinds
            .iter()
            .any(|kind| !SEMANTIC_KINDS.contains(&kind.as_str()))
            || (profile.is_some() && kinds.is_empty())
        {
            return Err(CoauthorError::Invalid(
                "请选择支持的项目资料类别，讨论历史与工作稿不在向量授权范围。".into(),
            ));
        }
        if profile.is_some_and(|p| {
            p.capability != ModelCapability::Embedding
                || p.privacy_level != PrivacyLevel::AllowCloud
        }) {
            return Err(CoauthorError::Invalid(
                "需要明确允许外发的向量模型。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let changed=db.connection.execute(
            "UPDATE coauthor_semantic_settings SET version=version+1,profile_id=?1,fingerprint=?2,kinds_json=?3
             WHERE id=1 AND version=?4",
            rusqlite::params![profile.map(|p|p.id.to_string()),profile.map(coauthor_embedding_fingerprint).unwrap_or_default(),
                encode(&kinds)?,expected_version])?;
        if changed != 1 {
            return Err(CoauthorError::Conflict);
        }
        self.coauthor_semantic_status(scope)
    }

    pub fn prepare_coauthor_semantic_batch(
        &self,
        scope: &CoauthorScope,
    ) -> Result<CoauthorSemanticBatch, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let settings = db.semantic_settings()?;
        if settings.profile_id.is_none() {
            return Err(CoauthorError::Invalid("本项目尚未授权语义检索。".into()));
        }
        db.sync_coauthor_sources()?;
        let mut statement=db.connection.prepare(
            "SELECT c.source_key,c.revision,c.chunk_index,c.text FROM coauthor_semantic_chunks c
             JOIN coauthor_sources s ON s.source_key=c.source_key
             WHERE s.kind IN (SELECT value FROM json_each(?1)) AND NOT EXISTS(
                SELECT 1 FROM coauthor_semantic_vectors v WHERE v.source_key=c.source_key
                  AND v.chunk_index=c.chunk_index AND v.fingerprint=?2)
             AND NOT EXISTS(SELECT 1 FROM coauthor_source_queue q WHERE q.kind || ':' || q.source_id=c.source_key)
             AND (s.kind NOT IN ('FACT','RELATION')
                OR (s.kind='FACT' AND EXISTS(SELECT 1 FROM facts f WHERE f.knowledge_id=substr(s.source_key,6) AND f.project_id=?3))
                OR (s.kind='RELATION' AND EXISTS(SELECT 1 FROM relations r WHERE r.id=substr(s.source_key,10) AND r.project_id=?3)))
             ORDER BY c.source_key,c.chunk_index LIMIT 8")?;
        let candidates = statement
            .query_map(
                rusqlite::params![
                    encode(&settings.kinds)?,
                    settings.fingerprint,
                    scope.project_id.to_string()
                ],
                |row| {
                    Ok(CoauthorSemanticChunk {
                        source_key: row.get(0)?,
                        revision: row.get(1)?,
                        index: count(row, 2)?,
                        text: row.get(3)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let mut chunks = Vec::new();
        // Recheck dynamic fact evidence and foreign ownership before any text can leave.
        for chunk in candidates {
            match self.read_coauthor_source(scope, &chunk.source_key, &chunk.revision, 0, 1) {
                Ok(_) => chunks.push(chunk),
                Err(CoauthorError::Conflict | CoauthorError::NotFound) => {
                    let (kind, id) = chunk
                        .source_key
                        .split_once(':')
                        .ok_or(CoauthorError::NotFound)?;
                    db.connection.execute(
                        "INSERT OR IGNORE INTO coauthor_source_queue VALUES(?1,?2)",
                        rusqlite::params![kind, id],
                    )?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(CoauthorSemanticBatch { settings, chunks })
    }

    pub fn commit_coauthor_semantic_batch(
        &self,
        scope: &CoauthorScope,
        batch: &CoauthorSemanticBatch,
        vectors: &[Vec<f32>],
    ) -> Result<CoauthorSemanticStatus, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        if db.semantic_settings()? != batch.settings {
            return Err(CoauthorError::Conflict);
        }
        let dimensions = vectors.first().map_or(0, Vec::len);
        if vectors.len() != batch.chunks.len()
            || vectors
                .iter()
                .any(|v| !valid_vector(v) || v.len() != dimensions)
        {
            return Err(CoauthorError::Invalid(
                "向量响应缺失、维度不一致或数值无效，未保存本批。".into(),
            ));
        }
        let existing: Option<usize> = tx
            .query_row(
                "SELECT dimensions FROM coauthor_semantic_vectors WHERE fingerprint=?1 LIMIT 1",
                [&batch.settings.fingerprint],
                |row| count(row, 0),
            )
            .optional()?;
        if !vectors.is_empty() && existing.is_some_and(|d| d != dimensions) {
            return Err(CoauthorError::Invalid(
                "同一模型配置的向量维度已变化，请更换配置后重建。".into(),
            ));
        }
        for (chunk, vector) in batch.chunks.iter().zip(vectors) {
            self.read_coauthor_source(scope, &chunk.source_key, &chunk.revision, 0, 1)?;
            let matches:bool=tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM coauthor_semantic_chunks WHERE source_key=?1 AND revision=?2 AND chunk_index=?3 AND text=?4)",
                rusqlite::params![chunk.source_key,chunk.revision,sql_size(chunk.index)?,chunk.text],|row|row.get(0))?;
            if !matches {
                return Err(CoauthorError::Conflict);
            }
            tx.execute("INSERT INTO coauthor_semantic_vectors VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(source_key,chunk_index,fingerprint) DO UPDATE SET dimensions=excluded.dimensions,vector_json=excluded.vector_json",
                rusqlite::params![chunk.source_key,sql_size(chunk.index)?,batch.settings.fingerprint,sql_size(dimensions)?,encode(vector)?])?;
        }
        tx.commit()?;
        self.coauthor_semantic_status(scope)
    }

    pub fn search_coauthor_semantic_vector(
        &self,
        scope: &CoauthorScope,
        settings: &CoauthorSemanticSettings,
        query: &[f32],
        offset: u32,
    ) -> Result<CoauthorSearchPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        if settings.profile_id.is_none() || db.semantic_settings()? != *settings {
            return Err(CoauthorError::Conflict);
        }
        if !valid_vector(query) {
            return Err(CoauthorError::Invalid("查询向量无效。".into()));
        }
        let dimensions: Option<usize> = db
            .connection
            .query_row(
                "SELECT dimensions FROM coauthor_semantic_vectors WHERE fingerprint=?1 LIMIT 1",
                [&settings.fingerprint],
                |row| count(row, 0),
            )
            .optional()?;
        if dimensions.is_some_and(|size| size != query.len()) {
            return Err(CoauthorError::Invalid(
                "查询与已存向量维度不一致，未返回虚假的空结果。".into(),
            ));
        }
        let mut stmt=db.connection.prepare(
            "SELECT c.source_key,c.revision,c.start_offset,c.end_offset,v.vector_json
             FROM coauthor_semantic_vectors v JOIN coauthor_semantic_chunks c
               ON c.source_key=v.source_key AND c.chunk_index=v.chunk_index
             JOIN coauthor_sources s ON s.source_key=c.source_key
             WHERE v.fingerprint=?1 AND v.dimensions=?2 AND s.kind IN (SELECT value FROM json_each(?3))
             AND NOT EXISTS(SELECT 1 FROM coauthor_source_queue q WHERE q.kind || ':' || q.source_id=c.source_key)")?;
        let rows = stmt.query_map(
            rusqlite::params![
                settings.fingerprint,
                sql_size(query.len())?,
                encode(&settings.kinds)?
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    count(row, 2)?,
                    count(row, 3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?;
        let norm = query
            .iter()
            .map(|n| f64::from(*n).powi(2))
            .sum::<f64>()
            .sqrt();
        let mut ranked = std::collections::BTreeMap::<String, (f64, String, usize, usize)>::new();
        for row in rows {
            let (key, revision, start, end, json) = row?;
            let vector: Vec<f32> = decode(json)?;
            if !valid_vector(&vector) || vector.len() != query.len() {
                return Err(CoauthorError::Invalid("已存向量损坏，请重建索引。".into()));
            }
            let similarity = vector
                .iter()
                .zip(query)
                .map(|(a, b)| f64::from(*a) * f64::from(*b))
                .sum::<f64>()
                / (norm
                    * vector
                        .iter()
                        .map(|n| f64::from(*n).powi(2))
                        .sum::<f64>()
                        .sqrt());
            if similarity <= 0.0 {
                continue;
            }
            if ranked.get(&key).is_none_or(|entry| similarity > entry.0) {
                ranked.insert(key, (similarity, revision, start, end));
            }
        }
        let mut ranked: Vec<_> = ranked.into_iter().collect();
        ranked.sort_by(|a, b| b.1.0.total_cmp(&a.1.0).then(a.0.cmp(&b.0)));
        let mut hits = Vec::new();
        let mut skipped = 0;
        // Validate before paging so stale sources cannot consume the visible page.
        let mut live = 0;
        let mut has_more = false;
        for (key, (_, revision, start, end)) in ranked {
            if end <= start || end - start > CHUNK_CHARS {
                return Err(CoauthorError::Invalid(
                    "向量分块范围损坏，请清除缓存后重建。".into(),
                ));
            }
            match self.read_coauthor_source(scope, &key, &revision, start, end - start) {
                Ok(source) => {
                    if live >= offset as usize {
                        if hits.len() == 12 {
                            has_more = true;
                            break;
                        }
                        hits.push(source);
                    }
                    live += 1;
                }
                Err(CoauthorError::Conflict | CoauthorError::NotFound) => {
                    skipped += 1;
                    let (kind, id) = key.split_once(':').ok_or(CoauthorError::NotFound)?;
                    db.connection.execute(
                        "INSERT OR IGNORE INTO coauthor_source_queue VALUES(?1,?2)",
                        rusqlite::params![kind, id],
                    )?;
                }
                Err(error) => return Err(error),
            }
        }
        let (total, indexed) = db.semantic_counts(settings)?;
        Ok(CoauthorSearchPage {
            hits,
            has_more,
            pending_index_updates: db.coauthor_pending_updates()?,
            coverage: format!(
                "语义相似候选，不是事实判定或全书查证；当前类别已有 {indexed}/{total} 个分块向量，本页跳过 {skipped} 项过期来源。仅返回每份来源最相似的一块，须精读上下文与例外。"
            ),
        })
    }
}

#[cfg(test)]
mod tests;
