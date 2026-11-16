# Firefly 模型服务错误处理与错误码参考

状态：参考资料（核验日期 2026-11-16）

本文档说明 Firefly 当前已实现的模型调用失败分类架构、底层传输重试逻辑、渲染进程脱敏展示，以及全部公开错误码与国际化文案映射表。

> **现状边界声明**：`docs/superpowers/plans/2026-11-12-model-error-classification.md`（及其进度文档 `-progress.md`）当前状态为 `未开工`。因此，Firefly 现阶段**尚未**按厂商响应体内的 `error.code` / `error.type` 做细分分类，也**未**引入用户可配的模型重试次数或独立故障提示卡片；当前全部内置提供商共享一套统一的运行期错误收口与传输重试机制。

---

## 1. 分层错误分类与传播架构

一次模型调用在主进程到渲染进程之间依次经过以下 5 层分类与收敛：

| 层级 | 关键模块与源码 | 接收输入 | 当前分类行为与产出 |
|---|---|---|---|
| **1. 传输与非流式层** | `src/main/model/providers/prepared-model-call.ts` (`dispatchPreparedModelCall`、`nonStreaming`)、`connection-lost.ts` (`connectionLost`)、`error-chain.ts` (`causeCodes`) | 原生 `fetch` / 网络异常 / 空闲计时器 / HTTP 响应 | 响应头空闲默认 120s、流读取空闲默认 300s（`MODEL_IDLE_DEFAULTS`）。非流式 `!response.ok` 抛出 `AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型请求失败：HTTP <status>", { cause })`（`cause` 含 `status` 与截断至 200 字符的响应体）；空闲超时抛出 `E_MODEL_REQUEST_TIMEOUT`；底层 Socket/Undici 断连且无 HTTP 状态码时 `connectionLost` 命中，抛出 `E_MODEL_CONNECTION_LOST`。 |
| **2. 流式 SDK 与 Normalizer 层** | `src/main/model/providers/sdk-stream/runtime.ts` (`runSdkStream`)、`types.ts` (`ProviderProtocolError`)、各协议 Normalizer | SDK 流异常、协议事件解析异常、超时/取消信号 | `deadlineExpired` → `E_MODEL_REQUEST_TIMEOUT`；`input.signal?.aborted` → 原样重抛取消原因；`ProviderProtocolError` / `AgentRuntimeError` → 原样透传（如 `E_UNSUPPORTED_STREAM_EVENT`、`E_STREAM_TERMINAL_MISMATCH`、`E_TOOL_CALL_INCOMPLETE`、`E_TOOL_CALL_ID_CHANGED`）；`connectionLost(cause)` → `E_MODEL_CONNECTION_LOST`；其余全部包装为 `E_MODEL_REQUEST_FAILED`。本地日志仅使用 `causeCodes(cause)` 输出类名、HTTP 状态或系统 Socket 码，不打印厂商响应体 `error.code`。 |
| **3. 记忆运行时边界层** | `src/main/agent/memory-runtime/main-memory-runtime.ts` (`createMainMemoryRuntime`、`safeFailure`) | `dispatchPreparedModelCall` 失败、上下文装配/准入失败 | 若非流式首包前命中 400/422 且满足 `explicitStreamRejection` → 抛出 `MEMORY_CONTEXT_STREAM_UNSUPPORTED`；若带图且 400/422 满足 `explicitImageRejection` → 抛出 `MEMORY_CONTEXT_IMAGE_UNSUPPORTED`。在持久化会话中当 `context.dispatch` 返回 `sent.status !== "sent"` 时：保留 `MEMORY_CONTEXT_STREAM_UNSUPPORTED`、`MEMORY_CONTEXT_IMAGE_UNSUPPORTED`、`E_MODEL_REQUEST_TIMEOUT`、`E_MODEL_CONNECTION_LOST`，**其余故障（包含常见 HTTP 4xx/5xx 导致的 `E_MODEL_REQUEST_FAILED`）收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`**；在 `temporary` 模式下通过 `safeFailure` 收敛，超时/断连与已知 `MEMORY_*` 原样保留，其余收敛为 `MEMORY_CONTEXT_RUN_FAILED`。 |
| **4. 智能体循环与运行协调层** | `src/main/agent/runtime/chat-loop.ts`、`firefly-agent.ts` (`classifyRunError`、`safeTerminalError`)、`src/main/agent/loop/agent-loop.ts` (`failedStage`、`recordFailure`)、`terminal-mapper.ts` (`mapTerminateReasonToTerminal`) | `callLLM` / `runChatLoop` 抛出或循环中断 | **纯 Chat (`runChatLoop`)**：异常抛出后经 `FireflyAgent.runWithEvents` 进入 `classifyRunError`（`AgentRuntimeError` 提取 `httpStatus` 仅打主进程日志）与 `safeTerminalError`（调用默认 `publicRunFailure(error)`）；若属于 `user_cancelled`，转为 `RUN_FINISHED { status: "cancelled" }`。**Agent 循环 (`runAgentLoop`)**：`callRoundLLM` 失败进入 `failedStage(run, cause, cause instanceof ContextError ? "context" : "model")`，随后 `mapTerminateReasonToTerminal` 转为 `terminal: { status: "runtime_error", reason, errorSource }`。 |
| **5. IPC 脱敏门与前端渲染层** | `src/shared/run-failure.ts` (`publicRunFailure`)、`src/main/features/chat/agui-bridge.ts` (`RunSettlementGate`)、`src/renderer/react/features/chat/pages/run/AgentRunController.ts` | `RUN_FINISHED (runtime_error)` 或流 `error` 回调 | `agui-bridge.ts` 对两种出口统一经 `publicRunFailure` 过滤，将 `RUN_ERROR` 的 `message` 和 `code` 字段均设为安全枚举码并附带 `errorSource`，绝不向渲染进程传递厂商原始报错文本；`AgentRunController.ts` 再次调用 `publicRunFailure` 并按 `code` / `source` 选择 i18n 文案写入过程消息列表。 |

### 非主聊天路径的独立错误映射

- **连接测试**（`src/main/model/providers/test-connection.ts`、`openai-adapter.ts`、`anthropic-adapter.ts`、`responses-adapter.ts`、`model-connection-state.ts`）：适配器返回 `{ ok: false, error: "HTTP <status> <detail.slice(0, 200)>" }` 或异常消息；`createModelConnectionState().test` 向外标准化输出 `"MODEL_CONNECTION_TEST_FAILED"` 或 `"MODEL_CONNECTION_TEST_ERROR"`。
- **拉取模型列表**（`src/main/model/config/fetch-vendor-models.ts`）：返回 `"MISSING_BASE_URL"` | `"MISSING_API_KEY"` | `"NETWORK"` | `"TIMEOUT"` | `"BAD_RESPONSE"` | `` `HTTP_${number}` ``，对应设置页 `settings.panel.api.field.model.fetch.*` 文案（`src/renderer/settings/i18n/zh-CN.json`）。
- **图片转述**（`src/main/model/vision/vision-captioner.ts`）：HTTP 失败、空响应、超时或异常时返回以 `"[错误·运行时]"` 开头的纯文本提示，不触发 `RUN_ERROR`。
- **结构化输出**（`src/main/model/structured/runner.ts`）：`requestFailure` 将内部异常映射为 `"MODEL_REQUEST_TIMEOUT"`、`"MODEL_HTTP_ERROR"`、`"MODEL_RESPONSE_PARSE_FAILED"` 或 `"MODEL_REQUEST_FAILED"`，并按 `"fail_closed"` 快速终止修复循环。

---

## 2. 当前重试与回退行为

1. **SDK 层零重试**：`src/main/model/providers/sdk-stream/client-config.ts` 中 `deriveOpenAIClientConfig`、`deriveResponsesClientConfig`、`deriveAnthropicClientConfig` 均硬编码 `maxRetries: 0`，禁止 OpenAI / Anthropic SDK 在底层自行退避重试。
2. **传输层首包前自动重试**（`src/main/model/providers/prepared-model-call.ts`）：
   - **断连与响应头沉默超时**：当发送阶段在**尚未收到响应头（`response === undefined`）**前触发 `connectionLost(error) || idleExpired` 时，按 `CONNECTION_RETRY_DELAYS_MS = [1_000, 3_000]` ms 最多重试 **2 次**（总计最多 3 次尝试）；一旦开始接收响应体，严禁重放。
   - **临时 HTTP 状态码**：命中 `TEMPORARY_PROVIDER_STATUSES = new Set([429, 502, 503, 504, 529])` 时，最多重试 **2 次**；调用 `providerRetryDelayMs(attempt, retry-after)` 解析响应头 `Retry-After`（支持秒数与 HTTP 日期），否则回退 `PROVIDER_RETRY_DELAYS_MS = [2_000, 6_000]` ms，单次等待上限由 `PROVIDER_RETRY_MAX_WAIT_MS = 20_000` ms 截断。每次重试均重新调用 `guardSend`（如 `invokeClaimedRequest`）校验调用权。
   - **非临时 HTTP 状态码**（如 `400`、`401`、`403`、`404`、`422` 等）与流式读取中途断连均**不重试**。
3. **语义能力回退**（非同参重试）：
   - **流式不支持回退**：在未产生任何可见内容前遇到 `isExplicitStreamUnsupported`（`src/main/model/providers/stream-support.ts`）或 `MEMORY_CONTEXT_STREAM_UNSUPPORTED`，`chat-loop.ts` 与 `agent-loop-llm.ts` 自动回退一次 `stream: false` 非流式调用。
   - **视觉转述回退**：纯对话 `chat-loop.ts` 在首图直发被拒且满足 `imageCaptionFallback` 条件时执行一次图片转述降级重发（`src/main/agent/runtime/chat-loop.ts`）。
4. **后台任务队列**：`enqueueLLMTask`（`src/main/model/queue/llm-queue.ts`）提供面向后台摘要等任务的 `retryRateLimit` 参数控制；关闭时遇 429 直接抛错，不重试。

---

## 3. 错误码、来源归类与 i18n 文案总表

### 3.1 `publicRunFailure` 公开错误码表（`src/shared/run-failure.ts`、`src/renderer/react/features/chat/pages/run/AgentRunController.ts`）

| 公开错误码 (`code`) | `errorSource` | 产生来源与典型触发场景 | UI 对应 i18n Key（`src/renderer/react/i18n/`） | 中文展示模板 (`zh-CN.json`) / 英文模板 (`en.json`) |
|---|---|---|---|---|
| `E_MODEL_CONNECTION_LOST` | `model` | 底层 TCP/TLS/DNS/Socket 中断（`connectionLost` 命中且无 HTTP 状态码） | `chatPage.errorNetworkInterrupted` | `网络连接中断，流萤没收到模型的回复。可能是网络或代理不稳定，稍后重新发送就好。（{{code}}）` / `The connection dropped before the model replied. The network or a proxy may be unstable; send the message again in a moment. ({{code}})` |
| `E_MODEL_REQUEST_TIMEOUT` | `model` | `dispatchPreparedModelCall` 首包/流空闲超时（120s / 300s），或 `runSdkStream` 请求截止定时器到期 | `chatPage.errorModelTimedOut` | `模型太久没有回应，已经停止等待。稍后再试一次吧。（{{code}}）` / `The model took too long to respond, so Firefly stopped waiting. Try again in a moment. ({{code}})` |
| `E_MODEL_REQUEST_FAILED` | `model` | 非临时 HTTP 错误（如 400/401/403/404/422）、重试耗尽的 429/5xx、其他未被专项归类的模型异常，或 `source: "model"` 兜底 | `chatPage.errorModelRequestFailedWith` | `模型请求失败：{{message}}` / `Model request failed: {{message}}`（其中 `{{message}}` 实际填入安全 `code`） |
| `E_MODEL_HTTP_ERROR` | `model` | 定义于 `AgentErrorCode`、`sources`、`classifyRunError` 及集成测试夹具（当前 `prepared-model-call.ts` 与 `sdk-stream/runtime.ts` 尚未主动构造该码，HTTP 非 2xx 当前仍抛出 `E_MODEL_REQUEST_FAILED`） | `chatPage.errorModelRequestFailedWith` | 同上 |
| `E_MODEL_RESPONSE_PARSE_FAILED` | `model` | 流式响应无可见文本（`chat-loop.ts`）或模型响应解析失败（`AgentErrorCode`） | `chatPage.errorModelRequestFailedWith` | 同上 |
| `MEMORY_CONTEXT_SEND_UNKNOWN`（及另外 20 个已注册 `MEMORY_CONTEXT_*` / `MEMORY_SOURCE_STALE`） | `context` | 记忆/上下文准入或发送确认异常；持久化模式 `context.dispatch` 返回非 `"sent"` 时将普通模型 `E_MODEL_REQUEST_FAILED` 收敛为此码 | `chatPage.errorContextFailedWith` | `上下文处理失败：{{message}}` / `Context processing failed: {{message}}` |
| `E_CONTEXT_FAILURE` | `context` | `source: "context"` 兜底码（例如非白名单 `ContextError`） | `chatPage.errorContextFailedWith` | 同上 |
| `E_TOOL_EXECUTION_FAILED` / `E_SHELL_EXIT` / `E_SHELL_SPAWN` / `E_TOOL_TIMEOUT` | `tool` | 工具执行抛出未捕获异常（`agent-loop.ts`） | `chatPage.errorToolFailedWith` | `工具执行失败：{{message}}` / `Tool execution failed: {{message}}` |
| `E_HARNESS_FAILURE` | `runtime` | `source: "runtime"` 默认兜底码；未注册进 `sources` 的内部码（如 `MEMORY_CONTEXT_RUN_FAILED`、`ProviderProtocolErrorCode` 在经 `agui-bridge` / 默认 `publicRunFailure` 时）会折叠为此码 | `chatPage.errorRuntimeFailedWith` | `任务执行失败：{{message}}` / `Task execution failed: {{message}}` |
| `E_AGENT_NO_PROGRESS` / `E_AGENT_GRAPH_ITERATION_LIMIT` | `runtime` | 代理无进展 / 图迭代次数超限（`AgentErrorCode`、`sources`） | `chatPage.errorRuntimeFailedWith` | 同上 |

### 3.2 其他内部/协议错误码与前缀 UI 文案

1. **`sources` 中列出的全部 `context` 枚举码**（`src/shared/run-failure.ts`）：`E_CONTEXT_FAILURE`、`MEMORY_CONTEXT_TRANSCRIPT_SECRET`、`MEMORY_CONTEXT_INPUT_INVALID`、`MEMORY_CONTEXT_TOOL_PAIR_INVALID`、`MEMORY_CONTEXT_CAPTURE_FAILED`、`MEMORY_CONTEXT_REQUEST_CHANGED`、`MEMORY_CONTEXT_RECENT_INCOMPLETE`、`MEMORY_CONTEXT_SEND_UNKNOWN`、`MEMORY_CONTEXT_SETTLEMENT_UNKNOWN`、`MEMORY_CONTEXT_SOURCE_UNAVAILABLE`、`MEMORY_CONTEXT_RESPONSE_FAILED`、`MEMORY_CONTEXT_CANCELLED`、`MEMORY_CONTEXT_BUDGET_EXCEEDED`、`MEMORY_CONTEXT_BUDGET_UNKNOWN`、`MEMORY_CONTEXT_BUDGET_UNPROVEN`、`MEMORY_CONTEXT_RECENT_OVER_BUDGET`、`MEMORY_CONTEXT_FIXED_OVER_BUDGET`、`MEMORY_CONTEXT_OVER_BUDGET`、`MEMORY_CONTEXT_COUNT_FAILED`、`MEMORY_CONTEXT_COUNTER_MISMATCH`、`MEMORY_CONTEXT_COUNTER_UNSUPPORTED`、`MEMORY_SOURCE_STALE`。
2. **`ProviderProtocolErrorCode`**（`src/main/model/providers/sdk-stream/types.ts`）：`E_UNSUPPORTED_STREAM_EVENT`、`E_STREAM_TERMINAL_MISMATCH`、`E_TOOL_CALL_INCOMPLETE`、`E_TOOL_CALL_ID_CHANGED`。因未加入 `src/shared/run-failure.ts` 的 `sources`：经 `agent-loop.ts` `"model"` 兜底时输出 `E_MODEL_REQUEST_FAILED`，经 `agui-bridge.ts` / 默认 `"runtime"` 兜底时输出 `E_HARNESS_FAILURE`。
3. **未加入 `sources` 的常见内部 `MEMORY_*` 码**（如 `main-memory-runtime.ts` / `agui-bridge.ts` 中的 `MEMORY_RUN_DENIED`、`MEMORY_CONTEXT_RUN_FAILED`、`MEMORY_CONTEXT_STREAM_UNSUPPORTED`、`MEMORY_CONTEXT_IMAGE_UNSUPPORTED`、`MEMORY_CONTEXT_RUN_UNAVAILABLE`、`MEMORY_CONTEXT_CLOSE_FAILED` 等）：经 `publicRunFailure` 且未回落为 `"context"` 时统一折叠为 `E_HARNESS_FAILURE`（若在 `agent-loop.ts` `ContextError` 分支则折叠为 `E_CONTEXT_FAILURE`）。
4. **前端派发前置与落盘告警 i18n Key**（`src/renderer/react/i18n/zh-CN.json`、`AgentRunController.ts`）：
   - `chatPage.errorModelServiceNotReady`：`模型请求失败：AG-UI 模型服务尚未就绪`
   - `chatPage.errorModelRequestStartFailed`：`模型请求发起失败`
   - `chatPage.errorUserMessageNotPersisted`：`模型请求失败：用户消息未能写入当前会话`
   - `chatPage.sessionRunActiveNotice`：`当前会话已有正在运行的任务（可能来自刷新前的旧运行），本轮未执行。`
   - `chatPage.terminalSaveFailed`：`这条回答没能保存到聊天记录，重新打开后可能看不到。需要的话请先复制保留。`

---

## 4. 各提供商文档索引与跳过列表

### 已覆盖（9 家已在代码中注册的提供商）

- [OpenAI（ChatGPT）](./openai.md)
- [Anthropic（Claude）](./anthropic.md)
- [DeepSeek（深度求索）](./deepseek.md)
- [Qwen（通义千问）](./qwen.md)
- [GLM（智谱）](./glm.md)
- [Kimi（月之暗面）](./kimi.md)
- [MiniMax（稀宇科技）](./minimax.md)
- [MiMo（小米）](./mimo.md)
- [OpenRouter](./openrouter.md)

### 已跳过（当前代码中无独立厂商配置）

- **Gemini（跳过 `gemini.md`）**：`PROVIDER_CAPABILITIES`（`src/main/model/providers/capabilities.ts`）、`MODEL_PRESETS`（`src/renderer/settings/api/presets.ts`）与 `MODEL_REASONING_RULES`（`src/shared/reasoning.ts`）均不存在独立 `gemini` / Google 提供商注册或默认端点；当前仅在 `src/main/model/providers/model-modalities.catalog.ts` 中通过 `^gemini-` 匹配图像能力，用于 OpenRouter 或自定义端点接入场景。
- **Doubao / 豆包（跳过 `doubao.md`）**：代码库 `src/` 中不存在 Doubao 相关提供商能力、预设模型或错误适配实现。
- **Grok（跳过 `grok.md`）**：代码库 `src/` 中不存在 Grok 相关提供商能力、预设模型或错误适配实现。
