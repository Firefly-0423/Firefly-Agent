# Firefly 已适配模型与协议参考

状态：参考资料（核验日期 2026-11-16）

本文档整理 Firefly 当前代码库中实际已注册的模型服务提供商、协议适配层、能力判定规则与型录匹配机制，仅记录已在 `src/` 落地的实现。

---

## 1. 协议适配层与选路机制

Firefly 将模型通信协议抽象为三种传输类型 `Transport = "openai" | "anthropic" | "responses"`（`src/main/model/providers/types.ts`），并在 `src/main/model/providers/index.ts` 的 `getAdapterForConfig` 中按 `${cfg.provider}::${protocol}` 缓存和分发适配器实例：

| 协议标识 (`Transport`) | 适配器类与源码 | 流式 SDK 入口 | 端点拼接规则 (`resolveApiEndpoint`) |
|---|---|---|---|
| `openai` | `OpenAICompatAdapter`（`src/main/model/providers/openai-adapter.ts`） | `streamPreparedChatWithSdk` → `openai` SDK `chat.completions.create`（`src/main/model/providers/sdk-stream/runtime.ts`、`client-config.ts`） | 非 `/chat/completions` 结尾时追加 `/chat/completions`（`src/shared/api-endpoint.ts`） |
| `anthropic` | `AnthropicAdapter`（`src/main/model/providers/anthropic-adapter.ts`） | `streamPreparedChatWithSdk` → `@anthropic-ai/sdk` `messages.stream`（`src/main/model/providers/sdk-stream/runtime.ts`、`client-config.ts`） | 已 `/v1` 结尾时追加 `/messages`，否则追加 `/v1/messages`；`deriveAnthropicClientConfig` 对非 `/v1/messages` 标准路径启用 `createEndpointPinnedFetch` 固定最终 URL（`src/shared/api-endpoint.ts`、`src/main/model/providers/sdk-stream/client-config.ts`） |
| `responses` | `ResponsesAdapter`（`src/main/model/providers/responses-adapter.ts`） | `streamPreparedChatWithSdk` → `openai` SDK `responses.create`（`src/main/model/providers/sdk-stream/runtime.ts`、`client-config.ts`） | 非 `/responses` 结尾时追加 `/responses`（`src/shared/api-endpoint.ts`） |

### 1.1 传输协议解析规则

`resolveTransport`（`src/main/model/providers/transport-detector.ts`）按以下顺序决定协议：
1. 若配置中存在合法的显式字段 `explicitTransport`（`"responses"`、`"anthropic"` 或 `"openai"`），直接使用该值。
2. 否则调用 `getCapabilityOrOpenAI(cfg.provider)` 读取提供商能力注册表的默认 `transport`（`src/main/model/providers/capabilities.ts`）。
3. Firefly **不会**根据 `baseUrl` 路径自动猜测协议（设置页提示文本 `settings.panel.api.field.transport.hint` 位于 `src/renderer/settings/i18n/zh-CN.json`）。

未出现在 `PROVIDER_CAPABILITIES` 中的提供商名（包括自定义端点），在 `getCapabilityOrOpenAI`（`src/main/model/providers/capabilities.ts`）中统一回退为通用 OpenAI 兼容默认值：`id: "unknown"`、`transport: "openai"`、`authStyle: "bearer"`、`supportsTools: true`、`supportsThinking: false`、`thinkingField: null`、`cacheStrategy: "none"`、`testStrategy: "text"`。

### 1.2 认证头选择

- `authHeaderFor`（`src/main/model/providers/auth.ts`）：当 `authStyle === "x-api-key"` 时发送 `x-api-key` 请求头；否则发送 `Authorization: Bearer <apiKey>`。
- 当提供商走 `anthropic` 协议且能力条目配置了 `anthropicAuthStyle`（例如 MiniMax、DeepSeek 的 `anthropicAuthStyle: "x-api-key"`）时，`OpenAICompatAdapter` / `AnthropicAdapter` / `sdk-stream/runtime.ts` 优先使用 `anthropicAuthStyle`（`src/main/model/providers/capabilities.ts`、`src/main/model/providers/sdk-stream/runtime.ts`）。`AnthropicAdapter.buildRequest` 固定附带 `anthropic-version: "2023-06-01"`（`src/main/model/providers/anthropic-adapter.ts`）。

