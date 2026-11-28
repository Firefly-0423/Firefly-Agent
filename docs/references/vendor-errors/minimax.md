# MiniMax（稀宇科技）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 MiniMax 响应体内部错误码（如 `base_resp`）做专属拆分映射（`docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下先说明 Firefly 代码实装映射，再概括常见 HTTP 错误语义，**以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "minimax"` / `displayName: "MiniMax（稀宇科技）"` / 短名 `"MiniMax"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 默认协议与可选协议 | 默认 `"anthropic"`，支持 `["anthropic", "openai", "responses"]` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL / Anthropic 地址 | 能力默认 `https://api.minimaxi.com/anthropic`；预设 `baseUrl: "https://api.minimaxi.com/v1"`、`anthropicBaseUrl: "https://api.minimaxi.com/anthropic"` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证方式 | 默认 `authStyle: "bearer"`；走 `anthropic` 协议时使用 `anthropicAuthStyle: "x-api-key"` | `src/main/model/providers/capabilities.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 预设与默认模型 | `defaultModel: "MiniMax-M3"`；预设 `mainModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存 / 视觉字段 | `thinkingField: "thinking"`、`cacheStrategy: "cache_control"`、`visionBaseUrl: "https://api.minimaxi.com/v1"` | `src/main/model/providers/capabilities.ts` |

---

## 2. HTTP 与错误到 Firefly 错误码映射

### 2.1 当前代码实装映射链路

| 故障触发情景 | 主进程分类结果 | 最终公开错误码 (`publicRunFailure`) | `errorSource` | 源码依据 |
|---|---|---|---|---|
| `429` / `502` / `503` / `504` / `529` 重试用尽 | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 持久化对话非 `sent` 多收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`；直接调用 / `temporary` 经 `publicRunFailure` 为 `E_MODEL_REQUEST_FAILED` 或 `E_HARNESS_FAILURE` | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts` |
| 其他 HTTP 错误（`400`、`401`、`403`、`404`、`422`） | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 同上 | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts` |
| 响应头 120s / 流读取 300s / 请求截止超时 | `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")` | `E_MODEL_REQUEST_TIMEOUT` | `model` | `src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 底层网络连接中断 | `AgentRuntimeError("E_MODEL_CONNECTION_LOST")` | `E_MODEL_CONNECTION_LOST` | `model` | `src/main/model/providers/connection-lost.ts` |
| Anthropic `finalMessage` 校验不一致 / 缺 tool ID | `ProviderProtocolError` (`E_STREAM_TERMINAL_MISMATCH` / `E_TOOL_CALL_INCOMPLETE`) | 经 `"model"` 兜底为 `E_MODEL_REQUEST_FAILED`；经默认收口为 `E_HARNESS_FAILURE` | `model` / `runtime` | `src/main/model/providers/sdk-stream/anthropic-normalizer.ts` |

### 2.2 常见厂商 HTTP 语义概括（以供应商最新文档为准）

- **`400` / `422`**：通常表示请求体不合法、模型名与协议路径不匹配、思考或工具参数不受支持或输入越界，以供应商最新文档为准。
- **`401` / `403`**：通常表示密钥无效、认证头格式错误（Anthropic 端点需 `x-api-key`）或账户配额受限，以供应商最新文档为准。
- **`404` / `429`**：`404` 通常为协议端点拼接不匹配或模型不可用；`429` 通常为请求速率或并发配额达到限制，以供应商最新文档为准。
- **`500` / `502` / `503` / `504` / `529`**：通常表示服务端内部错误或高负载繁忙，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：无论采用 Anthropic、OpenAI 还是 Responses 协议，SDK 层均关闭自动重试（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。
- **Anthropic 非标准端点固定**：默认端点 `https://api.minimaxi.com/anthropic` 拼接 `/v1/messages` 后路径为 `/anthropic/v1/messages`，`deriveAnthropicClientConfig` 通过 `createEndpointPinnedFetch` 确保请求不会丢失 `/anthropic` 前缀（`src/main/model/providers/sdk-stream/client-config.ts`、`sdk-stream/provider-contracts.test.ts`）。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` 等 `model` 错误 → `chatPage.errorModelRequestFailedWith`
- `MEMORY_CONTEXT_SEND_UNKNOWN` 等 `context` 错误 → `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **`cache_control` 消息级缓存断点差异**（`src/main/model/providers/anthropic-adapter.ts`）：
   - `supportsMessageCacheBreakpoint(vendorId, model)` 针对 `vendorId === "minimax"` 且型号以 `MiniMax-M3` 开头时返回 `false`，仅保留 `system` 块上的 `cache_control: { type: "ephemeral" }`；`MiniMax-M2.x` 则同时在倒数两条消息上写入 `cache_control` 断点。
2. **模型推理规则**（`src/shared/reasoning.ts`）：
   - `^MiniMax-M3`：`control: "toggle"`、`requestStyle: "anthropic-adaptive"`、`supportsDisable: true`（映射为 `thinking: { type: "adaptive" | "disabled" }`）。
   - `^MiniMax-M2\.`：`control: "fixed-on"`、`requestStyle: "none"`。
3. **工具选择与伪工具标记清理**：
   - `resolveToolChoicePolicy` 对 `providerId === "minimax"` 始终将指定工具模式收敛为 `"auto"`（`src/main/model/providers/tool-choice-policy.ts`）。
   - `chat-loop.ts` 的 `stripToolProtocol` 在纯聊天回复后处理中显式剥离 `"]<]minimax[>["` 控制哨兵标记（`src/main/agent/runtime/chat-loop.ts`）。
4. **视觉输入边界**：
   - 型录规则 `^MiniMax-M3(?:$|[-_])` 启用 `MiniMax-M3` 图像输入，而 `MiniMax-M2.x` 默认判为不支持图片（`src/main/model/providers/model-modalities.catalog.ts`）。
   - 尽管 `PROVIDER_CAPABILITIES` 登记了 `visionBaseUrl: "https://api.minimaxi.com/v1"`，当前 `resolveCaptionVisionConfig` 统一按 `explicitTransport !== "anthropic"` 判断；当主模型走默认的 `anthropic` 协议时，独立图片转述会被显式拒绝并提示切换协议（`src/main/model/vision/image-router.ts`）。
