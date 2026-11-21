# Firefly Agent Harness 执行链路参考

状态：参考资料（核验日期 2026-11-16）

本文档说明 Firefly 从渲染进程发起一次对话运行、到主进程调度模型与工具、再经检查点与终态结算落盘的完整执行链路，以及取消信号与故障在各层之间的传播规则。

---

## 1. 全链路文字流程图

```text
[Renderer: AgentRunController.start()]
  │  src/renderer/react/features/chat/pages/run/AgentRunController.ts
  │  1) 初始持久化运行中快照 checkpointRun("running", true)
  │  2) 订阅 AG-UI 事件 (RunEventGate 去重/防乱序)
  ▼  IPC: agui:chat (transport.run)
[Main: registerAgUiIpc]
  │  src/main/features/chat/agui-bridge.ts
  │  1) 会话准入与占用检查 (activeRuns / takeoverFromRunId 等待旧 run 结算)
  │  2) 立即返回 ack { success: true, runId }；后台启动 executeRun
  │  3) createAgentRuntime / buildAgentRunOptions + mainMemoryRuntime.openRun
  ▼
[L4 Runtime: FireflyAgent.runWithEvents]
  │  src/main/agent/runtime/firefly-agent.ts
  │  发射 EventType.RUN_STARTED；构造内层 Cancellation AbortController
  ├─────────────────────────────────────────┐
  │ executionMode === "chat"                │ executionMode === "work"
  │ 且无工具 (tools.length === 0)           │ 或 chat 模式含工具
  ▼                                         ▼
[runChatLoop]                             [runAgentLoopWithAdapter]
  │  src/main/agent/runtime/chat-loop.ts    │  src/main/agent/runtime/agent-loop-adapter.ts
  │  1) 上下文压缩 (非 memoryRun 时)        │  1) prepareAgentLoopRun + prepareToolRuntime
  │  2) 流式调用 + 非流式显式回退           │  2) 构造 AgentLoopInput，调用 runAgentLoop()
  │  3) 图像拒识时触发 imageCaptionFallback │     └─ src/main/agent/loop/agent-loop.ts
  │  4) 写入 transcriptSink + checkpoint    │        ├─ 轮询动态插话 pollRunAdjustments()
  │                                         │        ├─ 阈值压缩 compactIfNeeded()
  │                                         │        ├─ callRoundLLM() → callLLM()
  │                                         │        │   └─ MainMemoryRun.call / dispatchPreparedModelCall
  │                                         │        │       └─ runSdkStream() (maxRetries: 0)
  │                                         │        ├─ 若无 toolCalls 且无新插话 → finishRun()
  │                                         │        └─ 若有 toolCalls → checkpoint() → runToolRound()
  │                                         │            ├─ scheduleToolCalls() (parallel/exclusive/delegation)
  │                                         │            ├─ executeToolCallWithRetry() + retry-policy.ts
  │                                         │            ├─ checkPermission() / requestApproval()
  │                                         │            └─ 委托子代理 createAgentExecutor / runChildSession
  │                                         │        └─ 终态: settleRun() → drainRunExecution() + checkpoint()
  │                                         │  3) mapTerminateReasonToTerminal() + journal.markTerminal()
  └───────────────────┬─────────────────────┘
                      ▼
[AgUiBridge 终态收口 (RunSettlementGate)]
  │  src/main/features/chat/agui-bridge.ts
  │  - 若收到 RUN_FINISHED 且 result.status === "runtime_error"：
  │    转译为单一 RUN_ERROR { code, errorSource } (经 publicRunFailure)
  │  - 若收到其他 RUN_FINISHED：
  │    等待 RunSettlementGate → finishTurn() / 持久化确认 → 转发 RUN_FINISHED
  │  - 若流抛出 error：
  │    publicRunFailure(failure) → 转发单一 RUN_ERROR { code, errorSource }
  ▼
[Renderer: AgentRunController.handleEvent() & settleTerminalSave()]
  │  1) RUN_FINISHED / RUN_ERROR 清理队列 reveal、关闭活动状态
  │  2) 失败时调用 publicRunFailure 展示错误提示 (保留过程消息与候选文本)
  │  3) persistTerminal() 最多尝试 3 次 ([100, 300] ms 退避) → reportRunPersisted()
```

