# 模型服务故障分类与错误码映射规范（现状实装基线）

状态：已实现规范（核验日期 2026-11-16）

> **范围说明**：本文档仅规范当前仓库已实现且有单元测试或集成测试守卫的错误分类与公开错误码映射行为。按厂商响应体 `error.code` / `error.type` 细分子类的规划（`docs/superpowers/plans/model-error-classification.md`）当前状态为 `未开工`，不属于本规范约束范围。

---

## 1. 错误类型与数据结构

1. **`AgentRuntimeError`（`src/main/model/errors/agent-runtime-error.ts`）**
   - 公开错误码联合类型 `AgentErrorCode` 固定为 7 个枚举值：
     `E_MODEL_RESPONSE_PARSE_FAILED`、`E_MODEL_HTTP_ERROR`、`E_MODEL_REQUEST_TIMEOUT`、`E_MODEL_REQUEST_FAILED`、`E_MODEL_CONNECTION_LOST`、`E_AGENT_GRAPH_ITERATION_LIMIT`、`E_AGENT_NO_PROGRESS`。
   - 实例继承 `Error`，设置 `name = "AgentRuntimeError"`，并保留只读 `code` 与可选 `cause`（`{ cause }` 未传入时 `cause === undefined`）。
   - **守卫测试**：`src/main/model/errors/agent-runtime-error.test.ts`（断言全部 7 个代码保持、`instanceof Error` 及 `cause` 默认值）。

2. **`ProviderProtocolError`（`src/main/model/providers/sdk-stream/types.ts`）**
   - 流式协议层错误码 `ProviderProtocolErrorCode` 为：`E_UNSUPPORTED_STREAM_EVENT`、`E_STREAM_TERMINAL_MISMATCH`、`E_TOOL_CALL_INCOMPLETE`、`E_TOOL_CALL_ID_CHANGED`。

3. **跨进程公开错误描述符 `RunFailure`（`src/shared/run-failure.ts`）**
   - `RunFailureSource = "runtime" | "context" | "model" | "tool"`。
   - `sources` 注册表将每个已知公开码绑定到固定 `source`，各来源兜底码 `fallbackCodes` 为：
     - `"runtime"` → `"E_HARNESS_FAILURE"`
     - `"context"` → `"E_CONTEXT_FAILURE"`
     - `"model"` → `"E_MODEL_REQUEST_FAILED"`
     - `"tool"` → `"E_TOOL_EXECUTION_FAILED"`

---

## 2. 分层映射契约与守卫测试

### 2.1 底层断连识别与错误链日志脱敏

- **契约（`src/main/model/providers/connection-lost.ts`、`error-chain.ts`）**：
  - `connectionLost(error)` 沿 `.cause` 链最多检查 6 层：遇到数字类型的 `status` 属性立即返回 `false`（禁止将厂商 HTTP 错误误判为网络断连）；否则命中 `CONNECTION_LOST_CODES`（`ECONNRESET`、`ECONNREFUSED`、`ECONNABORTED`、`EPIPE`、`ETIMEDOUT`、`ENOTFOUND`、`EAI_AGAIN`、`UND_ERR_SOCKET`、`UND_ERR_CONNECT_TIMEOUT`、`UND_ERR_CLOSED`）返回 `true`。
  - `causeCodes(error)` 沿 `.cause` 最多 6 层仅提取符合 `/^[A-Z][A-Za-z]{0,40}$/` 的类名、数字 `status` 或符合 `/^(E[A-Z0-9_]{2,30}|UND_ERR_[A-Z_]{2,40})$/` 的系统错误码；严禁输出厂商 JSON 错误码或错误文本。
- **守卫测试**：
  - `src/main/model/providers/prepared-model-call.test.ts`（验证已开始接收响应或厂商返回 HTTP 错误时不判定为断连，仅真正丢连接才标记为断连）。
  - `src/main/model/providers/sdk-stream/runtime-cause-codes.test.ts`（验证 `APIConnectionError <- TypeError <- Error:ECONNRESET`、`BadRequestError:400` 保留，以及厂商 `code: "SYNTHETIC_SECRET_ERROR_CANARY"` 被剥离为 `"Error"`）。

