# R5 Migration 清单

## 计划

| 版本 | 名称 | 内容 | 依赖 |
|---|---|---|---|
| 16 | `r5_knowledge_candidates` | 候选 Fact、Proposal 关联和审核状态 | 15 |
| 17 | `r5_evidence_anchors` | 章节/修订/block/字符范围/来源版本锚点 | 16 |
| 18 | `r5_facts` | Fact 正式版本、生命周期和当前版本指针 | 17 |
| 19 | `r5_change_sets_audit_outbox` | 单章节 ChangeSet、ChangeItem、审核决定、审计和 Outbox | 18 |
| 20 | `r5_fact_current_pointer` | Fact 当前版本指针，不破坏历史版本追加 | 18 |
| 21 | `r5_knowledge_versions` | 正式 Fact 引用集合的可审计版本 | 20 |
| 22 | `r5_world_state_projection` | 从正式 Fact 重建的 WorldState 投影 | 21 |
| 23 | `r5_relations` | 关系知识的不可变版本 | 18/22 |
| 24 | `r5_events` | 事件及参与事实引用的不可变版本 | 18/22 |
| 25 | `r5_beliefs` | 持有者与命题的信念知识版本 | 18/22 |
| 26 | `r5_foreshadowings` | 伏笔状态和目标章节的不可变版本 | 18/22 |

R4 版本 15 已补齐为可靠性契约的 schema ledger 收尾标记；R5 从 16 开始，R5 首批知识治理在版本 26 完成自动化验收。

版本 27-40 是 R5 关闭后用于规划设定、AI 规划任务、运行审计、费用治理、任务失败确认和 R5.1 渐进式共创体验的增量迁移：

| 版本 | 名称 | 说明 |
|---|---|---|
| 27 | `planning_sections` | 规划设定内容与来源 |
| 28 | `planning_sections_pending_content` | AI 候选待定区 |
| 29 | `ai_planning_jobs_and_events` | 规划 AI 后台任务与事件 |
| 30 | `planning_embeddings` | 规划设定向量元数据 |
| 31 | `planning_chunk_embeddings` | 文件分块向量元数据 |
| 32 | `ai_run_attempt_tracking` | AI 调用尝试与回退记录 |
| 33 | `ai_proposal_quality_feedback` | Proposal 质量反馈 |
| 34 | `ai_usage_stats_and_project_overrides` | 用量统计和项目任务覆盖 |
| 35 | `unified_ai_runs_and_model_pricing` | 统一 AI 运行记录与价格快照 |
| 36 | `job_failure_acknowledgements` | 失败任务确认 |
| 37 | `planning_story_state` | 规划项显式状态和未知语义 |
| 38 | `chapter_extraction_candidates` | 正文提取候选、证据绑定和审核状态 |
| 39 | `project_discussion_sessions` | 作品级讨论会话、消息和候选 |
| 40 | `discussion_scene_and_selection_scopes` | 讨论场景范围与选区文本持久化 |

因此，运行时 `CURRENT_SCHEMA_VERSION` 为 40；后续 R5.1 或 R6 迁移不得继续沿用 26 或 36 作为当前基线。每个迁移必须支持空库、已有项目和失败回滚演练。R5.1 详细阶段边界见 `doc/R5.1/R5.1 Migration清单.md`。

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
