状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 会话轨迹与模型上下文

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
区分权威会话记录、模型活动上下文和界面展示，避免从截断工具卡片重建历史，也避免把展示保存当作执行提交。

## 当前实现
| 责任 | 模块与入口 |
|---|---|
| 记录类型与存储 | `src/main/conversation/transcript/conversation-transcript-types.ts` 定义 `TranscriptEntry`；`src/main/conversation/transcript/conversation-transcript-store.ts` 的 `ConversationTranscriptStore` 串行追加、读取与 checkpoint。 |
| 用户修订 | `src/main/conversation/transcript/conversation-transcript-coordinator.ts` 协调回退，区分保留用户锚点与替换用户消息。 |
| 活动上下文 | `src/main/agent/loop/conversation-transcript-context.ts` 的 `materializeTranscript`、`buildModelContext` 物化活动分支并按工具配对裁剪。 |
| 写入能力 | `src/main/agent/loop/transcript-sink.ts` 为运行提供受控写入口；`src/main/agent/loop/agent-loop.ts` 先等待 assistant 声明提交，再执行工具。 |
| 上层入口 | `src/main/features/chat/agui-bridge.ts` 根据可信用户轮次和上下文来源准备轨迹；`src/main/agent/runtime/build-options.ts` 选择模型上下文。 |

## 行为与失败边界
物化时，已启动而未确认结果的工具可补为 unknown，未启动工具补为 not_executed；缺运行证据时的处理还受选项控制。回退保留审计事实，旧活动尾部不应继续成为当前输入。assistant 声明保存失败会阻断工具；结果提交失败不能当作工具未发生。

当前存储仍含文件追加，队列、展示和运行记录不在同一接纳事务。轨迹 checkpoint 类型或预算裁剪并不证明会话级压缩已完成；原始协议内容存在也不代表允许向任意模型来源重放。兼容回填代码不是读取旧版本数据的授权。

## 未完成与施工入口
全入口接纳事务、终态持久化、来源绑定回放、会话压缩与重启对账，由[会话可靠性计划](../superpowers/plans/2026-11-12-conversation-reliability.md)及[进度](../superpowers/plans/2026-11-12-conversation-reliability-progress.md)承接。

现有测试：`src/main/conversation/transcript/conversation-transcript-store.test.ts`、`src/main/agent/loop/conversation-transcript-context.test.ts`、`src/main/agent/loop/transcript-sink.test.ts`。本次不据测试定义宣称重启、崩溃和真实模型回放通过。