### 2.2 传输层与流式 SDK 层分类

- **契约（`src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts`）**：
  - 响应头空闲超时（默认 120s）或流读取空闲超时（默认 300s）抛出 `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")`。
  - `nonStreaming` 收到 `!response.ok` 时抛出 `AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型请求失败：HTTP <status>", { cause })`（`cause` 带 `status` 与截断至 200 字符的 `body`）。
  - `runSdkStream` 捕获异常时按优先级判定：`deadlineExpired` → `E_MODEL_REQUEST_TIMEOUT`；`input.signal?.aborted` → 原样重抛取消错误；`ProviderProtocolError` / `AgentRuntimeError` → 原样保留；`connectionLost` → `E_MODEL_CONNECTION_LOST`；其余 → `E_MODEL_REQUEST_FAILED`。
  - 通过 `preparedFetch` 调度流式失败时，`prompt-dump` 仅写入 `{ error: code, raw: null }`，不落盘原始响应详情。
- **守卫测试**：
  - `src/main/model/providers/prepared-model-call.test.ts`（首包沉默超时代替总预算等待、非流式 HTTP 错误保留 `cause.status` 与安全日志、流解析协议错误透传）。
  - `src/main/model/providers/sdk-stream/runtime.test.ts`（仅自身 deadline 映射为 `E_MODEL_REQUEST_TIMEOUT`；外部取消原样保留）。
  - `src/main/model/providers/sdk-stream/responses-normalizer.test.ts` / `anthropic-normalizer.test.ts` / `accumulator.test.ts`（分别守卫 `E_UNSUPPORTED_STREAM_EVENT`、`E_TOOL_CALL_INCOMPLETE`、`E_STREAM_TERMINAL_MISMATCH`、`E_TOOL_CALL_ID_CHANGED` 的产生）。
- **未覆盖子项**：
  - `E_MODEL_HTTP_ERROR` 已写入 `AgentErrorCode`、`sources`、`classifyRunError` 且在 `agui-bridge.test.ts` / `agui-chat-failure.integration.test.ts` 中被手造注入验证过，但 `prepared-model-call.ts` 与 `sdk-stream/runtime.ts` 现网调用遇到非 2xx HTTP 状态实际仍抛出 `E_MODEL_REQUEST_FAILED`；`E_MODEL_HTTP_ERROR` 由真实传输层触发的路径 **未覆盖**。

### 2.3 记忆运行时边界层收敛

- **契约（`src/main/agent/memory-runtime/main-memory-runtime.ts`）**：
  - 非流式首包前命中 400/422 且匹配 `explicitStreamRejection` 转换为 `MEMORY_CONTEXT_STREAM_UNSUPPORTED`；带图且 400/422 匹配 `explicitImageRejection` 转换为 `MEMORY_CONTEXT_IMAGE_UNSUPPORTED`。
  - 持久化 `context.dispatch` 返回非 `"sent"` 时：`MEMORY_CONTEXT_STREAM_UNSUPPORTED`、`MEMORY_CONTEXT_IMAGE_UNSUPPORTED`、`E_MODEL_REQUEST_TIMEOUT`、`E_MODEL_CONNECTION_LOST` 按原码透传，其余发送阶段模型错误收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`。
  - `temporary` 模式与其他阶段进入 `safeFailure`：超时、断连与合法 `MEMORY_*` 码保留，其余折叠为调用点的 `fallback`（如 `MEMORY_CONTEXT_RUN_FAILED`）。
- **守卫测试**：
  - `src/main/agent/memory-runtime/main-memory-runtime.test.ts`（验证上下文预算、防篡改校验、`E_MODEL_REQUEST_TIMEOUT` / `E_MODEL_CONNECTION_LOST` 与非 `sent` 处理）。
- **未覆盖子项**：
  - 持久化 `context.dispatch` 遇到 `E_MODEL_REQUEST_FAILED` 时收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN` 后再经完整 `AgentRunController` 展示的端到端集成路径 **未覆盖**（仅在单元层与控制器各自测试分别覆盖）。