---

## 2. 分层阶段详解

### 2.1 IPC 准入、会话互斥与上下文准备（`src/main/features/chat/agui-bridge.ts`）

1. **会话并发控制**：同一 `sessionId` 同时只允许一个活跃运行。若存在活跃运行且请求未携带匹配的 `takeoverFromRunId`，`agui-bridge.ts` 拒绝新建运行并返回冲突锚点；渲染进程 `AgentRunController.ts` 解析 `parseSessionRunActiveError` 后向用户展示接管卡片，重试时携带 `takeoverFromRunId`。携带合法 `takeoverFromRunId` 时，桥接层中止旧运行并等待其结算（带超时上限，避免永久挂起）。
2. **记忆与运行句柄打开**：`buildAgentRunOptions`（`src/main/agent/runtime/build-options.ts`）与 `createAgentRuntime`（`src/main/agent/runtime/agent-runtime.ts`）组装模型设置、系统提示词、可用工具、工作区边界、能力白名单和回退回调，并通过 `mainMemoryRuntime.openRun`（`src/main/agent/memory-runtime/main-memory-runtime.ts`）颁发受范围约束的 `MainMemoryRun` 实例，用于统一装配上下文与校验请求指纹（防止调用期间模型配置或提示上下文漂移）。

### 2.2 `FireflyAgent` 与模式分流（`src/main/agent/runtime/firefly-agent.ts`）

`FireflyAgent.runWithEvents` 建立运行级 `AbortController`、绑定 `transcriptSink` 与 `executionLedger`，先发射 `EventType.RUN_STARTED`，随后依据 `resolveExecutionMode(options.executionMode)` 与工具数量分流：
- **纯对话链路 (`runChatLoop`)**：仅当 `executionMode === "chat"` 且无工具时进入 `src/main/agent/runtime/chat-loop.ts`。
  - 默认发起流式请求；若未收到任何可见 delta 前即遇到显式流式拒识（`isExplicitStreamUnsupported` 或 `MEMORY_CONTEXT_STREAM_UNSUPPORTED`），通过 `StreamUnavailableError` 自动回退至 `nonStreaming` 并在本地按字符切片平滑输出（`emitFallbackText`）。
  - 若请求失败且满足非流式半截输出、未触发记忆侧安全拒绝且配置了 `imageCaptionFallback`，则降级为先转述图片再重发一次。
  - 结束前写回 `transcriptSink.appendAssistant`，且仅当终态为 `success` 时 await `transcriptSink.checkpoint()`（`src/main/agent/runtime/firefly-agent.ts`）。
- **智能体循环链路 (`runAgentLoopWithAdapter`)**：`work` 模式或携带工具的 `chat` 模式均进入 `src/main/agent/runtime/agent-loop-adapter.ts`。
  - `prepareAgentLoopRun`（`src/main/agent/runtime/adapter/run-preparation.ts`）与 `prepareToolRuntime`（`src/main/agent/runtime/adapter/tool-runtime.ts`）负责按模式过滤工具、初始化 `AgentRunStore`（`src/main/agent/loop/run-store.ts`）、支持基于 `resumeFromRunId` 的恢复（`prepareAgentRunRecovery`，`src/main/agent/loop/run-recovery.ts`）、构建提示词层及绑定权限检查与子代理执行器。

### 2.3 `runAgentLoop` 回合循环与模型调用（`src/main/agent/loop/agent-loop.ts`）