---

## 2. 已注册模型提供商清单

以下 9 个内置提供商在 `PROVIDER_CAPABILITIES`（`src/main/model/providers/capabilities.ts`）与 `MODEL_PRESETS`（`src/renderer/settings/api/presets.ts`）中均已注册；此外 `MODEL_PRESETS` 还提供 2 个自定义端点预设。

| 提供商 ID | 显示名称 (`displayName`) | 默认协议 | 可选协议 (`supportedTransports`) | 默认 Base URL / Anthropic Base URL | 认证方式 (`authStyle` / `anthropicAuthStyle`) | 预设推荐模型 (`MODEL_PRESETS.mainModels` / `defaultModel`) | 思考字段 (`thinkingField`) | 缓存策略 (`cacheStrategy`) |
|---|---|---|---|---|---|---|---|---|
| `minimax` | `MiniMax（稀宇科技）` | `anthropic` | `anthropic`, `openai`, `responses` | 能力默认 `https://api.minimaxi.com/anthropic`；预设 `https://api.minimaxi.com/v1` / `anthropicBaseUrl: https://api.minimaxi.com/anthropic` | `bearer` / `x-api-key` | 预设 `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.5`；能力默认 `MiniMax-M3` | `thinking` | `cache_control` |
| `deepseek` | `DeepSeek（深度求索）` | `openai` | `openai`, `anthropic`, `responses` | `https://api.deepseek.com` / 预设 `anthropicBaseUrl: https://api.deepseek.com/anthropic` | `bearer` / `x-api-key` | 预设 `deepseek-flash`, `deepseek-v4-pro`；能力默认 `deepseek-flash` | `reasoning_content` | `auto` |
| `glm` | `GLM（智谱）` | `openai` | `openai`, `anthropic` | `https://open.bigmodel.cn/api/paas/v4` / 预设 `anthropicBaseUrl: https://open.bigmodel.cn/api/anthropic` | `bearer` | 预设 `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5-turbo`, `glm-4.7`；能力默认 `glm-5.2` | `reasoning_content` | `auto` |
| `kimi` | `Kimi（月之暗面）` | `openai` | `openai` | `https://api.moonshot.cn/v1` | `bearer` | 预设 `kimi-k2.6`, `kimi-k2.5`, `kimi-k2-thinking`；能力默认 `kimi-k2.7-code` | `thinking` | `prompt_cache_key` |
| `qwen` | `Qwen（通义千问）` | `openai` | `openai`, `responses` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `bearer` | 预设 `qwen-max`, `qwen-plus`, `qwen-turbo`；能力默认 `qwen-max` | `reasoning_content` | `auto` |
| `chatgpt` | `ChatGPT（OpenAI）` | `responses` | `openai`, `responses` | `https://api.openai.com/v1` | `bearer` | 预设 `gpt-6-astra`, `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`；能力默认 `""` | `reasoning_content` | `auto` |
| `claude` | `Claude（Anthropic）` | `anthropic` | `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` | 预设 `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`；能力默认 `claude-sonnet-4-6` | `thinking` | `cache_control` |
| `mimo` | `MiMo（小米）` | `openai` | `openai`, `anthropic`, `responses` | `https://api.xiaomimimo.com/v1` / 预设 `anthropicBaseUrl: https://api.xiaomimimo.com/anthropic` | `bearer` | 预设/能力默认 `mimo-v2.5-pro` | `reasoning_content` | `auto` |
| `openrouter` | `OpenRouter` | `openai` | `openai` | `https://openrouter.ai/api/v1` | `bearer` | 空列表（用户从 `/models` 获取或手填）；能力默认 `""` | `reasoning_details` | `auto` |