### 2.4 `publicRunFailure` 脱敏收口与 `AgUiBridge` 转发

- **契约（`src/shared/run-failure.ts`、`src/main/agent/runtime/firefly-agent.ts`、`src/main/agent/loop/agent-loop.ts`、`src/main/agent/runtime/adapter/terminal-mapper.ts`、`src/main/features/chat/agui-bridge.ts`）**：
  - `publicRunFailure(error, fallback)` 读取 `error.code` 或符合 `/^[A-Z][A-Z0-9_]{2,80}$/` 的 `error.message`，仅当命中 `sources` 注册表时输出对应 `{ code, source }`，其余全部按 `fallback` 折叠。
  - `agui-bridge.ts` 在发送 `RUN_ERROR` 前强制执行 `publicRunFailure`，使 `code` 与 `message` 字段同为脱敏枚举码，并附带 `errorSource`。
  - 当 `agent-loop.ts` 返回 `terminateReason === "error"` 时，经 `mapTerminateReasonToTerminal` 产出 `terminal: { status: "runtime_error", reason, errorSource }`，并由 `agui-bridge.ts` 拦截转为单一 `RUN_ERROR`。
- **守卫测试**：
  - `src/shared/run-failure.test.ts`（验证未知错误及私有码按各 `fallback` 折叠，注册码保持映射）。
  - `src/main/features/chat/agui-bridge.test.ts` 与 `src/main/features/chat/agui-chat-failure.integration.test.ts`（验证真实 `ChatLoop` → `FireflyAgent` → `AgUiBridge` 链条剥离 `"SYNTHETIC_PROVIDER_SECRET"`、`"HTTP 503"` 等原文，仅暴露安全 `code` 与 `errorSource`）。
  - `src/main/agent/runtime/adapter/terminal-mapper.test.ts`（验证 `mapTerminateReasonToTerminal` 错误映射与脱敏）。
- **未覆盖子项**：
  - `ProviderProtocolErrorCode`（如 `E_TOOL_CALL_INCOMPLETE`）未注册在 `sources` 中，经 `agent-loop.ts` 走 `"model"` 兜底会变为 `E_MODEL_REQUEST_FAILED`，若经 `agui-bridge.ts` 默认 `"runtime"` 再过滤会维持或折叠行为差异——`ProviderProtocolErrorCode` 贯穿 `agent-loop` → `agui-bridge` 的端到端集成断言 **未覆盖**；
  - `firefly-agent.ts` 中 `classifyRunError` 提取 `httpStatus` 诊断字段的单元测试 **未覆盖**。

---

## 3. 辅助路径分离错误码（非聊天主运行）

以下模块不经过 `publicRunFailure`，各自维护独立测试契约：
- **模型列表拉取**：`fetchVendorModels`（`src/main/model/config/fetch-vendor-models.ts`）产出 `"MISSING_BASE_URL"` | `"MISSING_API_KEY"` | `"NETWORK"` | `"TIMEOUT"` | `"BAD_RESPONSE"` | `` `HTTP_${number}` ``，由 `src/main/model/config/fetch-vendor-models.test.ts` 守卫。
- **连接测试状态**：`createModelConnectionState().test`（`src/main/model/config/model-connection-state.ts`）产出 `"MODEL_CONNECTION_TEST_FAILED"` / `"MODEL_CONNECTION_TEST_ERROR"`，由 `src/main/model/config/model-connection-state.test.ts` 与 `src/main/model/providers/test-connection.test.ts` 守卫。
- **结构化输出运行器**：`runStructuredOutput`（`src/main/model/structured/runner.ts`）内部 `requestFailure` 映射 `"MODEL_REQUEST_TIMEOUT"` / `"MODEL_HTTP_ERROR"` / `"MODEL_RESPONSE_PARSE_FAILED"` / `"MODEL_REQUEST_FAILED"`，由 `src/main/model/structured/runner.test.ts` 守卫。
