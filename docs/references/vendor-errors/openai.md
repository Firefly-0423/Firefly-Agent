# OpenAI（ChatGPT）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 OpenAI 响应体 `error.code` / `error.type` 实现专属细分映射（相关计划 `docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下先说明 Firefly 代码中实际落地的适配与收口链路，再概括 OpenAI 常见 HTTP 错误语义，**具体状态码与错误定义以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "chatgpt"` / `displayName: "ChatGPT（OpenAI）"` / 短名 `"ChatGPT"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 默认协议与可选协议 | 默认 `"responses"`，支持 `["openai", "responses"]` | `src/main/model/providers/capabilities.ts`、`src/main/model/providers/transport-detector.ts` |
| 默认 Base URL 与端点 | `https://api.openai.com/v1`；`responses` 追加 `/responses`，`openai` 追加 `/chat/completions` | `src/main/model/providers/capabilities.ts`、`src/shared/api-endpoint.ts` |
| 认证方式 | `authStyle: "bearer"`（`Authorization: Bearer <apiKey>`） | `src/main/model/providers/auth.ts` |
| 预设与默认模型 | `defaultModel: ""`；预设 `mainModels: ["gpt-6-astra", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存特征 | `thinkingField: "reasoning_content"`、`cacheStrategy: "auto"`、`responsesEncryptedReasoning: true` | `src/main/model/providers/capabilities.ts` |

---

## 2. HTTP 与错误到 Firefly 错误码映射

### 2.1 当前代码实装映射链路

| 故障触发情景 | 主进程分类结果 | 经 `MainMemoryRun` / `AgUiBridge` 后的公开错误码 | `errorSource` | 源码依据 |
|---|---|---|---|---|
| `429` / `502` / `503` / `504` / `529` 且重试用尽 | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 持久化对话非 `sent` 返回多收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`；直接调用 / `temporary` 等经 `publicRunFailure` 为 `E_MODEL_REQUEST_FAILED`（若回落 `"runtime"` 为 `E_HARNESS_FAILURE`） | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts`、`src/shared/run-failure.ts` |
| 非临时 HTTP 错误（如 `400`、`401`、`403`、`404`、`422`） | `AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型请求失败：HTTP <status>")` | 同上（不自动重试；仅 `classifyRunError` 记录主进程 `httpStatus` 日志，不透传给前端） | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/runtime/firefly-agent.ts` |
| 首包前或流读取空闲超时（120s / 300s）或单次调用截止时间耗尽 | `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")` | `E_MODEL_REQUEST_TIMEOUT` | `model` | `src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts` |
| Socket/TLS/DNS 中断（无数字 HTTP `status`） | `AgentRuntimeError("E_MODEL_CONNECTION_LOST")` | `E_MODEL_CONNECTION_LOST` | `model` | `src/main/model/providers/connection-lost.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| Responses SSE 收到 `error` / `response.failed` 事件 | `ProviderProtocolError("E_UNSUPPORTED_STREAM_EVENT", msg)` | `publicRunFailure(..., "model")` 收敛为 `E_MODEL_REQUEST_FAILED`；经 `agui-bridge` 默认收口为 `E_HARNESS_FAILURE` | `model` / `runtime` | `src/main/model/providers/sdk-stream/responses-normalizer.ts`、`src/shared/run-failure.ts` |
| Responses 终态缺失或工具调用未闭合 | `E_STREAM_TERMINAL_MISMATCH` / `E_TOOL_CALL_INCOMPLETE` / `E_TOOL_CALL_ID_CHANGED` | 同上 | `model` / `runtime` | `src/main/model/providers/sdk-stream/runtime.ts`、`src/main/model/providers/sdk-stream/responses-normalizer.ts` |
| 设置页拉取模型 `/models` 失败 / 测试连接失败 | `fetchVendorModels`: `HTTP_<status>` / `NETWORK` / `TIMEOUT` / `BAD_RESPONSE`；`testConnection`: `MODEL_CONNECTION_TEST_FAILED` / `MODEL_CONNECTION_TEST_ERROR` | 仅用于设置页接口响应，不进入聊天运行 | — | `src/main/model/config/fetch-vendor-models.ts`、`src/main/model/config/model-connection-state.ts`、`src/main/model/providers/responses-adapter.ts` |

### 2.2 常见厂商 HTTP 语义概括（以供应商最新文档为准）

- **`400` / `422`（请求或参数无效）**：通常表示请求参数（例如不支持的 `reasoning.effort` 档位、无效的模型名、上下文超长、禁用参数组合）格式或语义不符合接口要求，以供应商最新文档为准。
- **`401` / `403`（鉴权或访问受限）**：通常表示 API Key 缺失、失效、权限不足，或受所在地区/组织策略限制，以供应商最新文档为准。
- **`404`（资源未找到）**：通常表示所填 Base URL 与协议路径不匹配，或目标模型对当前账号不可见，以供应商最新文档为准。
- **`429`（速率或配额受限）**：通常表示触发 RPM/TPM 限流或账户余额/配额耗尽，部分响应会附带 `Retry-After` 头，以供应商最新文档为准。
- **`500` / `502` / `503` / `504`（服务端或网关故障）**：通常表示上游服务内部异常、短暂过载或网关超时，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **SDK 重试关闭**：`deriveResponsesClientConfig` 与 `deriveOpenAIClientConfig` 均配置 `maxRetries: 0`（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输自动重试**（`src/main/model/providers/prepared-model-call.ts`）：
  - 响应头到来前的断连或 120s 空闲超时：最多重试 2 次（延迟 `[1_000, 3_000]` ms）。
  - HTTP `429` / `502` / `503` / `504` / `529`：最多重试 2 次，优先按 `Retry-After` 等待，缺省使用 `[2_000, 6_000]` ms，上限 `20_000` ms。
- **能力回退**：仅当 400/422 明确提示不支持流式且尚未输出 delta 时，`chat-loop.ts` 与 `agent-loop-llm.ts` 自动回退 `stream: false`。

---

## 4. UI 错误提示

由 `AgentRunController.ts`（`src/renderer/react/features/chat/pages/run/AgentRunController.ts`）与 `src/renderer/react/i18n/zh-CN.json` 映射：
- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`（`"网络连接中断，流萤没收到模型的回复。可能是网络或代理不稳定，稍后重新发送就好。（E_MODEL_CONNECTION_LOST）"`）
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`（`"模型太久没有回应，已经停止等待。稍后再试一次吧。（E_MODEL_REQUEST_TIMEOUT）"`）
- 其余 `source === "model"`（如 `E_MODEL_REQUEST_FAILED`）→ `chatPage.errorModelRequestFailedWith`（`"模型请求失败：<code>"`）
- 上下文边界报错（如 `MEMORY_CONTEXT_SEND_UNKNOWN`）→ `chatPage.errorContextFailedWith`（`"上下文处理失败：<code>"`）
- 设置页 `/models` 拉取遇 401/403 等映射至 `settings.panel.api.field.model.fetch.unauthorized` / `http` / `timeout` / `network`（`src/renderer/settings/i18n/zh-CN.json`）。

---

## 5. 厂商专属适配与边界处理

1. **Responses 协议映射与加密推理**（`src/main/model/providers/responses-adapter.ts`）：
   - `ResponsesAdapter.buildRequest` 固定设置 `store: false`，并把 `applyReasoningPreference` 生成的 `reasoning_effort` / `output_config.effort` / `thinking` 统一改写为 `reasoning: { effort }` 后删除旧字段。
   - 仅当 `capability.responsesEncryptedReasoning === true` 且 `isOfficialOpenAIEndpoint(cfg.baseUrl)` 为真（`api.openai.com` 或 `*.openai.com`）时，注入 `include: ["reasoning.encrypted_content"]` 并在历史消息中保留 `encryptedReasoningItems`。自定义中转/代理地址不会收到 `include: ["reasoning.encrypted_content"]`。
2. **模型级推理规则**（`src/shared/reasoning.ts`）：
   - `^gpt-6` 支持 `["low", "medium", "high", "xhigh", "max"]`（默认 `medium`，`supportsDisable: false`）；`^gpt-5\.6` 同档位但允许关闭（`supportsDisable: true`）；`^gpt-5` 支持 `["minimal", "low", "medium", "high"]`；`^o1` / `^o3` 支持 `["low", "medium", "high"]`；`^o4` 支持 `["medium", "high"]`。
3. **图像输入匹配与流式增量归一**（`src/main/model/providers/model-modalities.catalog.ts`、`sdk-stream/responses-normalizer.ts`）：
   - 内置型录匹配 `^gpt-(?:4o|4\.1|5|6)(?:$|[-.])`。
   - `responses-normalizer.ts` 支持 `response.output_text.delta`、`response.reasoning_text.delta` / `response.reasoning_summary_text.delta`、`response.function_call_arguments.*`，并在 `runtime.ts` 中对未收到显式结束事件的工具调用兜底闭合。
4. **身份识别**（`src/main/model/providers/request-provider-identity.ts`）：精确识别 `https://api.openai.com/v1` 为 `"openai"` 家族。
