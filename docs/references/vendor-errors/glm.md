# GLM（智谱）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对智谱 API 返回体内的错误码做独立分类映射（`docs/superpowers/plans/2026-11-12-model-error-classification.md` 处于 `未开工`）。以下先列出代码库实装处理，再概括常见 HTTP 状态含义，**以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "glm"` / `displayName: "GLM（智谱）"` / 短名 `"GLM"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 默认协议与可选协议 | 默认 `"openai"`，支持 `["openai", "anthropic"]` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL / Anthropic 地址 | `https://open.bigmodel.cn/api/paas/v4`；预设 `anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic"` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证方式 | `authStyle: "bearer"`（未设 `anthropicAuthStyle` 覆盖，切至 `anthropic` 时同样按 Bearer 令牌发往 SDK） | `src/main/model/providers/capabilities.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 预设与默认模型 | `defaultModel: "glm-5.2"`；预设 `mainModels: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-4.7"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存特征 | `thinkingField: "reasoning_content"`、`cacheStrategy: "auto"` | `src/main/model/providers/capabilities.ts` |

---

## 2. HTTP 与错误到 Firefly 错误码映射

### 2.1 当前代码实装映射链路

| 故障触发情景 | 主进程分类结果 | 最终公开错误码 (`publicRunFailure`) | `errorSource` | 源码依据 |
|---|---|---|---|---|
| `429` / `502` / `503` / `504` / `529` 重试用尽 | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 持久化对话非 `sent` 多收敛为 `MEMORY_CONTEXT_SEND_UNKNOWN`；直接调用 / `temporary` 经 `publicRunFailure` 为 `E_MODEL_REQUEST_FAILED` 或 `E_HARNESS_FAILURE` | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts`、`src/main/agent/memory-runtime/main-memory-runtime.ts` |
| 其他 HTTP 错误（`400`、`401`、`403`、`404`、`422`） | `AgentRuntimeError("E_MODEL_REQUEST_FAILED")` | 同上 | `model` / `context` / `runtime` | `src/main/model/providers/prepared-model-call.ts` |
| 响应头 120s / 流读取 300s / 请求截止超时 | `AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT")` | `E_MODEL_REQUEST_TIMEOUT` | `model` | `src/main/model/providers/prepared-model-call.ts`、`src/main/model/providers/sdk-stream/runtime.ts` |
| 底层网络连接中断 | `AgentRuntimeError("E_MODEL_CONNECTION_LOST")` | `E_MODEL_CONNECTION_LOST` | `model` | `src/main/model/providers/connection-lost.ts` |

### 2.2 常见厂商 HTTP 语义概括（以供应商最新文档为准）

- **`400` / `422`**：通常表示请求参数、字段格式、思考开关与模型不匹配，或内容安全策略拦截，以供应商最新文档为准。
- **`401` / `403`**：通常表示 API Key 鉴权失败、过期或账户权限受限，以供应商最新文档为准。
- **`404` / `429`**：`404` 通常为模型标识或接口路径不匹配；`429` 通常表示并发数、速率或余额配额超限，以供应商最新文档为准。
- **`500` / `502` / `503` / `504`**：通常表示服务端内部异常或网关上游不可用，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：OpenAI 与 Anthropic SDK 均禁用了自带重试（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。
- **Anthropic 路径固定**：使用 `anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic"` 时由 `deriveAnthropicClientConfig` 通过 `createEndpointPinnedFetch` 保留非标准前缀路径（`src/main/model/providers/sdk-stream/client-config.ts`）。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` 等 `model` 错误 → `chatPage.errorModelRequestFailedWith`
- `MEMORY_CONTEXT_SEND_UNKNOWN` 等 `context` 错误 → `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **分型号思考能力规则**（`src/shared/reasoning.ts`）：
   - `^glm-5\.3`：`control: "toggle-effort"`，支持 `["low", "high", "max"]`，默认/自动 `"high"`，`requestStyle: "thinking-type"`，`supportsDisable: false`（不允许关闭思考）。
   - `^glm-5\.2`：`control: "toggle-effort"`，支持 `["low", "medium", "high", "xhigh", "max"]`，默认 `"medium"`，自动 `"high"`，`supportsDisable: true`。
   - `^glm-5-turbo`、`^glm-5v-turbo`、`^glm-5\.1`、`^glm-5`、`^glm-(4\.5|4\.6|4\.7)`：`control: "toggle"`、`requestStyle: "thinking-type"`、`supportsDisable: true`（映射为 `thinking: { type: "enabled" | "disabled" }`）。
2. **视觉模型型录规则**（`src/main/model/providers/model-modalities.catalog.ts`）：
   - `^glm-(?:\d+(?:\.\d+)?v|4v)(?:$|-)`（匹配 `glm-4v`、`glm-5v`、`glm-5v-turbo` 等带 `v` 标识模型；不带 `v` 的 `glm-5.3` / `glm-5.2` 默认判为不支持图片）。
3. **工具选择策略**：切至 `anthropic` 协议且思考开启时，`resolveToolChoicePolicy` 将 `"named"` 降级为 `"auto"`（`src/main/model/providers/tool-choice-policy.ts`）。
