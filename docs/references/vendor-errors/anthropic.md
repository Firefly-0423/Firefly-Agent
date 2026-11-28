# Anthropic（Claude）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未按 Anthropic 响应体中的 `error.type`（如 `overloaded_error`、`rate_limit_error`）做专属二次拆分（相关计划 `docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下记录 Firefly 当前已实装的公共错误映射与 Anthropic 专属协议处理，**具体接口与状态码含义以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "claude"` / `displayName: "Claude（Anthropic）"` / 短名 `"Claude"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 协议支持 | 仅支持 `"anthropic"` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL 与端点 | `https://api.anthropic.com/v1`；已 `/v1` 结尾追加 `/messages`，否则 `/v1/messages` | `src/main/model/providers/capabilities.ts`、`src/shared/api-endpoint.ts` |
| 认证与固定版本头 | `authStyle: "x-api-key"`；请求固定附带 `anthropic-version: "2023-06-01"` | `src/main/model/providers/auth.ts`、`src/main/model/providers/anthropic-adapter.ts`、`src/main/model/config/fetch-vendor-models.ts` |
| 预设与默认模型 | `defaultModel: "claude-sonnet-4-6"`；预设 `mainModels: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存特征 | `thinkingField: "thinking"`、`cacheStrategy: "cache_control"` | `src/main/model/providers/capabilities.ts` |

---

## 2. HTTP 与错误到 Firefly 错误码映射

### 2.1 当前代码实装映射链路

| 故障触发情景 | 主进程分类结果 | 最终公开错误码 (`publicRunFailure`) | `errorSource` | 源码依据 |
|---|---|---|---|---|
| `429` / `502` / `503` / `504` / `529` 重试用尽 | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 持久化对话非 `sent` 多收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`；直连 / `temporary` 经 `publicRunFailure` 为 `E_MODEL_REQUEST_FAILED` 或 `E_HARNESS_FAILURE` | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts` |
| 其他 HTTP 非 2xx（`400`、`401`、`403`、`404`、`413`、`422`） | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 同上（主进程 `classifyRunError` 记录 `httpStatus` 诊断日志） | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/runtime/firefly-agent.ts` |
| 120s 响应头超时 / 300s 流空闲 / 请求截止超时 | `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")` | `E_MODEL_REQUEST_TIMEOUT` | `model` | `src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 底层网络连接中断 (`CONNECTION_LOST_CODES`) | `AgentRuntimeError("E_MODEL_CONNECTION_LOST")` | `E_MODEL_CONNECTION_LOST` | `model` | `src/main/model/providers/connection-lost.ts` |
| Anthropic `finalMessage` 校验不一致或工具调用缺 `id` / 缺闭合 | `ProviderProtocolError("E_STREAM_TERMINAL_MISMATCH" \| "E_TOOL_CALL_INCOMPLETE")` | 经 `"model"` 兜底为 `E_MODEL_REQUEST_FAILED`；经默认收口为 `E_HARNESS_FAILURE` | `model` / `runtime` | `src/main/model/providers/sdk-stream/anthropic-normalizer.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| `fetchVendorModels` 查询 `/v1/models?limit=1000` 失败 | `HTTP_<status>` / `NETWORK` / `TIMEOUT` / `BAD_RESPONSE` | 设置页专用错误，不进聊天主流程 | — | `src/main/model/config/fetch-vendor-models.ts` |

### 2.2 常见厂商 HTTP 语义概括（以供应商最新文档为准）

- **`400` / `422`**：常见于请求体不合规（例如开启自适应思考时未遵守 `tool_choice` 限制、请求关闭受限模型思考、不支持的图片 MIME 或 `max_tokens` 与思考预算冲突），以供应商最新文档为准。
- **`401` / `403`**：常见于 `x-api-key` 无效、被吊销或工作区权限/区域访问受限，以供应商最新文档为准。
- **`404` / `413`**：`404` 通常为模型 ID 或端点路径不正确；`413` 通常表示单次请求体过大，以供应商最新文档为准。
- **`429` / `529`**：`429` 通常对应并发、TPM/RPM 或额度限流（可能携带 `Retry-After`）；`529` 通常表示服务临时过载，两者均在 Firefly 的 `TEMPORARY_PROVIDER_STATUSES` 重试集合内，以供应商最新文档为准。
- **`500` / `502` / `503` / `504`**：通常表示服务端内部错误、网关故障或上游暂时不可用，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：`deriveAnthropicClientConfig`（`src/main/model/providers/sdk-stream/client-config.ts`）禁用 `@anthropic-ai/sdk` 自带重试。
- **传输重试**（`src/main/model/providers/prepared-model-call.ts`）：
  - `429`、`502`、`503`、`504` 与 Anthropic 常见过载码 `529` 均位于 `TEMPORARY_PROVIDER_STATUSES`，首包前最多重试 2 次（优先 `Retry-After`，否则 `[2_000, 6_000]` ms，上限 `20_000` ms）。
  - 首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次。
