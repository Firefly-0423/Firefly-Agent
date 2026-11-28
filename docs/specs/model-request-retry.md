# 模型请求自动重试与能力回退规范（现状实装基线）

状态：已实现规范（核验日期 2026-11-16）

> **范围说明**：本文档仅规范当前仓库已实现且受测试守卫的重试与语义回退行为。`docs/superpowers/plans/model-error-classification.md` 中关于设置项 `modelRequestMaxRetries` 及按厂商错误子类驱动可配置退避的规划当前处于 `未开工`，故目前不存在用户级模型请求重尝试数配置。

---

## 1. SDK 客户端层禁用隐式重试

- **契约（`src/main/model/providers/sdk-stream/client-config.ts`）**：
  - `deriveOpenAIClientConfig`、`deriveResponsesClientConfig`、`deriveAnthropicClientConfig` 返回的客户端配置均硬编码 `maxRetries: 0`，将重试权统一收口到 Firefly 上层，避免与上层 `guardSend`、单次请求预算及空闲计时器叠加放大。
- **守卫测试**：
  - `src/main/model/providers/sdk-stream/client-config.test.ts`（显式断言 `deriveOpenAIClientConfig` 与 `deriveAnthropicClientConfig` 返回 `maxRetries: 0`）。
  - `src/main/model/providers/sdk-stream/provider-contracts.test.ts`（覆盖 MiniMax / MiMo Anthropic 及 OpenAI 派生配置 `maxRetries: 0`）。
- **未覆盖子项**：
  - `deriveResponsesClientConfig` 返回 `maxRetries: 0` 在 `client-config.test.ts` 中的独立单元测试断言 **未覆盖**。

---

## 2. `dispatchPreparedModelCall` 首包前传输重试（`src/main/model/providers/prepared-model-call.ts`）

### 2.1 空闲超时默认值

- `MODEL_IDLE_DEFAULTS` 定义：响应头等待上限 `headersMs = 120_000` ms，流读取单次分片空闲上限 `bodyMs = 300_000` ms（仅监控无字节静默期；持续有字节抵达时不中断长流）。
- 所有通过 `dispatchPreparedModelCall` 发出的请求共用单例连接池 `modelConnectionPool`，若运行时已安装 mock 或自定义 Dispatcher 则让位。

### 2.2 断连与首包沉默重试规则

- **触发条件**：`connectionLost(error) || idleExpired`，**且仅当 `response === undefined`（尚未收到任何响应头）**。
- **次数与延迟**：最多重试 2 次（总计 3 次尝试），延迟配列 `CONNECTION_RETRY_DELAYS_MS = [1_000, 3_000]` ms。
- **禁止重放边界**：一旦已收到响应头进入响应体或 SSE 读取阶段发生静默超时或中途断连，严禁重放请求，直接抛出 `E_MODEL_REQUEST_TIMEOUT` 或透传中断。

### 2.3 临时 HTTP 状态重试与 `Retry-After` 解析

- **触发状态集合**：`TEMPORARY_PROVIDER_STATUSES = new Set([429, 502, 503, 504, 529])`。
- **次数与延迟 (`providerRetryDelayMs`)**：
  - 最多重试 2 次（总计 3 次尝试）；重试前取消原响应体并等待退避时长（等待绑定 `outgoing.signal` 支持立即取消）。
  - 若响应携带有效 `Retry-After` 头（支持非负整数秒数，或晚于当前时间的 HTTP 日期字符串），按解析值等待；否则回退至 `PROVIDER_RETRY_DELAYS_MS = [2_000, 6_000]` ms；全量结果钳位在 `[0, PROVIDER_RETRY_MAX_WAIT_MS]`（上限 `20_000` ms）。
  - **非临时 HTTP 错误**（例如 `400`、`401`、`403`、`404`、`422`、`500`）从不重试。
- **发送门复验**：每次重试尝试（`attempt > 0`）均必须重新通过 `guardSend(run, attempt)`（在 `MainMemoryRun` 中即重新调用 `invokeClaimedRequest(..., attempt > 0)`），若门控拒绝则立即终止，禁止绕过准入重发。

### 2.4 守卫测试与 `未覆盖` 清单

