# MiMo（小米）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 MiMo 响应体错误字段实现专属错误码分支（`docs/superpowers/plans/2026-11-12-model-error-classification.md` 处于 `未开工`）。以下说明当前实装的适配与错误收口行为，**具体 HTTP 状态与错误定义以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "mimo"` / `displayName: "MiMo（小米）"` | `src/main/model/providers/capabilities.ts` |
| 状态栏短名兜底 | 未写入 `PROVIDER_SHORT_NAMES`，`getPublicModelConfig` 回退使用完整 `"MiMo（小米）"` | `src/main/model/config/model-settings.ts` |
| 默认协议与可选协议 | 默认 `"openai"`，支持 `["openai", "anthropic", "responses"]` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL / Anthropic 地址 | `https://api.xiaomimimo.com/v1`；预设 `anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic"` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证方式 | `authStyle: "bearer"`（未设置 `anthropicAuthStyle` 覆盖；即使切换为 `anthropic` 协议也使用 Bearer / `authToken` 认证） | `src/main/model/providers/capabilities.ts`、`src/main/model/providers/sdk-stream/runtime.ts`、`sdk-stream/provider-contracts.test.ts` |
| 预设与默认模型 | `defaultModel: "mimo-v2.5-pro"`；预设 `mainModels: ["mimo-v2.5-pro"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存 / 视觉字段 | `thinkingField: "reasoning_content"`、`cacheStrategy: "auto"`、`visionBaseUrl: "https://api.xiaomimimo.com/v1"` | `src/main/model/providers/capabilities.ts` |

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

- **`400` / `422`**：通常表示请求参数无效、思考开关与模型不兼容或图片输入向纯文本模型提交，以供应商最新文档为准。
- **`401` / `403`**：通常表示 API Key 鉴权失败或权限受限，以供应商最新文档为准。
- **`404` / `429`**：`404` 通常为模型名或接入路径不匹配；`429` 通常表示速率或配额受限，以供应商最新文档为准。
- **`500` / `502` / `503` / `504`**：通常表示服务端内部异常或临时过载，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：OpenAI、Anthropic 与 Responses 三种 SDK 客户端均禁止 SDK 自带重试（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。
- **Anthropic 协议认证与路径固定**：切至 `anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic"` 时，`sdk-stream/runtime.ts` 依据 `authStyle: "bearer"` 走 Bearer 令牌认证（在 `src/main/model/providers/sdk-stream/provider-contracts.test.ts` 中显式测试验证），并通过 `createEndpointPinnedFetch` 保留 `/anthropic/v1/messages` 路径。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` 等 `model` 错误 → `chatPage.errorModelRequestFailedWith`
- `MEMORY_CONTEXT_SEND_UNKNOWN` 等 `context` 错误 → `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **视觉能力明确排除 `mimo-v2.5-pro`**（`src/main/model/providers/model-modalities.catalog.ts`）：
   - 型录规则 `^mimo-v2\.5(?:$|-(?!pro))` 仅识别 `mimo-v2.5` 及其非 `-pro` 变体支持图片；默认模型 `mimo-v2.5-pro` 被前瞻负向匹配显式排除，避免直接向其发送图像载荷。
2. **思考能力规则**（`src/shared/reasoning.ts`）：
   - `^mimo-v2\.` 匹配为 `control: "toggle"`、`requestStyle: "thinking-type"`、`supportsDisable: true`（通过 `thinking: { type: "enabled" | "disabled" }` 控制）。