- **图片转述不可回退**：因主模型协议为 `anthropic`，`resolveCaptionVisionConfig`（`src/main/model/vision/image-router.ts`）显式禁止复用主模型地址做视觉转述（若强制关闭直发将直接提示用户切换模型）。

---

## 4. UI 错误提示

`AgentRunController.ts` 按 `publicRunFailure` 呈现：
- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` → `chatPage.errorModelRequestFailedWith`（`"模型请求失败：E_MODEL_REQUEST_FAILED"`）
- `MEMORY_CONTEXT_SEND_UNKNOWN` → `chatPage.errorContextFailedWith`（`"上下文处理失败：MEMORY_CONTEXT_SEND_UNKNOWN"`）

---

## 5. 厂商专属适配与边界处理

1. **自适应思考规则 (`anthropic-adaptive`)**（`src/shared/reasoning.ts`、`src/main/model/providers/reasoning.ts`）：
   - 生成 `thinking: { type: "adaptive" }` 与 `output_config: { effort }`（关闭时下发 `thinking: { type: "disabled" }`）。
   - `^claude-fable-5`（默认 `high`）与 `^claude-opus-5-5`（默认 `medium`）标记为 `disableRejected: true` / `supportsDisable: false`，不可下发关闭思考。
   - `^claude-sonnet-5-5` 标记为 `offThinking: "between_tools"`；`^claude-opus-5`、`^claude-haiku-5-5`、`^claude-sonnet-5`、`^claude-opus-4-(8|7|6)`、`^claude-sonnet-4-6` 均支持自适应思考并允许关闭。
2. **思考态与 `tool_choice` 互斥保护**（`src/main/model/providers/tool-choice-policy.ts`、`anthropic-adapter.ts`）：
   - 当 `transport === "anthropic"` 且推理可能开启时，`resolveToolChoicePolicy` 自动将指定工具名称 `"named"` 降级为 `"auto"`（避免触发 Anthropic 对强行指定工具与 thinking 互斥的 400 拒绝）。
3. **提示词缓存断点 (`cache_control`)**（`src/main/model/providers/anthropic-adapter.ts`）：
   - `system` 块固定附带 `cache_control: { type: "ephemeral" }`。
   - 历史消息数组最后 2 条附带消息级 `ephemeral` 断点（`supportsMessageCacheBreakpoint` 对 `claude` 全系列返回 `true`）。
4. **流式与终态双通道校验 (`reconcileAnthropicTerminal`)**（`src/main/model/providers/sdk-stream/anthropic-normalizer.ts`、`runtime.ts`）：
   - 实时流式推送文本与可见思考（主动过滤签名字段）；流结束后向 SDK 请求 `finalMessage()`，校验工具调用块是否齐全且无未闭合 ID，若发现终态摘要不一致发出 `StreamDiagnostic` 或抛出 `E_TOOL_CALL_INCOMPLETE` / `E_STREAM_TERMINAL_MISMATCH`。
5. **多模态图片与结构化输出**（`src/main/model/providers/anthropic-adapter.ts`、`model-modalities.catalog.ts`、`agent-loop-llm.ts`）：
   - 型录正则 `^claude-` 识别支持图像；`toAnthropicContent` 仅放行 `image/png`、`image/jpeg`、`image/webp`、`image/gif` 或 HTTP URL，其他图片 MIME 降级为文本。
   - `AnthropicAdapter.buildRequest` 默认 `max_tokens: 4096`（`callLLM` 与 `summarizeHistory` 显式传 `32768`，除非 `disableMaxToken` 开启）；结构化输出映射到 `output_config.format`；`fetchVendorModels` 读取 Anthropic `/v1/models` 中的 `capabilities.image_input.supported` 与 `display_name`。
