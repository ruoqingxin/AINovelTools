# R6 Migration 清单

## 当前状态

- 基线 schema version：35
- R6 启动时基线为 26；27-35 已在 AI 规划与优化切片中实施并通过空库、已有项目和约束测试。

R6 仍采用按需迁移策略。当前没有新的高级能力迁移被批准；新增迁移必须在进入实现前完成触发证据、ADR 和验收设计。

## 已实施迁移

| 版本 | 名称 | 内容 | 依赖 | 回滚/重建策略 |
|---|---|---|---|---|
| 27 | `planning_sections` | 规划工作台结构化正文 | 10 | 备份恢复；无外部服务依赖 |
| 28 | `planning_sections_pending_content` | 规划候选暂存与确认 | 27 | 备份恢复 |
| 29 | `ai_planning_jobs_and_events` | 规划 AI 任务、请求快照和阶段事件 | 27 | 备份恢复；历史任务保留 |
| 30 | `planning_embeddings` | 规划语义检索向量投影 | 27 | 可删除重建 |
| 31 | `planning_chunk_embeddings` | 规划分块向量投影 | 30 | 可删除重建 |
| 32 | `ai_run_attempt_tracking` | 运行次数、回退原因和备用模型 | 29 | 备份恢复 |
| 33 | `ai_proposal_quality_feedback` | 正文候选质量反馈 | 7 | 备份恢复 |
| 34 | `ai_usage_stats_and_project_overrides` | 用量字段与项目任务覆盖 | 32 | 备份恢复 |
| 35 | `unified_ai_runs_and_model_pricing` | 统一运行记录和模型费用快照 | 34 | 备份恢复；历史正文任务回填 |

## 新增迁移的登记要求

每项获批持久化能力必须在本文件新增一行，包含：

| 版本 | 名称 | 内容 | 依赖 | 回滚/重建策略 |
|---|---|---|---|---|

迁移编号从 36 开始，且必须同步更新运行时 schema 常量、空库迁移、已有项目迁移和失败回滚测试。