补充说明：
- **自定义端点**（`src/renderer/settings/api/presets.ts`）：`customPreset("cloud")` 对应 `自定义端点（云端）`（`shortName: "自定义"`，`transport: "openai"`）；`customPreset("local")` 对应 `自定义端点（本地）`（`shortName: "本地模型"`，`hiddenInPresetList: true`，`transport: "openai"`）。
- **状态栏短名映射**（`PROVIDER_SHORT_NAMES`，`src/main/model/config/model-settings.ts`）：包含 MiniMax、DeepSeek、GLM、Kimi、Qwen、ChatGPT、Claude、OpenRouter 8 项；`MiMo（小米）` 未列入该映射时，由 `getPublicModelConfig` 回退为完整 `settings.provider` 字符串。
- **未独立注册的模型系列**：`Gemini` 在 `PROVIDER_CAPABILITIES`、`MODEL_PRESETS` 与 `MODEL_REASONING_RULES` 中均无独立提供商条目，目前仅在 `MODEL_MODALITY_CATALOG`（`^gemini-`）中提供图片输入型录匹配，供经由 `OpenRouter`（如 `google/gemini-2.5-pro`）或自定义端点接入时识别多模态能力（`src/main/model/providers/model-modalities.catalog.ts`、`src/main/model/providers/multimodal.ts`、`src/main/model/providers/multimodal.test.ts`）。`Doubao（豆包）` 与 `Grok` 当前在代码库中没有任何适配条目。

---

## 3. 能力解析机制

### 3.1 图片输入与多模态路由

模型是否允许直发图片由 `resolveInputModalities`（`src/main/model/providers/multimodal.ts`）统一判定，优先级从高到低为：
1. **显式声明 (`declared`)**：来自档案中保存的 `inputModalities`。其中 `fetchVendorModels`（`src/main/model/config/fetch-vendor-models.ts`）从厂商 `GET /models` 解析的来源标记为 `declared-vendor-api`（支持 OpenRouter `architecture.input_modalities` / `architecture.modality`、Anthropic `capabilities.image_input.supported`、通用 `input_modalities` / `modalities` 数组以及 `capabilities.vision` / `supports_vision` / `vision` 布尔标记）；用户在设置页高级选项手动覆写后标记为 `declared-user`。
2. **内置型录 (`MODEL_MODALITY_CATALOG`)**：位于 `src/main/model/providers/model-modalities.catalog.ts`，共 10 条规则（均标记 `input: ["text", "image"]`）。`matchCatalog` 会同时匹配完整模型名与去掉 `"vendor/"` 前缀后的裸模型名 `bare`（`src/main/model/providers/multimodal.ts`）：
   - `^MiniMax-M3(?:$|[-_])`（不限 vendor）
   - `^(?:deepseek-)?(?:v4-)?flash(?:$|-)`（**限定 `vendor: "deepseek"`**）
   - `^glm-(?:\d+(?:\.\d+)?v|4v)(?:$|-)`
   - `^kimi-k2\.[567](?:$|[-.])`
   - `^qwen[\w.-]*-vl(?:$|-)`
   - `^gpt-(?:4o|4\.1|5|6)(?:$|[-.])`
   - `^claude-`
   - `^gemini-`
   - `^mimo-v2\.5(?:$|-(?!pro))`（`mimo-v2.5-pro` 被显式排除）
   - `(?:^|[-_.])(?:vision|vl)(?:$|[-_.])|^qvq(?:$|[-_.])`
3. **保守兜底**：未命中以上两级时返回 `{ image: false, source: "unknown" }`，宁可阻止发送图片也不向纯文本模型发送必然报 `400` 的图像载荷（`src/main/model/providers/multimodal.ts`）。

聊天图片路由 `resolveImageRoute` 与图片转述配置 `resolveCaptionVisionConfig` 均收口在 `src/main/model/vision/image-router.ts`：
- 当 `settings.multimodal === true` 时走 `{ mode: "direct" }` 直发主模型；否则返回 `{ mode: "reject", reason: IMAGE_UNSUPPORTED_REASON }`，**不再**存在全局回退视觉模型。
- 走 `AnthropicAdapter` 时，`toAnthropicContent` 仅将 `image/png`、`image/jpeg`、`image/webp`、`image/gif` 的 Base64 数据或 HTTP/HTTPS URL 序列化为 `image` 块，其余 MIME 类型（如 SVG）降级为纯文本提示（`src/main/model/providers/anthropic-adapter.ts`）。
- 视觉转述器 `captionImage`（`src/main/model/vision/vision-captioner.ts`）仅支持 `/chat/completions` 接口（当主模型使用 `anthropic` 协议时 `resolveCaptionVisionConfig` 会显式拒绝转述）。