`DEFAULT_AGENT_LOOP_CONFIG`（`src/main/agent/loop/types.ts`、`src/main/platform/settings/run-defaults.ts`、`src/shared/context-window.ts`）定义的默认运行预算如下：
- `maxRounds`：`DEFAULT_MAX_TOOL_ROUNDS = 200`
- `totalTimeoutMs`：`DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000`（2 小时）
- `modelRequestTimeoutMs`：`DEFAULT_AGENT_LOOP_MODEL_REQUEST_TIMEOUT_MS = 10 * 60 * 1000`（10 分钟）
- `maxParallelToolCalls`：`4`
- `userWaitTimeoutMs`：`120_000`（2 分钟）
- `contextWindowTokens`：`DEFAULT_CONTEXT_WINDOW_TOKENS`（`1_000_000`），`reservedOutputTokens: 8_192`，`safetyMarginTokens: 512`，`compactionRetainRatio: 0.16`

每轮执行顺序：
1. **检查退出/中止条件**：检查 `run.checkpointFailure`、`host.signal?.aborted`（命中时进入 `abortedResult`）以及 `run.rounds >= run.config.maxRounds`（输出 `buildMaxRoundsReply` 并以 `max_rounds` 结束）。
2. **动态插话 (`pollRunAdjustments`)**：拉取用户在运行期间提交的排队调整消息，追加进 `run.messages` 并写入检查点。
3. **上下文压缩 (`compactIfNeeded`)**：达到压缩阈值时调用 `summarizeHistory`（`src/main/agent/loop/agent-loop-llm.ts`），更新 `AgentLoopCacheState` 缓存纪元（`"compaction"`）。
4. **调用模型 (`callRoundLLM` → `callLLM`)**：`src/main/agent/loop/agent-loop-llm.ts` 调用 `MainMemoryRun.call`（或直接 `streamChatWithSdk`）。文本前缀经过 `ChatTimeStreamPrefixFilter` 过滤后以 `candidate_text_delta` 推送，推理增量以 `reasoning_start` / `reasoning_delta` / `reasoning_end` 推送。若首段内容前遭遇显式不支持流式拒绝，自动回退为 `stream: false` 请求。
5. **模型底层发送（`dispatchPreparedModelCall` → `runSdkStream`）**：
   - `prepareModelCall`（`src/main/model/providers/prepared-model-call.ts`）在发送前冻结序列化请求体与输入模态。
   - `dispatchPreparedModelCall` 通过共享连接池 `modelConnectionPool` 拦截全局 `fetch`，监控响应头（默认 120s）/ 流式体空闲超时（默认 300s，`MODEL_IDLE_DEFAULTS`），并在特定条件下执行自动重试（详见 `docs/references/vendor-errors/README.md` 与 `docs/specs/model-request-retry.md`）。
   - `runSdkStream`（`src/main/model/providers/sdk-stream/runtime.ts`）固定将 `client-config.ts` 中三家 SDK 客户端配置为 `maxRetries: 0`，将原生流事件交由各协议 Normalizer 与 `FireflyStreamAccumulator` 聚合为统一 `ChatResponse`。
6. **响应落盘与分支**：将 `assistant` 消息记入 `run.messages` 并调用 `transcriptSink.appendAssistant`；若本轮不含 `toolCalls` 且 `finalPoll` 无新插话，提交 `progressBuffer`、发出 `final_answer` 并调用 `finishRun`；否则先执行 `checkpoint(run)` 再进入工具轮次。

### 2.4 工具调度、权限审批与子代理委托

1. **分类与并行调度 (`scheduleToolCalls`，`src/main/agent/loop/tool-call-scheduler.ts`)**：
   - `classifyToolExecutionMode` 将工具调用分为 `parallel`、`exclusive` 或 `delegation`。
   - 并行批次并发上限受 `maxParallelToolCalls`（默认 `4`）限制，互斥工具独占执行，所有结果按声明顺序提交进 `run.messages` 与工具输出存储。
