# IPC 类型契约

## 单一来源

- 字段和枚举以 Rust 实际 Serde DTO 为准，相关类型派生 `schemars::JsonSchema`，不维护第二份字段清单。
- `apps/desktop/src-tauri/ipc_build.rs` 使用 `syn` 读取实际 `#[tauri::command]` 签名和 `generate_handler!` 登记。未登记命令、漏生成命令或重复名称会令生成器编译失败。
- Tauri 注入的 `tauri::State`、`AppHandle`、`Window`、`WebviewWindow` 不属于 IPC 请求；其他参数按命令实际字段命名生成请求对象。
- 实际 `emit` 调用中的字符串事件名和显式 struct 负载一起收集；事件结构变化会进入同一份契约。当前为 139 个命令、3 个事件。
- `ipc-contract` 功能只在生成与验证时启用，`ipc-schema` 二进制只输出 schema，不启动 Tauri 窗口、项目库或模型调用。

## 生成链路

1. Rust schema 生成器分别使用 Schemars 的 Deserialize 与 Serialize contract，导出请求、响应、错误和事件 schema。
2. `tools/generate-ipc-types.mjs` 将请求定义加 `Input` 前缀，保留独立的请求与响应字段形状，再使用 `json-schema-to-typescript` 转换。
3. TypeScript AST 将输出规范为客户端既有的结构类型别名；确定性产物保存在 `apps/desktop/src/lib/ipc-types.generated.ts`。
4. `ipc-transport.ts` 按命令名推导请求与返回类型，按事件名推导监听负载。普通客户端不能自行指定 `invoke<T>` 的返回 DTO。

版本固定为 `schemars 1.2.2` 和 `json-schema-to-typescript 15.0.4`，两份依赖锁文件应一起保留。
Rust schema trait 是编译依赖；JavaScript 转换器是开发依赖。它们不新增日常写作的运行步骤。

```powershell
pnpm generate:ipc
pnpm check:ipc
pnpm check
pnpm test
pnpm build
```

- `generate:ipc` 显式更新生成文件，更新后应审核差异。
- `check:ipc` 在内存中重新生成并逐字比较，缺少文件或已有文件漂移都会失败，不自动改写产物；同时运行工具测试及登记/调用/传输入口检查。
- `.gitattributes` 仅为生成的 TS 文件固定 `eol=lf`，避免 Windows 的自动 CRLF 检出触发假漂移；不放宽逐字比较。
- 根 `check`、`test`、`build` 均先检查漂移；类型检查覆盖 `ipc-contract.typecheck.ts` 中的正例及预期编译失败反例。
- Rust 全量测试及 Clippy 需要 `--features ainoveltools-desktop/ipc-contract` 才包含契约模块；根脚本已传入该参数。

## 两个方向

- 输入 `Option` 可以省略或为 `null`；有 Serde default 的非 Option 字段可以省略，但不能因此冒充可接受 `null`。
- 没有跳过序列化的输出 `Option` 是必填且 nullable。规划版本、CAS、项目和章节范围不因为前端表单便利而变成可选。
- `flatten` 使用实际扁平字段；Rust 数组 `[&str; 3]` 生成三元素字符串 tuple，不伪造固定字符串值。
- Rust 的普通 `String`、`&str` 不擅自收窄成 UI 字面量 union。UUID、整数范围等 schema 约束仍由后端处理，不把 TS 类型当成运行时校验器。
- `serde_json::Value` 保留为 `unknown`。提取面板在读取对象字段前显式确认非空对象且非数组；采用和保存继续使用既有后端内容验证。
- `AiTaskPreference` 有手写 Serde 适配。其 schema 明确复用真实的旧 UUID/null/详细输入 DTO 与规范化输出 DTO，并通过实际序列化回归核对；不把旧输入格式套在响应上。
- 没有 `Result` 的命令错误契约为 `null`；String 错误与 `ApiError` 分开生成。调用失败仍原样拒绝 Promise，捕获值继续作为 `unknown` 处理。

## 前端适配

- `tauri-client.ts` 保留现有业务包装器及导出入口；请求别名从 `IpcRequests` 派生，响应从生成文件导出，不重复手写 DTO 字段。
- `PlanningSection` 是明确的 UI 表单适配：未保存表单可没有版本；实际列表和保存回执推导为必填版本的 `VersionedPlanningSection`。
- `AssembleContextInput` 的 UI 资料选择单独传为 `objectIds`，不混入 Rust 上下文 DTO。
- 历史任务展示保留旧字符串 `sourceName` 的只读适配；新 IPC 仍使用 Rust 的可选字符串数组。
- 包装器可以保持业务限制，例如只允许延期/拒绝的决策，以及只提交完整的偏好表单；底层契约仍完整生成。

## 修改契约

1. 修改实际 Rust DTO 或命令签名，保留原 Serde 和业务校验规则；新 DTO 必须实现 `JsonSchema`。
2. 运行 `pnpm generate:ipc`，审核输入/输出、枚举、nullable/default、范围和版本字段的差异。
3. 修正调用方及明确的 UI 适配，不用断言或 `any` 隐藏真实差异。
4. 运行类型检查、工具回归、启用契约功能的 Rust 测试与严格 Clippy；行为变更另外补运行时和浏览器验证。

当前收集器支持命令默认 camelCase 或显式 snake_case。其他命令属性、条件登记、动态事件名或不显式声明类型的事件负载会拒绝生成，需要先补收集器支持。
类型生成不解决运行时异常数据、跨请求幂等性、JavaScript 安全整数范围、真实桌面多窗口或真实模型验收；数据库仍为 schema 51。