### 3.2 思考 / 推理能力解析 (`Reasoning`)

推理能力解析由 `resolveReasoningCapability`、`resolveEffectiveReasoning`（`src/shared/reasoning.ts`）与 `applyReasoningPreference`（`src/main/model/providers/reasoning.ts`）协作完成：

1. **规则匹配顺序**（`resolveReasoningCapability`，`src/shared/reasoning.ts`）：
   - 先检查档案级 `reasoningLevels`：若非 `"auto"` 模式，直接按用户勾选的档位和当前协议默认请求风格（`anthropic` → `anthropic-adaptive`，其余 → `openai-effort`）构造能力对象。
   - 否则按 `MODEL_REASONING_RULES` 匹配：先匹配 `entry.vendor === vendor`，若未命中且允许跨网关兜底，再匹配无 `ownProviderOnly` 标记的规则（因此未列出的自定义/网关端点也能按 `gpt-5`、`claude-` 等型号名推断能力，但不会误命中 OpenRouter 的通配规则）。
   - 若仍无命中，回退为 `control: "toggle"`、`requestStyle: defaultStyle`（`supportsDisable: true`）。

2. **各提供商内置规则摘要**（`MODEL_REASONING_RULES`，`src/shared/reasoning.ts`）：
   - **OpenAI (`chatgpt`)**：`^gpt-6`（`effort`: `low/medium/high/xhigh/max`，默认 `medium`，`openai-effort`，`supportsDisable: false`）；`^gpt-5\.6`（同上但 `supportsDisable: true`）；`^gpt-5`（`minimal/low/medium/high`，默认 `medium`）；`^o1` / `^o3`（`low/medium/high`）；`^o4`（`medium/high`）。
   - **Anthropic (`claude`)**：`^claude-fable-5`（`low/medium/high/xhigh/max`，默认 `high`，`disableRejected: true`，`supportsDisable: false`）；`^claude-opus-5-5`（默认 `medium`，`disableRejected: true`，`supportsDisable: false`）；`^claude-opus-5` / `^claude-sonnet-5-5`（`offThinking: "between_tools"`）/ `^claude-haiku-5-5` / `^claude-sonnet-5` / `^claude-opus-4-(8|7|6)`（以上均为 `anthropic-adaptive`）；`^claude-sonnet-4-6`（`low/medium/high/xhigh`，默认 `high`）。
   - **DeepSeek (`deepseek`)**：`^deepseek-(?:v4|flash)`（`toggle-effort`，`high/max`，默认 `high`，`autoEffort: "high"`，`thinking-type`，`supportsDisable: true`）；`^deepseek-(chat|reasoner)$`（`control: "none"`）。
   - **GLM (`glm`)**：`^glm-5\.3`（`toggle-effort`，`low/high/max`，`supportsDisable: false`，`thinking-type`）；`^glm-5\.2`（`low/medium/high/xhigh/max`，`supportsDisable: true`）；`^glm-5-turbo` / `^glm-5v-turbo` / `^glm-5\.1` / `^glm-5` / `^glm-(4\.5|4\.6|4\.7)`（`toggle`，`thinking-type`）。
   - **Qwen (`qwen`)**：`-thinking$`（`fixed-on`，`requestStyle: "none"`）；`^qwen3` / `^qwen-(max|plus|turbo)`（`toggle`，`qwen-enable-thinking`）。
   - **Kimi (`kimi`)**：`^kimi-k3`（`effort`，`low/high/max`，`openai-effort`，`supportsDisable: false`）；`^kimi-k2\.7-code-highspeed$` / `^kimi-k2\.7-code$` / `^kimi-k2-thinking`（`fixed-on`，`requestStyle: "none"`）；`^kimi-k2\.6`（`toggle`，`thinking-type`，`keepOnTools: true`）；`^kimi-k2\.5`（`toggle`，`thinking-type`，`keepOnTools: false`）。
   - **MiniMax (`minimax`)**：`^MiniMax-M3`（`toggle`，`anthropic-adaptive`，`supportsDisable: true`）；`^MiniMax-M2\.`（`fixed-on`，`requestStyle: "none"`）。
   - **MiMo (`mimo`)**：`^mimo-v2\.`（`toggle`，`thinking-type`，`supportsDisable: true`）。
   - **OpenRouter (`openrouter`)**：`/.*/`（`ownProviderOnly: true`，`effort`，`low/medium/high/max`，默认 `medium`，`openrouter-reasoning`；`applyReasoningPreference` 将 `"max"` 映射为 `"xhigh"`、`"off"` 映射为 `"none"`、`"auto"` 不下发字段）。

