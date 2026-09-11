# AI 评测样本规范

## 目标

评测基线用于比较不同模型、提示词版本和上下文策略，不参与自动切换作者配置。固定样本必须先于向量、图谱、时间线等高级能力引入，避免用未经验证的复杂度替代真实需求。

## 文件格式

固定样本使用 JSONL，每行一个独立 JSON 对象，文件为 `crates/novel-application/fixtures/ai-eval-baseline.jsonl`。

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定且唯一的样本编号 |
| `taskKey` | `workDesign`、`outline`、`volumePlanning`、`chapterSplit`、`writing` 或 `knowledgeExtraction` |
| `purpose` | 该样本要验证的行为边界 |
| `input.instruction` | 脱敏后的任务要求 |
| `input.context` | 脱敏后的最小必要上下文 |
| `expectedAll` | 候选输出必须覆盖的要点，全部命中才通过 |
| `forbiddenAny` | 候选输出不得出现的错误结论，命中任一项即失败 |
| `minCharacters` / `maxCharacters` | 输出长度边界，按 Unicode 字符数计算 |

## 隐私规则

- 只使用虚构或去标识化文本，不包含真实姓名、联系方式、项目路径、密钥、账号或未公开作品内容。
- 样本只保留评测所需的最小上下文，不携带完整文档、数据库快照或原始请求体。
- 新增样本必须先确认不含个人信息和商业秘密。

## 回归规则

- 六类任务每类至少保留一个固定样本。
- 评分只检查确定性合同：要点覆盖、禁止结论和长度边界。
- 固定样本不会自动修改提示词、模型路由或正式知识。
- 只有当固定样本和真实创作反馈共同证明关键词或结构化检索不足时，才评估向量混合检索等高级能力。
