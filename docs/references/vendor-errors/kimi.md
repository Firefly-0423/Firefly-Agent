# Kimi（月之暗面）错误处理与适配参考

状态：参考资料（核验日期 2026-11-16）

> **边界提示**：Firefly 当前未针对 Moonshot / Kimi 错误体做专属子码分类（`docs/superpowers/plans/model-error-classification.md` 处于 `未开工`）。以下记录当前实装处理逻辑，并概括常见 HTTP 错误语义，**以供应商最新文档为准**。

---

## 1. 协议与接入配置

| 配置项 | 当前实现值 | 源码位置 |
|---|---|---|
| 提供商 ID / 显示名 | `id: "kimi"` / `displayName: "Kimi（月之暗面）"` / 短名 `"Kimi"` | `src/main/model/providers/capabilities.ts`、`src/main/model/config/model-settings.ts` |
| 协议支持 | 仅支持 `"openai"` | `src/main/model/providers/capabilities.ts` |
| 默认 Base URL | `https://api.moonshot.cn/v1` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 认证方式 | `authStyle: "bearer"` | `src/main/model/providers/auth.ts` |
| 预设与默认模型 | `defaultModel: "kimi-k2.7-code"`；预设 `mainModels: ["kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking"]` | `src/main/model/providers/capabilities.ts`、`src/renderer/settings/api/presets.ts` |
| 推理 / 缓存特征 | `thinkingField: "thinking"`、`cacheStrategy: "prompt_cache_key"` | `src/main/model/providers/capabilities.ts` |

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

- **`400` / `422`**：通常表示请求参数无效、上下文窗口超出上限、内容安全审核拒答或思考模式参数冲突，以供应商最新文档为准。
- **`401` / `403`**：通常表示 API Key 无效、账户欠费或模型访问权限不足，以供应商最新文档为准。
- **`404` / `429`**：`404` 通常为模型 ID 或接口路径不正确；`429` 通常为 RPM/TPM/并发限流或资源超额，以供应商最新文档为准。
- **`500` / `502` / `503` / `504`**：通常表示上游服务端临时故障或服务繁忙，以供应商最新文档为准。

---

## 3. 重试与回退行为

- **`maxRetries: 0`**：OpenAI SDK 配置为 `maxRetries: 0`（`src/main/model/providers/sdk-stream/client-config.ts`）。
- **传输重试**：首包前断连/超时按 `[1_000, 3_000]` ms 最多重试 2 次；`429` / `502` / `503` / `504` / `529` 按 `Retry-After` 或 `[2_000, 6_000]` ms（上限 `20_000` ms）最多重试 2 次（`src/main/model/providers/prepared-model-call.ts`）。
- **流式/图片回退**：遵循 `chat-loop.ts` 与 `agent-loop-llm.ts` 公共显式拒识回退逻辑。

---

## 4. UI 错误提示

- `E_MODEL_CONNECTION_LOST` → `chatPage.errorNetworkInterrupted`
- `E_MODEL_REQUEST_TIMEOUT` → `chatPage.errorModelTimedOut`
- `E_MODEL_REQUEST_FAILED` 等 `model` 错误 → `chatPage.errorModelRequestFailedWith`
- `MEMORY_CONTEXT_SEND_UNKNOWN` 等 `context` 错误 → `chatPage.errorContextFailedWith`

---

## 5. 厂商专属适配与边界处理

1. **Prompt 缓存键注入 (`prompt_cache_key`)**（`src/main/model/providers/openai-adapter.ts`）：
   - `OpenAICompatAdapter.applyCacheHints` 为 Kimi 生成形如 `firefly:kimi:<sha256>` 的 `cacheKey`（基于提示前缀/工具定义/模型派生哈希），并在 `buildRequest` 写入请求体 `prompt_cache_key`。
2. **思考规则与 `keepOnTools`**（`src/shared/reasoning.ts`、`src/main/model/providers/reasoning.ts`）：
   - `^kimi-k3`：`control: "effort"`，档位 `["low", "high", "max"]`，默认/自动 `"high"`，`requestStyle: "openai-effort"`，`supportsDisable: false`。
   - `^kimi-k2\.7-code-highspeed$`、`^kimi-k2\.7-code$`、`^kimi-k2-thinking`：`control: "fixed-on"`，`requestStyle: "none"`。
   - `^kimi-k2\.6`：`control: "toggle"`、`requestStyle: "thinking-type"`、`supportsDisable: true`、`keepOnTools: true`（在工具调用场景下下发 `thinking: { type: "enabled", keep: "all" }`）。
   - `^kimi-k2\.5`：`control: "toggle"`、`requestStyle: "thinking-type"`、`supportsDisable: true`、`keepOnTools: false`。
3. **思考态与 `tool_choice` 保护**（`src/main/model/providers/tool-choice-policy.ts`）：
   - 当 `providerId === "kimi"` 且推理可能开启时，`resolveToolChoicePolicy` 将指定工具名称 `"named"` 降级为 `"auto"`，避免请求被拒。
4. **视觉模型型录**：`^kimi-k2\.[567](?:$|[-.])` 覆盖 `kimi-k2.5`、`kimi-k2.6`、`kimi-k2.7` 系列图像输入能力（`src/main/model/providers/model-modalities.catalog.ts`）。
