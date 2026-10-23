use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorDecisionDependencyInput {
    pub item_ids: Vec<String>,
    pub decision_id: Uuid,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionDependency {
    pub item_ids: Vec<String>,
    pub decision: CoauthorDecision,
    pub current: Option<CoauthorDecision>,
}

impl Database {
    pub(super) fn prepare_coauthor_decision_dependencies(
        &self, scope: &CoauthorScope, items: &[CoauthorChangeItem], inputs: &[CoauthorDecisionDependencyInput],
    ) -> Result<Vec<CoauthorDecisionDependency>, CoauthorError> {
        if inputs.len()>32 {
            return Err(CoauthorError::Invalid("一组最多声明32条决定依赖，请按可独立核对的范围拆分。".into()));
        }
        let mut identities=BTreeSet::new();
        inputs.iter().map(|input| {
            if !identities.insert(input.decision_id) || input.item_ids.is_empty()
                || input.item_ids.len()>items.len()
                || input.item_ids.iter().collect::<BTreeSet<_>>().len()!=input.item_ids.len()
                || input.item_ids.iter().any(|id| !items.iter().any(|item| &item.id==id))
            {
                return Err(CoauthorError::Invalid("决定依赖须指向本组准确变更项；同一决定只声明一次。".into()));
            }
            let decision=self.decision(scope.session_id,input.decision_id)?;
            if decision.version!=input.version { return Err(CoauthorError::Conflict); }
            Ok(CoauthorDecisionDependency {
                item_ids:input.item_ids.clone(),current:Some(decision.clone()),decision,
            })
        }).collect()
    }

    pub(super) fn refresh_coauthor_decision_dependencies(
        &self, scope: &CoauthorScope, changes: &mut CoauthorChangeSet,
    ) -> Result<(), CoauthorError> {
        for dependency in changes.decision_dependencies.iter_mut().flatten() {
            dependency.current=match self.decision(scope.session_id,dependency.decision.id) {
                Ok(decision)=>Some(decision),
                Err(CoauthorError::NotFound)=>None,
                Err(error)=>return Err(error),
            };
        }
        Ok(())
    }

    pub(super) fn validate_coauthor_decision_dependencies(
        &self, scope: &CoauthorScope, changes: &CoauthorChangeSet, selected: &BTreeSet<String>,
    ) -> Result<(), CoauthorError> {
        let dependencies=changes.decision_dependencies.as_ref().ok_or_else(||CoauthorError::Invalid(
            "此旧方案尚未记录决定依赖核对信息，请基于当前决定重新准备；原方案及历史保留。".into(),
        ))?;
        for dependency in dependencies.iter().filter(|entry|entry.item_ids.iter().any(|id|selected.contains(id))) {
            if self.decision(scope.session_id,dependency.decision.id)?!=dependency.decision {
                return Err(CoauthorError::Invalid(format!(
                    "所选变更依赖的讨论决定「{}」v{} 已变化，请重新核对并准备，尚未写入任何正式内容。",
                    dependency.decision.topic,dependency.decision.version,
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