2. **工具调用与重试 (`runToolRound`、`src/main/agent/loop/tool-round.ts`、`tool-dispatcher.ts`)**：
   - 派发前通过 `AgentRunStore`（`src/main/agent/loop/run-store.ts`）记录工具生命周期状态流转（`planned` → `started` → `committed` / `unknown` / `not_executed`）。
   - 工具失败时，`error-classifier.ts`（`classifyToolError` / `classifyToolResultError`）识别错误类别，结合 `retry-policy.ts`（`decideRetry` / `getRetryParams` / `sleepWithJitter`）与工具 `effectKind` 决定是否重试（如 `non_idempotent_side_effect`、`fatal`、`runtime_safety` 永不重试；`read_only` / `idempotent_mutation` 的 `transient` 最多重试 3 次，退避 `[500, 1000, 2000]` ms；`timeout` `[1000, 3000]` ms；`rate_limited` `[2000, 5000]` ms；`partial_failure` 仅 `read_only` 重试 1 次 `[500]` ms）。
   - 超大输出由 `truncateOutput`（`tool-dispatcher.ts`，阈值 `DEFAULT_TRUNCATION.thresholdChars = 30_000`）裁剪并在 `file-tool-output-store` 持久化全文引用。
3. **权限审批 (`checkPermission`，`src/main/platform/permission/permission.ts`、`permission-policy.ts`)**：
   - `policyFor(level, risk)` 按文件访问档位（`read-only`、`per-action`、`full`）与工具风险级别（`safe`、`fs-read`、`fs-write`、`network`、`shell`）判定 `allow` / `ask` / `deny`。
   - 判定为 `ask` 时调用 `requestApproval` 弹出前端审批卡片并绑定运行取消信号；若运行被取消，`cancelPendingApprovalsForRun` 会广播取消通知并将等待中的审批以 `AbortError` 拒绝。
4. **子代理委托 (`persistent-agent-runtime.ts`、`child-session-runtime.ts`、`child-run-lifecycle.ts`)**：
   - 委托工具调用 `createAgentExecutor` 启动隔离的 `runChildSession`，为其打开独立 `MainMemoryRun` 并沿用父级 `vendorConfig` 与请求预算；退出前通过 `settleChildExecution` 调用 `coordinator.whenChildSettled(childRunId)` 确保子叶子任务完全收敛后再关闭父边界。

### 2.5 检查点、终态结算与前端落盘

1. **运行期快照与恢复 (`AgentRunStore`，`src/main/agent/loop/run-store.ts`、`run-recovery.ts`)**：
   - 每轮工具前后与检查点处持久化 `AgentRunSession`（状态枚举：`running`、`completed`、`failed`、`cancelled`、`interrupted`）；热路径索引刷新合并周期为 500 ms，终态切换通过 `markTerminal` 立即冲刷磁盘并防止旧异步回调覆写。
   - 进程重启或中断恢复时，`prepareAgentRunRecovery` 核对工作区兼容性并把未结算工具标记为 `not_executed` 或 `unknown`，生成供下一轮续跑的恢复上下文与新缓存纪元。
2. **终态单次结算门 (`RunSettlementGate`，`src/main/conversation/transcript/run-settlement.ts`、`agui-bridge.ts`)**：
   - 每个 `runId` 仅允许一次终态发布（`RUN_FINISHED` 或 `RUN_ERROR`）。
   - 若工具循环返回 `terminateReason === "error"`，`mapTerminateReasonToTerminal`（`src/main/agent/runtime/adapter/terminal-mapper.ts`）将其转为 `{ status: "runtime_error", reason, errorSource }`，随后 `agui-bridge.ts` 在 `RUN_FINISHED` 拦截分支将其统一转换为单一 `RUN_ERROR` 事件发送给渲染进程（保证前端错误归口一致）。
