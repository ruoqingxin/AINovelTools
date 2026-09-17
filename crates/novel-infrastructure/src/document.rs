use super::*;

pub(crate) fn now_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    seconds.to_string()
}

pub(crate) fn normalize_document(document_json: &str) -> Result<String, ManuscriptError> {
    let mut value: serde_json::Value = serde_json::from_str(document_json)
        .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
        return Err(ManuscriptError::InvalidDocument(
            "root type must be doc".to_owned(),
        ));
    }
    let mut counter = 0_u64;
    fn visit(node: &mut serde_json::Value, counter: &mut u64) {
        if let Some(object) = node.as_object_mut() {
            if object.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
                let attrs = object
                    .entry("attrs")
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(attrs) = attrs.as_object_mut() {
                    attrs.entry("blockId").or_insert_with(|| {
                        *counter += 1;
                        serde_json::Value::String(format!("block-{counter}"))
                    });
                }
            }
            if let Some(children) = object
                .get_mut("content")
                .and_then(serde_json::Value::as_array_mut)
            {
                for child in children {
                    visit(child, counter);
                }
            }
        }
    }
    visit(&mut value, &mut counter);
    serde_json::to_string(&value)
        .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))
}

pub(crate) fn validate_document(document_json: &str) -> Result<(), ManuscriptError> {
    let _ = normalize_document(document_json)?;
    Ok(())
}

pub(crate) fn merge_documents(
    base: &str,
    current: &str,
    draft: &str,
) -> Result<MergeResult, ManuscriptError> {
    let mut base_v: serde_json::Value =
        serde_json::from_str(base).map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?;
    let current_v: serde_json::Value = serde_json::from_str(current)
        .map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?;
    let draft_v: serde_json::Value =
        serde_json::from_str(draft).map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?;
    let b = base_v
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let c = current_v
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let d = draft_v
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let key = |v: &serde_json::Value| {
        v.get("attrs")
            .and_then(|a| a.get("blockId"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_owned()
    };
    let mut conflicts = Vec::new();
    let mut merged = Vec::new();
    for block in d.iter().chain(c.iter()) {
        let id = key(block);
        if merged.iter().any(|x: &serde_json::Value| key(x) == id) {
            continue;
        }
        let bv = b.iter().find(|x| key(x) == id);
        let cv = c.iter().find(|x| key(x) == id);
        let dv = d.iter().find(|x| key(x) == id);
        if cv == bv {
            if let Some(x) = dv {
                merged.push(x.clone());
            }
        } else if dv == bv {
            if let Some(x) = cv {
                merged.push(x.clone());
            }
        } else if cv == dv {
            if let Some(x) = cv {
                merged.push(x.clone());
            }
        } else {
            conflicts.push(MergeConflict {
                block_id: id,
                base: bv.map(ToString::to_string),
                current: cv.map(ToString::to_string),
                draft: dv.map(ToString::to_string),
            });
            if let Some(x) = cv {
                merged.push(x.clone());
            }
        }
    }
    if let Some(obj) = base_v.as_object_mut() {
        obj.insert("content".to_owned(), serde_json::Value::Array(merged));
    }
    Ok(MergeResult {
        document_json: serde_json::to_string(&base_v)
            .map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?,
        conflicts,
    })
}
