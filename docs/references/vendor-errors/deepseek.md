# DeepSeek（深度求索）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 DeepSeek 的细分错误码做独立分支映射（相关计划 `docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下先列出现有代码中的适配、错误收敛与回退行为，再概括 DeepSeek 常见 HTTP 错误语义，**以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "deepseek"` / `displayName: "DeepSeek（深度求索）"` / 短名 `"DeepSeek"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 默认协议与可选协议 | 默认 `"openai"`，支持 `["openai", "anthropic", "responses"]` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL / Anthropic 地址 | `https://api.deepseek.com`；预设 `anthropicBaseUrl: "https://api.deepseek.com/anthropic"` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证方式 | 默认 `authStyle: "bearer"`；走 `anthropic` 协议时使用 `anthropicAuthStyle: "x-api-key"` | `src/main/model/providers/capabilities.ts`、`src/main/model/providers/auth.ts`、`sdk-stream/runtime.ts` |
| 预设与默认模型 | `defaultModel: "deepseek-flash"`；预设 `mainModels: ["deepseek-flash", "deepseek-v4-pro"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存特征 | `thinkingField: "reasoning_content"`、`cacheStrategy: "auto"` | `src/main/model/providers/capabilities.ts` |

---

## 2. HTTP 与错误到 Firefly 错误码映射

### 2.1 当前代码实装映射链路

| 故障触发情景 | 主进程分类结果 | 最终公开错误码 (`publicRunFailure`) | `errorSource` | 源码依据 |
|---|---|---|---|---|
| `429` / `502` / `503` / `504` / `529` 重试用尽 | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 持久化对话 `context.dispatch` 非 `sent` 时多收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`；直接调用 / `temporary` 经 `publicRunFailure` 为 `E_MODEL_REQUEST_FAILED` 或 `E_HARNESS_FAILURE` | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts` |
| 其他 HTTP 错误（`400`、`401`、`402`、`403`、`404`、`422`） | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 同上（注意：`402` 不属于 `TEMPORARY_PROVIDER_STATUSES`，不会自动重试） | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts` |
| 响应头 120s / 流读取 300s / 请求截止超时 | `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")` | `E_MODEL_REQUEST_TIMEOUT` | `model` | `src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 底层网络断连 | `AgentRuntimeError("E_MODEL_CONNECTION_LOST")` | `E_MODEL_CONNECTION_LOST` | `model` | `src/main/model/providers/connection-lost.ts` |
| 流式工具调用 ID 变化/缺失 | `ProviderProtocolError` | 经 `"model"` 兜底为 `E_MODEL_REQUEST_FAILED`；经默认收口为 `E_HARNESS_FAILURE` | `model` / `runtime` | `src/main/model/providers/sdk-stream/accumulator.ts` |

### 2.2 常见厂商 HTTP 语义概括（以供应商最新文档为准）

- **`400` / `422`**：通常表示请求参数、JSON 格式、上下文长度或思考模式下不兼容的工具调用参数存在问题，以供应商最新文档为准。
- **`401`**：通常表示 API Key 鉴权失败或已失效，以供应商最新文档为准。
- **`402`**：在部分厂商接口中通常表示账户余额不足或付费配额用尽，以供应商最新文档为准。
- **`404` / `429`**：`404` 通常为模型名或接入路径错误；`429` 通常为请求并发或速率超过限制，以供应商最新文档为准。
- **`500` / `503`**：通常表示服务端内部错误或高负载繁忙（DeepSeek 流式接口有时可能通过保活空行等待，Firefly 300s 流空闲窗口决定超时门限），以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：无论选择 OpenAI Chat Completions、Anthropic 还是 Responses 协议，底层 SDK 均固定 `maxRetries: 0`（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。
- **流式不支持回退**：满足 `400`/`422` + `isExplicitStreamUnsupported` 且零 delta 时，回退 `stream: false`（`src/main/agent/runtime/chat-loop.ts`、`src/main/agent/loop/agent-loop-llm.ts`）。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- 其余模型失败（`E_MODEL_REQUEST_FAILED` 等）→ `chatPage.errorModelRequestFailedWith`
- 上下文侧报错（如 `MEMORY_CONTEXT_SEND_UNKNOWN`）→ `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **思考模式下严禁发送 `tool_choice`**（`src/main/model/providers/tool-choice-policy.ts`）：
   - 当 `providerId === "deepseek"` 且 `mayThink(request)` 为真时，无论是 `resolveAutomaticToolChoicePolicy` 还是 `resolveToolChoicePolicy` 都返回 `"omit"`（完全不下发 `tool_choice` 字段），以规避推理状态与强制工具选择的接口报错。
2. **思考能力与参数规则**（`src/shared/reasoning.ts`、`src/main/model/providers/reasoning.ts`）：
   - `^deepseek-(?:v4|flash)`：`control: "toggle-effort"`，档位 `["high", "max"]`，默认/自动档位 `"high"`，`requestStyle: "thinking-type"`，`supportsDisable: true`；启用思考时发送 `thinking: { type: "enabled" }` 与 `reasoning_effort`，关闭时发送 `thinking: { type: "disabled" }`。
   - `^deepseek-(chat|reasoner)$`：显式标记 `control: "none"`（不额外注入思考控制参数，由模型 ID 自身决定行为）。
3. **图像能力范围限定为 DeepSeek 厂商**（`src/main/model/providers/model-modalities.catalog.ts`）：
   - `{ vendor: "deepseek", pattern: "^(?:deepseek-)?(?:v4-)?flash(?:$|-)" }` 将 `flash` / `deepseek-flash` / `v4-flash` 的多模态匹配严格限定在 `vendor: "deepseek"` 下，避免与其他厂商同名 `flash` 模型混淆。
4. **Anthropic 协议兼容路径固定**（`src/main/model/providers/sdk-stream/client-config.ts`）：
   - 当切到 `anthropicBaseUrl: "https://api.deepseek.com/anthropic"` 时，路径末尾并非 `/v1/messages`（而是 `/anthropic/v1/messages`），`deriveAnthropicClientConfig` 会自动挂载 `createEndpointPinnedFetch` 确保请求精确发往拼接后的终端地址，并应用 `anthropicAuthStyle: "x-api-key"`。
