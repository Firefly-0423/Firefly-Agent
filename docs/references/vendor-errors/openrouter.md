# OpenRouter 错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 OpenRouter 上游透传错误或 `metadata` 做细分子码分类（`docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下先说明 Firefly 当前代码对 OpenRouter 的接入与错误收口逻辑，再概括网关常见 HTTP 状态语义，**以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "openrouter"` / `displayName: "OpenRouter"` / 短名 `"OpenRouter"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 协议支持 | 仅支持 `"openai"` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL | `https://openrouter.ai/api/v1` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证与身份标识 | `authStyle: "bearer"`；`requestProviderIdentity` 精确识别该地址为 `"openrouter"` | `src/main/model/providers/auth.ts`、`src/main/model/providers/request-provider-identity.ts` |
| 预设与默认模型 | `defaultModel: ""`；预设 `mainModels: []`（依赖 `/models` 拉取或手填，如 `vendor/model` 格式） | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存特征 | `thinkingField: "reasoning_details"`、`cacheStrategy: "auto"` | `src/main/model/providers/capabilities.ts` |

---

## 2. HTTP 与错误到 Firefly 错误码映射

### 2.1 当前代码实装映射链路

| 故障触发情景 | 主进程分类结果 | 最终公开错误码 (`publicRunFailure`) | `errorSource` | 源码依据 |
|---|---|---|---|---|
| `429` / `502` / `503` / `504` / `529` 重试用尽 | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 持久化对话非 `sent` 多收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`；直接调用 / `temporary` 经 `publicRunFailure` 为 `E_MODEL_REQUEST_FAILED` 或 `E_HARNESS_FAILURE` | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts` |
| 其他 HTTP 错误（`400`、`401`、`402`、`403`、`404`、`408`、`422`） | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 同上（注意：`402` 与 `408` 当前未列入 `TEMPORARY_PROVIDER_STATUSES`，不会自动重试） | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts` |
| 响应头 120s / 流读取 300s / 请求截止超时 | `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")` | `E_MODEL_REQUEST_TIMEOUT` | `model` | `src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 底层网络连接中断 | `AgentRuntimeError("E_MODEL_CONNECTION_LOST")` | `E_MODEL_CONNECTION_LOST` | `model` | `src/main/model/providers/connection-lost.ts` |

### 2.2 常见网关 HTTP 语义概括（以供应商最新文档为准）

- **`400` / `422`**：通常表示请求格式错误、上下文超长或下游目标模型不支持所传 `reasoning` 参数，以供应商最新文档为准。
- **`401` / `402` / `403`**：通常分别表示 OpenRouter API Key 无效、账户余额/信用额度不足，或触发内容审核/策略限制，以供应商最新文档为准。
- **`404` / `408` / `429`**：`404` 通常表示未找到所选路由模型；`408` 通常表示请求在网关侧等待超时；`429` 通常表示触发网关或上游路由限流，以供应商最新文档为准。
- **`502` / `503`**：在网关架构下常表示上游路由供应商返回坏网关或暂时没有可用提供方，两者均在 Firefly 的 `TEMPORARY_PROVIDER_STATUSES` 重试集合内，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：`deriveOpenAIClientConfig`（`src/main/model/providers/sdk-stream/client-config.ts`）禁用 OpenAI SDK 自带重试。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` 等 `model` 错误 → `chatPage.errorModelRequestFailedWith`
- `MEMORY_CONTEXT_SEND_UNKNOWN` 等 `context` 错误 → `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **统一 `reasoning: { effort }` 转换与隔离**（`src/shared/reasoning.ts`、`src/main/model/providers/reasoning.ts`）：
   - `MODEL_REASONING_RULES` 中对 `vendor: "openrouter"` 配置了通配规则 `/.*/` 并标记 `ownProviderOnly: true`（仅当提供商为 OpenRouter 时生效，防止其他自定义端点误用），支持 `["low", "medium", "high", "max"]`，默认 `"medium"`，`requestStyle: "openrouter-reasoning"`，`supportsDisable: true`。
   - `applyReasoningPreference` 将 Firefly 档位 `"max"` 转为 OpenRouter 的 `"xhigh"`、将 `"off"` 转为 `reasoning: { effort: "none" }`、`"auto"` 不下发字段。
2. **`reasoning_details` 解析与加密片段过滤**（`src/main/model/providers/openai-adapter.ts`、`src/main/model/providers/sdk-stream/openai-normalizer.ts`）：
   - 流式增量与非流式响应均读取 `reasoning_details` 数组中的可读文本（`type === "reasoning.text"` 的 `text` 字段及 `type === "reasoning.summary"` 的 `summary` 字段），主动忽略加密载荷，同时兼容 `message.reasoning` 与 `reasoning_content`。
3. **跨提供商模型列表与图像型录剥离前缀**：
   - `fetchVendorModels`（`src/main/model/config/fetch-vendor-models.ts`）直接解析 OpenRouter `/models` 返回的 `architecture.input_modalities` 数组与 `architecture.modality` 字符串（含 `"image"` 即判为支持图片）。
   - 未经接口声明时，`matchCatalog`（`src/main/model/providers/multimodal.ts`）会剥离 `"vendor/"` 前缀（例如 `google/gemini-2.5-pro` → `gemini-2.5-pro`）再匹配 `MODEL_MODALITY_CATALOG`（`^gemini-`、`^claude-`、`^gpt-4o` 等），但不命中仅限原厂的 `vendor` 规则（如 DeepSeek 限定的 `flash` 规则）。