3. **前端接收与持久化确认 (`AgentRunController`，`src/renderer/react/features/chat/pages/run/AgentRunController.ts`)**：
   - `RunEventGate`（`src/renderer/react/features/chat/pages/run-event-gate.ts`）过滤不属于当前 `runId` 的迟到事件。
   - 收到 `RUN_FINISHED` / `RUN_ERROR` 后停止文本流式动画、清理过程消息中的待分类候选文本、调用 `persistTerminal()` 写入聊天存储（最多 3 次，重试间隔 `[100, 300]` ms），确认落盘后再 `refreshCanonicalSettlement()` 与 `reportRunPersisted()`。

---

## 3. 取消信号与失败传播规则

| 中断 / 失败来源 | 触发层级与判定依据 | 终态事件与错误码去向 | 副作用与会话收敛 |
|---|---|---|---|
| 用户主动取消 (`user_cancelled`) | `agui-bridge.ts` 中 `cancelRun` 触发 `AbortController`；`FireflyAgent.runWithEvents` 记录 `firstAbort = "user_cancelled"`；`agent-loop.ts` 检查 `signal.aborted && !deadlineExceeded` | **不发 `RUN_ERROR`**，统一发 `RUN_FINISHED { status: "cancelled", reason: "user_cancelled" }`；前端丢弃未定型正式回答并保留过程记录 | 调用 `quiesceExecution()` 与 `drainRunExecution()`；取消待审权限卡片 (`cancelPendingApprovalsForRun`)；调用 `transcriptSink.closeInterruption({ reason: "user_cancel" })` |
| 运行级总超时 / 轮次上限 | `agent-loop.ts` `clock` 触发 `deadlineExceeded`（`totalTimeoutMs`）或 `rounds >= maxRounds` | `RUN_FINISHED { status: "timeout", reason: "timeout" \| "max_rounds" }`；若发生于 `FireflyAgent` 外层捕获的 `E_AGENT_GRAPH_TIMEOUT` / `call_timeout`，走 `RUN_ERROR` | 生成包含 `todoItems` 与 `uncertainEffects` 的中断总结；标记 `externalEffectsMayContinue: true` |
| 模型调用失败（网络断连 / 超时 / HTTP 错误 / 流协议异常） | `prepared-model-call.ts`、`sdk-stream/runtime.ts`、`main-memory-runtime.ts` | 经 `publicRunFailure` 映射为固定错误码（如 `E_MODEL_CONNECTION_LOST`、`E_MODEL_REQUEST_TIMEOUT`、`E_MODEL_REQUEST_FAILED`、`E_HARNESS_FAILURE` 等），统一通过 `RUN_ERROR { code, errorSource }` 上报 | 原始厂商错误文本/响应体不透传给 IPC 或 UI（详见 `docs/references/vendor-errors/README.md`） |
| 上下文安全门 / 记忆错误 | `main-memory-runtime.ts` (`MEMORY_CONTEXT_*`) 或 `ContextError` | `agent-loop.ts` 以 `"context"` 兜底调用 `publicRunFailure`；已知 `MEMORY_CONTEXT_*` 保留原码，其余未注册码折叠为 `E_CONTEXT_FAILURE`（若走 `agui-bridge` 默认回退则折叠为 `E_HARNESS_FAILURE`） | 拒绝发送漂移或未授权请求，保护上下文隔离边界 |
| 工具执行失败 | `runToolRound` / `tool-dispatcher.ts` 抛出未捕获异常（区别于普通 `"failed"` 工具观测值回传给模型） | `agent-loop.ts` 以 `"tool"` 兜底调用 `publicRunFailure`，输出 `E_TOOL_EXECUTION_FAILED` / `E_SHELL_EXIT` / `E_SHELL_SPAWN` / `E_TOOL_TIMEOUT` | 记录 `AgentRunStore` 工具最终状态并刷新检查点 |
| 窗口销毁 / 上游清理 (`window_destroyed` / `upstream_cleanup`) | Observable 退订回调在 `!settled` 时标记 `upstream_cleanup` | 流已退订时不向已销毁渲染器推送；主进程仍等待 `drainRunExecution()` 与 `owned?.close()` 完成清理 | 防止子进程或后台记忆写入成为孤儿资源 |
