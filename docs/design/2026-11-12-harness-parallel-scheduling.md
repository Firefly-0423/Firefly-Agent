状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 工具并行调度与运行存储

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
允许可证明安全的工具并行执行，同时稳定模型看到的结果顺序；运行快照用于恢复与核对，不夸大为完整事务日志。

## 当前实现
`src/main/agent/loop/tool-call-scheduler.ts` 的 `classifyToolExecutionMode` 将调用分为 parallel、exclusive、delegation。普通工具须 effect 为 read/verification、副作用为 read_only，且 `isConcurrencySafe(args)` 明确返回 true；缺声明或判定异常按独占。内置结果读取可并行，伙伴委派进入独立池，其他控制工具独占。

同文件 `scheduleToolCalls` 按原始调用下标提交结果；普通池容量为 maxParallel，委派池为 `Math.min(3, maxParallel)`。独占调用形成屏障；委派组在 finally 关闭。执行许可与写入所有权在 `src/main/tooling/execution/execution-coordinator.ts`、`src/main/tooling/execution/write-ownership.ts`；同会话互斥由[运行边界](2026-11-12-harness-runtime-boundary.md)说明。

## 失败与取消
halt 停止后续发射，保留已启动调用的真实结果；未发射项才标为 not_executed。execute/commit 失败时等待在途原始 Promise 落定再传播，不能留下兄弟执行。取消后已进入执行的调用不能伪造成从未执行；提交失败仍可能留下轨迹缺口。调度顺序不是远端副作用撤销机制。

## 存储边界与未完成项
`src/main/agent/loop/run-store.ts` 的 `AgentRunStore` 保存运行快照、检查点与终态；索引有合并写入，终态立即刷新。事件日志只含部分事件事实，不能从中推出可完整重放所有模型消息。缓存、临时会话分支和原子替换也不能替代会话数据库事务、跨重启幂等或任意损坏修复。

[会话可靠性计划](../superpowers/plans/2026-11-12-conversation-reliability.md)统一承接新后端和恢复；不另建竞争日志后端。并发容量、写入次数和延迟没有本次测量结果。

现有测试：`src/main/agent/loop/tool-call-scheduler.test.ts`、`src/main/agent/loop/agent-loop-scheduler-failure.test.ts`、`src/main/agent/loop/run-store.test.ts`、`src/main/agent/loop/run-store-ephemeral.test.ts`。后续验收核对完整提交顺序、取消前后执行次数和终态刷盘；本次未执行。