- **守卫测试**（`src/main/model/providers/prepared-model-call.test.ts`）：
  - `L91`: 响应前断连携带同一请求体最多重试 2 次；
  - `L110`: 响应头沉默先于总预算触发，重试后报出 `E_MODEL_REQUEST_TIMEOUT`；
  - `L125` / `L153`: 开始流式后沉默立即停止且不重放，字节持续到达时不中断长流；
  - `L166` / `L180` / `L194` / `L241` / `L249`: `429` / `503` 重试、`Retry-After` 秒数/日期解析及 20s 上限封顶、过载耗尽后放弃、客户端错误（如 400）从不重试、已收到响应头/厂商报错不再重试；
  - `L227`: 每次重试均再次经过 `guardSend`（`src/main/agent/memory-runtime/main-memory-runtime.test.ts` 同样校验重发准入）。
- **未覆盖子项**：
  - `TEMPORARY_PROVIDER_STATUSES` 中 `502`、`504`、`529` 各自独立的单测覆盖标记为 **未覆盖**（当前 `prepared-model-call.test.ts` 用例直接验证了 `429` 与 `503`；502/504/529 在集合定义中但未逐一单测）；
  - 首包前断连等待分支（`setTimeout` 1000/3000 ms）在等待期间被 `AbortSignal` 立即中断的测试断言 **未覆盖**（源码 `L332` 使用了未绑定 `signal` 的 `setTimeout`，与 HTTP 状态重试调用 `pause(wait, outgoing.signal)` 不同）。

---

## 3. 能力显式拒识语义回退

1. **流式不支持回退至非流式（`chat-loop.ts`、`agent-loop-llm.ts`）**
   - **触发前提**：尚未收到任何非空 `text_delta` / `reasoning_delta`（`!partial` / `!receivedDelta`），且满足 `isExplicitStreamUnsupported(error)`（`src/main/model/providers/stream-support.ts`）或记忆边界抛出的 `MEMORY_CONTEXT_STREAM_UNSUPPORTED`（`main-memory-runtime.ts` 要求 HTTP `400` 或 `422` + 拒绝文本匹配）。
   - **行为**：仅回退执行一次 `stream: false` 非流式调用并保留原 cache hints；若已接收过任一非空片段，严禁回退或重试，直接向上抛错。
   - **守卫测试**：`src/main/agent/loop/agent-loop-llm.test.ts`（显式不支持流式回退、含 `text_delta` / `reasoning_delta` 后绝不重试、经 `memoryRun` 重抓非流式快照）、`src/main/agent/loop/agent-loop-llm-http-errors.test.ts`、`src/main/agent/runtime/chat-loop.test.ts`。
2. **图像直发失败转述回退（`src/main/agent/runtime/chat-loop.ts`）**
   - **行为**：纯 Chat 模式下，当首轮直发失败、未输出过任何 delta、未被取消、配置了 `imageCaptionFallback` 且未发生与图片无关的记忆边界拒识（仅允许无 `memoryRun` 或 `MEMORY_CONTEXT_IMAGE_UNSUPPORTED`）时，允许降级转述后再调用一次 `requestWithFallback`。
   - **守卫测试**：`src/main/agent/runtime/chat-loop.test.ts`。

---

## 4. 其他子系统的分离重试约束

- **后台 LLM 队列 `enqueueLLMTask`（`src/main/model/queue/llm-queue.ts`）**：支持 `retryRateLimit` 开关；当 `retryRateLimit: false` 时，遇 429 限流只调用 1 次即原样拒绝，由 `src/main/model/queue/llm-queue.test.ts` 守卫（`retryRateLimit: true` 分支在该 20 行单测文件中 **未覆盖**）。
- **工具调用重试（`src/main/agent/loop/tool-round.ts`、`retry-policy.ts`）**：按 `ToolErrorCategory` × `SideEffectKind` 控制工具级重试（如非幂等副作用 `non_idempotent_side_effect` 永不重试），由 `src/main/agent/loop/retry-policy.test.ts` 与 `src/main/agent/loop/tool-round-retry.test.ts` 守卫，独立于模型 HTTP 重试链路。
- **前端终态快照写盘重试（`src/renderer/react/features/chat/pages/run/AgentRunController.ts`）**：`persistTerminal()` 最多 3 次尝试，失败退避 `[100, 300]` ms，由 `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts` 守卫。
