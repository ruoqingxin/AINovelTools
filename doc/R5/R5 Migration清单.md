# R5 Migration 清单

## 计划

| 版本 | 名称 | 内容 | 依赖 |
|---|---|---|---|
| 16 | `r5_knowledge_candidates` | 候选 Fact、Proposal 关联和审核状态 | 15 |
| 17 | `r5_evidence_anchors` | 章节/修订/block/字符范围/来源版本锚点 | 16 |
| 18 | `r5_facts` | Fact 正式版本、生命周期和当前版本指针 | 17 |
| 19 | `r5_change_sets_audit_outbox` | 单章节 ChangeSet、ChangeItem、审核决定、审计和 Outbox | 18 |

R4 版本 15 已补齐为可靠性契约的 schema ledger 收尾标记；R5 从 16 开始。每个迁移必须支持空库、已有项目和失败回滚演练。

## 统一字段

正式 Fact 版本表必须具备：`project_id`、`knowledge_id`、`knowledge_version`、`source_revision_id`、`evidence_anchor_ids`、`lifecycle_status`、`created_by`、`created_at`、`updated_at`。`knowledge_version` 是版本字段，不等同于后续的 `KnowledgeVersion` 状态投影。

候选表额外具备：`proposal_id`、`candidate_status`、`review_decision`、`reviewer`、`reviewed_at`。

## 约束与索引

- `knowledge_id + knowledge_version` 唯一；正式版本只插入不更新。
- EvidenceAnchor 的来源章节、修订和 block 必须可校验；来源归档后不得自动批准。
- 所有 JSON 字段使用 `json_valid` 检查，并在应用层执行版本化 Schema 校验。
- 按 `project_id`、章节、生命周期和审核状态建立查询索引。
- 定稿相关表使用外键和事务，任何一步失败均回滚。
- 审计记录与 Outbox 事件和定稿业务变更同事务；失败时两者都不得落库或发送成功事件。
