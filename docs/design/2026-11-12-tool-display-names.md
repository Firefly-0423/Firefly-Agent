状态：设计提案（现状整理）
实现状态：已实现

# Firefly 工具展示名与回退

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
界面显示可读工具名，同时保留稳定机器 ID 用于调用、权限和定位。

## 当前实现
| 链路 | 文件与字段 |
|---|---|
| 注册 | `src/main/tooling/registry/tool-registry.ts` 的 `ToolDefinition.id` 是机器 ID，name 是展示名；`src/main/agent/mcp/mcp-adapter.ts` 生成服务工具展示名。 |
| 运行事件 | `src/main/agent/loop/tool-dispatcher.ts` 发出 toolName 和 displayName；`src/main/agent/runtime/adapter/event-mapper.ts` 传递 toolCallName 和 toolCallDisplayName。 |
| 执行记录 | `src/shared/chat-types.ts` 的 `ToolExecutionRecord` 同时保留 name 与可选 displayName；`src/renderer/react/features/chat/pages/run/AgentRunController.ts` 保存及显示。 |
| 定时任务 | `src/renderer/react/features/chat/hooks/useSchedulerEvents.ts` 保留展示名，并在兜底摘要中优先使用。 |
| 卡片回退 | `src/renderer/react/features/chat/components/agent-rounds.ts` 的 `describeToolExecution` 与 `translatedToolName` 处理名称和状态。 |

## 行为与失败边界
指定内置控制工具先用当前语言标签，再用保存的 displayName；其他工具优先显式展示名，再尝试已知 i18n 标签，未知工具保留原 ID。ask_user 和 Shell 超时另有状态文案。

展示名只作为文本，不参与鉴权、路由或逻辑调用身份；缺字段的历史记录安全回退。第三方名称不保证中文，除指定内置项外，切换语言也不保证历史展示名重译。工具是否可执行仍由模式、工作区和 Main 权限决定。

## 未完成与维护
自动翻译所有工具、统一所有入口状态句式没有实现承诺；本次未验收真实服务、持久化重开及语言切换界面。新工具沿用当前定义→事件→记录→展示链，不另建前端注册表。

现有测试：`src/renderer/react/features/chat/components/agent-rounds.test.ts`、`src/renderer/react/features/chat/hooks/useSchedulerEvents.test.ts`、`src/main/agent/runtime/adapter/event-mapper.test.ts`。本次未执行；没有新施工计划。