3. **协议请求字段序列化与覆盖**（`src/main/model/providers/reasoning.ts`、`src/main/model/providers/responses-adapter.ts`、`src/main/model/providers/runtime-settings.ts`）：
   - `resolveVendorRuntimeSettings` 仅当 `getCustomEndpointMode(source.provider) !== null` 时才允许 `thinkingOverride` / `disableMaxToken` 生效；非自定义（官方预设）提供商强制规范为 `{ thinkingOverride: 0, disableMaxToken: false }`。
   - `ResponsesAdapter.buildRequest` 在调用 `applyReasoningPreference` 后提取 `reasoning_effort` 或 `output_config.effort` 为 `reasoning: { effort }`，或将非 `"disabled"` 的 `thinking` / `enable_thinking: true` 规范化为 `reasoning: { effort: capability.autoEffort ?? capability.defaultEffort }`，随后删除 `reasoning_effort`、`thinking`、`enable_thinking`、`output_config`（`src/main/model/providers/responses-adapter.ts`）。
   - `ResponsesAdapter` 仅在 `capability.responsesEncryptedReasoning === true` 且 `isOfficialOpenAIEndpoint(cfg.baseUrl)` 为真时注入 `include: ["reasoning.encrypted_content"]` 并在历史消息中附带加密推理条目（`src/main/model/providers/responses-adapter.ts`）。

### 3.3 工具调用与 `tool_choice` 策略

`resolveAutomaticToolChoicePolicy` 与 `resolveToolChoicePolicy`（`src/main/model/providers/tool-choice-policy.ts`）结合当前有效推理状态 `mayThink`、协议类型和提供商规则决定 `tool_choice` 下发方式：
- **DeepSeek（开启推理或 `auto` 时）**：`resolveAutomaticToolChoicePolicy` 与 `resolveToolChoicePolicy` 均返回 `"omit"`（不下发 `tool_choice` 参数，防止与思考模式冲突）。
- **MiniMax（及 `anySearch`）**：指定工具模式也强制降级为 `"auto"`。
- **Kimi（开启推理时）** / **`anthropic` 传输协议（开启推理时）**：指定工具调用 `"named"` 降级为 `"auto"`（由 `AnthropicAdapter` 映射为 `{ type: "auto" }`）。
- 若显式传入 `supportedModes` 限制，回退按 `["named", "required", "auto", "omit"]` 顺序选择首个允许项。

### 3.4 提示词缓存策略 (`CacheStrategy`)

- **`cache_control`（Claude / MiniMax）**：`AnthropicAdapter.buildRequest`（`src/main/model/providers/anthropic-adapter.ts`）固定给 `system` 块追加 `cache_control: { type: "ephemeral" }`；当 `supportsMessageCacheBreakpoint(vendorId, model)` 为真（`claude` 全系列及 `minimax` 非 M3 型号；`MiniMax-M3` 显式关闭消息级断点）时，在倒数两条历史消息上额外加 `ephemeral` 断点。
- **`prompt_cache_key`（Kimi）**：`OpenAICompatAdapter.applyCacheHints`（`src/main/model/providers/openai-adapter.ts`）为请求派生 `cacheKey: "firefly:kimi:<sha256>"` 并写入请求体 `prompt_cache_key`。
- **`auto` / `none`**：其余提供商不主动写入协议级缓存断点，由服务端自动缓存或无缓存；多轮上下文缓存纪元 `AgentLoopCacheState` 由 `src/main/agent/loop/agent-loop.ts` 追踪。

### 3.5 多角色模型路由

`agent-model-routing.ts`（`src/main/model/config/agent-model-routing.ts`）通过 `resolveAgentModelProfile` / `buildAgentRoutingView` 支持为特定角色或路由绑定独立模型档案；未显式绑定的角色全部回退到 `defaultModelProfileId`（或档案列表首项）。
