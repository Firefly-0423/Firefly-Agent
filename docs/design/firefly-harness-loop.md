状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 智能体主循环与执行职责

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
让模型通过连续工具调用推进任务，同时由运行时守住权限、取消、结果真实性和保存边界。本文合并主循环的建设清单、状态与重复核验，施工任务只保留既有计划链接。

## 当前实现
`src/main/agent/runtime/firefly-agent.ts` 的 `FireflyAgent.runWithEvents` 选择执行路径：无工具 Chat 使用 `src/main/agent/runtime/chat-loop.ts` 的 `runChatLoop`；有工具 Chat、Work、Code 经 `src/main/agent/runtime/agent-loop-adapter.ts` 的 `runAgentLoopWithAdapter` 接入 `src/main/agent/loop/agent-loop.ts` 的 `runAgentLoop`。共用内核不表示工具和权限相同。

`src/main/agent/loop/types.ts` 定义 `AgentLoopInput`、`AgentLoopResult`、`AgentState`、`ToolObservation` 与 `DEFAULT_AGENT_LOOP_CONFIG`。状态保存待办、未决效果和失败计数；没有用完成义务数组判断任务质量。

## 每轮行为及失败处理
1. 检查保存失败、取消、轮数和执行预算，消费安全点插话。
2. 构建提示词与上下文预算，经 `src/main/agent/loop/agent-loop-llm.ts` 请求模型。
3. 等待 assistant 声明写入；失败则返回运行错误，不执行工具。
4. 有工具时进入 `src/main/agent/loop/tool-round.ts`，按声明提交结果，再进入下一轮。
5. 无工具时再检查插话；有新输入则将正文归为过程继续，否则发布最终回答并收尾。

`drainRunExecution` 等待受管理执行收敛；checkpoint 失败不能视为成功。模型最终回答不等于工作质量已获验证，未知副作用不会因为回答结束而被清除。

## 依赖与边界
工具注册及归一化位于 `src/main/tooling/registry/tool-registry.ts`、`src/main/tooling/registry/tool-executor.ts`；控制工具位于 `src/main/agent/loop/builtin-tools.ts`。不要把控制工具与普通工具登记混成同一路径。结构化输出仍由 `src/main/model/structured/` 提供，记忆侧消费者见 `src/main/memory/legacy/memory-llm-client.ts`，不能因主循环存在而删除。

并发见[调度设计](harness-parallel-scheduling.md)，取消、重放、空文件及未决效果见[运行边界](harness-runtime-boundary.md)，候选显示见[候选正文](live-candidate-answer.md)。

## 未完成与施工入口
持久化工具回执、原子接纳和恢复由[会话可靠性](../superpowers/plans/2026-11-12-conversation-reliability.md)承接；模型请求失败反馈由[模型错误分类](../superpowers/plans/2026-11-12-model-error-classification.md)承接；有界命令展示由[命令实时输出](../superpowers/plans/2026-11-12-command-live-output.md)承接。不得将完整结果存储说成实时日志。

现有 `src/main/agent/loop/agent-loop.test.ts` 覆盖写后结束、声明保存与未知效果；`src/main/agent/loop/agent-loop-cancel.test.ts` 覆盖取消。本次未执行。正式数据目录的当前依据为 `src/main/base/identity/data-directory.ts` 的 `FIREFLY_DATA_DIRECTORY`，已为 `Firefly-1.2.0`。
