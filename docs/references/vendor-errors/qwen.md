# Qwen（通义千问）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 DashScope / Qwen 响应体里的厂商特定错误码做独立分类映射（`docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下说明 Firefly 当前实装的处理链路，并概括常见 HTTP 状态含义，**以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "qwen"` / `displayName: "Qwen（通义千问）"` / 短名 `"Qwen"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 默认协议与可选协议 | 默认 `"openai"`，支持 `["openai", "responses"]` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证方式 | `authStyle: "bearer"` | `src/main/model/providers/auth.ts` |
| 预设与默认模型 | `defaultModel: "qwen-max"`；预设 `mainModels: ["qwen-max", "qwen-plus", "qwen-turbo"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
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

- **`400` / `422`**：常见于参数取值非法（例如与当前模型不匹配的 `enable_thinking` 参数）、输入超长、内容安全校验拦截或不支持的多模态输入，以供应商最新文档为准。
- **`401` / `403`**：通常表示 DashScope API Key 无效、缺失或账户未开通对应模型权限/欠费停服，以供应商最新文档为准。
- **`404` / `429`**：`404` 通常为模型名或兼容接口路径错误；`429` 通常表示触发 QPS/TPM 限流，以供应商最新文档为准。
- **`500` / `502` / `503` / `504`**：通常表示服务端内部错误、网关异常或短暂不可用，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：OpenAI SDK 与 Responses SDK 均配置 `maxRetries: 0`（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。
- **语义回退**：非流式首包前命中 400/422 显式流式拒识时回退 `stream: false`；图片被拒且开启转述回退时走 `captionImage`（`src/main/agent/runtime/chat-loop.ts`、`src/main/model/vision/vision-captioner.ts`）。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` 等 `model` 错误 → `chatPage.errorModelRequestFailedWith`
- `MEMORY_CONTEXT_SEND_UNKNOWN` 等 `context` 错误 → `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **`enable_thinking` 专属请求格式**（`src/shared/reasoning.ts`、`src/main/model/providers/reasoning.ts`）：
   - `^qwen3`、`^qwen-(max|plus|turbo)` 匹配为 `control: "toggle"`、`requestStyle: "qwen-enable-thinking"`、`supportsDisable: true`；启用/自动下发 `enable_thinking: true`，关闭下发 `enable_thinking: false`。
   - 后缀 `-thinking$`（如 QwQ / Thinking 专用模型）匹配为 `control: "fixed-on"`、`requestStyle: "none"`（不再发送额外开关字段）。
   - 若用户手动切至 `responses` 协议，`ResponsesAdapter.buildRequest` 会移除 `enable_thinking` 并按 `reasoning: { effort }` 转换（`src/main/model/providers/responses-adapter.ts`）。
2. **视觉模型型录规则**（`src/main/model/providers/model-modalities.catalog.ts`）：
   - `^qwen[\w.-]*-vl(?:$|-)`（匹配 `qwen-vl`、`qwen2.5-vl`、`qwen3-vl-plus` 等）与 `(?:^|[-_.])(?:vision|vl)(?:$|[-_.])|^qvq(?:$|[-_.])`（覆盖 `qvq` 系列）。
   - 注意：纯文本前缀 `qwen-max` / `qwen-plus` / `qwen-turbo` 未列入图像型录，按 `resolveInputModalities` 保守策略默认视为不支持图片（除非用户在设置页手动开启多模态或 `/models` 返回明确声明）。
