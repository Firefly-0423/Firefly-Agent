# Firefly Adapted Models & Protocols Reference

Status: Reference (verified 2026-11-16)

This document summarizes the model providers, transport adapters, capability resolution rules, and catalog patterns currently implemented under `src/` in Firefly.

---

## 1. Protocol Adapters & Transport Routing

Firefly models API communication across three transport protocols `Transport = "openai" | "anthropic" | "responses"` (`src/main/model/providers/types.ts`). `getAdapterForConfig` (`src/main/model/providers/index.ts`) instantiates and caches adapters keyed by `${cfg.provider}::${protocol}`:

| Transport (`Transport`) | Adapter Class & File | Streaming SDK Path | Endpoint Resolution (`resolveApiEndpoint`) |
|---|---|---|---|
| `openai` | `OpenAICompatAdapter` (`src/main/model/providers/openai-adapter.ts`) | `streamPreparedChatWithSdk` -> `openai` SDK `chat.completions.create` (`src/main/model/providers/sdk-stream/runtime.ts`, `client-config.ts`) | Appends `/chat/completions` unless already ending with `/chat/completions` (`src/shared/api-endpoint.ts`) |
| `anthropic` | `AnthropicAdapter` (`src/main/model/providers/anthropic-adapter.ts`) | `streamPreparedChatWithSdk` -> `@anthropic-ai/sdk` `messages.stream` (`src/main/model/providers/sdk-stream/runtime.ts`, `client-config.ts`) | Appends `/messages` when `baseUrl` ends with `/v1`, otherwise appends `/v1/messages`; `deriveAnthropicClientConfig` installs `createEndpointPinnedFetch` for nonstandard endpoints (`src/shared/api-endpoint.ts`, `src/main/model/providers/sdk-stream/client-config.ts`) |
| `responses` | `ResponsesAdapter` (`src/main/model/providers/responses-adapter.ts`) | `streamPreparedChatWithSdk` -> `openai` SDK `responses.create` (`src/main/model/providers/sdk-stream/runtime.ts`, `client-config.ts`) | Appends `/responses` unless already ending with `/responses` (`src/shared/api-endpoint.ts`) |

### 1.1 Transport Detection

`resolveTransport` (`src/main/model/providers/transport-detector.ts`) selects the protocol in strict order:
1. If `explicitTransport` is `"responses"`, `"anthropic"`, or `"openai"`, use it directly.
2. Otherwise fall back to `getCapabilityOrOpenAI(cfg.provider).transport` (`src/main/model/providers/capabilities.ts`).
3. Firefly does **not** auto-detect the protocol from `baseUrl` (as noted by `settings.panel.api.field.transport.hint` in `src/renderer/settings/i18n/zh-CN.json`).

Unknown provider names (including custom endpoints) fall back via `getCapabilityOrOpenAI` (`src/main/model/providers/capabilities.ts`) to OpenAI-compatible defaults: `id: "unknown"`, `transport: "openai"`, `authStyle: "bearer"`, `supportsTools: true`, `supportsThinking: false`, `thinkingField: null`, `cacheStrategy: "none"`, `testStrategy: "text"`.

### 1.2 Authentication Headers

- `authHeaderFor` (`src/main/model/providers/auth.ts`) sends `x-api-key` when `authStyle === "x-api-key"`, and `Authorization: Bearer <apiKey>` otherwise.
- When `transport === "anthropic"` and the capability defines `anthropicAuthStyle` (such as `"x-api-key"` on MiniMax and DeepSeek), `OpenAICompatAdapter`, `AnthropicAdapter`, and `sdk-stream/runtime.ts` prefer `anthropicAuthStyle` (`src/main/model/providers/capabilities.ts`, `src/main/model/providers/sdk-stream/runtime.ts`). `AnthropicAdapter.buildRequest` always sets `anthropic-version: "2023-06-01"` (`src/main/model/providers/anthropic-adapter.ts`).

---

## 2. Registered Provider Inventory

The following 9 built-in providers are registered in both `PROVIDER_CAPABILITIES` (`src/main/model/providers/capabilities.ts`) and `MODEL_PRESETS` (`src/renderer/settings/api/presets.ts`), alongside 2 custom endpoint presets:

| Provider ID | Display Name (`displayName`) | Default Transport | Supported Transports (`supportedTransports`) | Base URL / Preset `anthropicBaseUrl` | Auth (`authStyle` / `anthropicAuthStyle`) | Preset Models (`MODEL_PRESETS.mainModels` / `defaultModel`) | Thinking Field (`thinkingField`) | Cache Strategy (`cacheStrategy`) |
|---|---|---|---|---|---|---|---|---|
| `minimax` | `MiniMax（稀宇科技）` | `anthropic` | `anthropic`, `openai`, `responses` | Capability `https://api.minimaxi.com/anthropic`; preset `https://api.minimaxi.com/v1` / `anthropicBaseUrl: https://api.minimaxi.com/anthropic` | `bearer` / `x-api-key` | Preset `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.5`; default `MiniMax-M3` | `thinking` | `cache_control` |
| `deepseek` | `DeepSeek（深度求索）` | `openai` | `openai`, `anthropic`, `responses` | `https://api.deepseek.com` / preset `anthropicBaseUrl: https://api.deepseek.com/anthropic` | `bearer` / `x-api-key` | Preset `deepseek-flash`, `deepseek-v4-pro`; default `deepseek-flash` | `reasoning_content` | `auto` |
| `glm` | `GLM（智谱）` | `openai` | `openai`, `anthropic` | `https://open.bigmodel.cn/api/paas/v4` / preset `anthropicBaseUrl: https://open.bigmodel.cn/api/anthropic` | `bearer` | Preset `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5-turbo`, `glm-4.7`; default `glm-5.2` | `reasoning_content` | `auto` |
| `kimi` | `Kimi（月之暗面）` | `openai` | `openai` | `https://api.moonshot.cn/v1` | `bearer` | Preset `kimi-k2.6`, `kimi-k2.5`, `kimi-k2-thinking`; default `kimi-k2.7-code` | `thinking` | `prompt_cache_key` |
| `qwen` | `Qwen（通义千问）` | `openai` | `openai`, `responses` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `bearer` | Preset `qwen-max`, `qwen-plus`, `qwen-turbo`; default `qwen-max` | `reasoning_content` | `auto` |
| `chatgpt` | `ChatGPT（OpenAI）` | `responses` | `openai`, `responses` | `https://api.openai.com/v1` | `bearer` | Preset `gpt-6-astra`, `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`; default `""` | `reasoning_content` | `auto` |
| `claude` | `Claude（Anthropic）` | `anthropic` | `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` | Preset `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`; default `claude-sonnet-4-6` | `thinking` | `cache_control` |
| `mimo` | `MiMo（小米）` | `openai` | `openai`, `anthropic`, `responses` | `https://api.xiaomimimo.com/v1` / preset `anthropicBaseUrl: https://api.xiaomimimo.com/anthropic` | `bearer` | Preset / default `mimo-v2.5-pro` | `reasoning_content` | `auto` |
| `openrouter` | `OpenRouter` | `openai` | `openai` | `https://openrouter.ai/api/v1` | `bearer` | Empty list (user fetches `/models` or enters manually); default `""` | `reasoning_details` | `auto` |

Additional notes:
- **Custom endpoints** (`src/renderer/settings/api/presets.ts`): `customPreset("cloud")` (`自定义端点（云端）`, `shortName: "自定义"`, `transport: "openai"`) and `customPreset("local")` (`自定义端点（本地）`, `shortName: "本地模型"`, `hiddenInPresetList: true`, `transport: "openai"`).
- **Short-name map** (`PROVIDER_SHORT_NAMES`, `src/main/model/config/model-settings.ts`): covers MiniMax, DeepSeek, GLM, Kimi, Qwen, ChatGPT, Claude, and OpenRouter; `MiMo（小米）` is absent from that map and falls back to `settings.provider` in `getPublicModelConfig`.
- **Model families without standalone presets**: `Gemini` has no standalone provider entry in `PROVIDER_CAPABILITIES`, `MODEL_PRESETS`, or `MODEL_REASONING_RULES`; it is represented in `MODEL_MODALITY_CATALOG` (`^gemini-`) so models served through `OpenRouter` (e.g., `google/gemini-2.5-pro`) or custom endpoints are recognized for image input (`src/main/model/providers/model-modalities.catalog.ts`, `src/main/model/providers/multimodal.ts`, `src/main/model/providers/multimodal.test.ts`). `Doubao` and `Grok` have no code entries in `src/`.

---

## 3. Capability Resolution

### 3.1 Image Input Modalities & Routing

`resolveInputModalities` (`src/main/model/providers/multimodal.ts`) determines image support in three priority tiers:
1. **Declared (`declared`)**: Explicit `inputModalities` saved on the profile — either `declared-vendor-api` fetched from `GET /models` via `fetchVendorModels` (`src/main/model/config/fetch-vendor-models.ts`, parsing OpenRouter `architecture.input_modalities` / `architecture.modality`, Anthropic `capabilities.image_input.supported`, generic `input_modalities` / `modalities`, and boolean flags `capabilities.vision` / `supports_vision` / `vision`), or `declared-user` from manual user overrides.
2. **Built-in Catalog (`MODEL_MODALITY_CATALOG`)**: Defined in `src/main/model/providers/model-modalities.catalog.ts` with 10 regex rules (`input: ["text", "image"]`). `matchCatalog` tests both full model ID and bare name after stripping any `"vendor/"` gateway prefix (`src/main/model/providers/multimodal.ts`):
   - `^MiniMax-M3(?:$|[-_])` (any vendor)
   - `^(?:deepseek-)?(?:v4-)?flash(?:$|-)` (**scoped to `vendor: "deepseek"`**)
   - `^glm-(?:\d+(?:\.\d+)?v|4v)(?:$|-)`
   - `^kimi-k2\.[567](?:$|[-.])`
   - `^qwen[\w.-]*-vl(?:$|-)`
   - `^gpt-(?:4o|4\.1|5|6)(?:$|[-.])`
   - `^claude-`
   - `^gemini-`
   - `^mimo-v2\.5(?:$|-(?!pro))` (`mimo-v2.5-pro` explicitly excluded)
   - `(?:^|[-_.])(?:vision|vl)(?:$|[-_.])|^qvq(?:$|[-_.])`
3. **Conservative Fallback**: Returns `{ image: false, source: "unknown" }` so unverified models never receive image payloads that guarantee HTTP `400` (`src/main/model/providers/multimodal.ts`).

Image routing in `resolveImageRoute` and `resolveCaptionVisionConfig` (`src/main/model/vision/image-router.ts`):
- Routes `direct` when `settings.multimodal === true`; otherwise rejects with `IMAGE_UNSUPPORTED_REASON` (there is no global fallback vision model).
- `AnthropicAdapter` (`toAnthropicContent` in `src/main/model/providers/anthropic-adapter.ts`) accepts `image/png`, `image/jpeg`, `image/webp`, `image/gif` base64 data or HTTP/HTTPS URLs and downgrades other MIME types to text notices.
- `captionImage` (`src/main/model/vision/vision-captioner.ts`) only calls `/chat/completions`; `resolveCaptionVisionConfig` rejects caption fallback when the main model uses `anthropic` transport.

### 3.2 Reasoning Capability Resolution

`resolveReasoningCapability` and `resolveEffectiveReasoning` (`src/shared/reasoning.ts`), paired with `applyReasoningPreference` (`src/main/model/providers/reasoning.ts`), resolve model thinking controls:

1. **Resolution priority** (`resolveReasoningCapability`, `src/shared/reasoning.ts`):
   - User-configured `reasoningLevels` when not `"auto"` (selects `anthropic-adaptive` for `anthropic` transport or `openai-effort` otherwise).
   - Otherwise `MODEL_REASONING_RULES`: vendor-matched entries first, then cross-vendor rules without `ownProviderOnly: true`.
   - Fallback: `control: "toggle"`, `requestStyle: defaultStyle`, `supportsDisable: true`.

2. **Built-in rules by provider** (`MODEL_REASONING_RULES`, `src/shared/reasoning.ts`):
   - **OpenAI (`chatgpt`)**: `^gpt-6` (`low/medium/high/xhigh/max`, default `medium`, `openai-effort`, `supportsDisable: false`); `^gpt-5\.6` (same levels, `supportsDisable: true`); `^gpt-5` (`minimal/low/medium/high`, default `medium`); `^o1` / `^o3` (`low/medium/high`); `^o4` (`medium/high`).
   - **Anthropic (`claude`)**: `^claude-fable-5` (`low/medium/high/xhigh/max`, default `high`, `disableRejected: true`, `supportsDisable: false`); `^claude-opus-5-5` (default `medium`, `disableRejected: true`, `supportsDisable: false`); `^claude-opus-5`, `^claude-sonnet-5-5` (`offThinking: "between_tools"`), `^claude-haiku-5-5`, `^claude-sonnet-5`, `^claude-opus-4-(8|7|6)` (`anthropic-adaptive`); `^claude-sonnet-4-6` (`low/medium/high/xhigh`, default `high`).
   - **DeepSeek (`deepseek`)**: `^deepseek-(?:v4|flash)` (`toggle-effort`, `high/max`, `autoEffort: "high"`, `thinking-type`, `supportsDisable: true`); `^deepseek-(chat|reasoner)$` (`control: "none"`).
   - **GLM (`glm`)**: `^glm-5\.3` (`toggle-effort`, `low/high/max`, `supportsDisable: false`, `thinking-type`); `^glm-5\.2` (`low/medium/high/xhigh/max`, `supportsDisable: true`); `^glm-5-turbo`, `^glm-5v-turbo`, `^glm-5\.1`, `^glm-5`, `^glm-(4\.5|4\.6|4\.7)` (`toggle`, `thinking-type`).
   - **Qwen (`qwen`)**: `-thinking$` (`fixed-on`, `requestStyle: "none"`); `^qwen3`, `^qwen-(max|plus|turbo)` (`toggle`, `qwen-enable-thinking`).
   - **Kimi (`kimi`)**: `^kimi-k3` (`effort`, `low/high/max`, `openai-effort`, `supportsDisable: false`); `^kimi-k2\.7-code-highspeed$`, `^kimi-k2\.7-code$`, `^kimi-k2-thinking` (`fixed-on`, `requestStyle: "none"`); `^kimi-k2\.6` (`toggle`, `thinking-type`, `keepOnTools: true`); `^kimi-k2\.5` (`toggle`, `thinking-type`, `keepOnTools: false`).
   - **MiniMax (`minimax`)**: `^MiniMax-M3` (`toggle`, `anthropic-adaptive`, `supportsDisable: true`); `^MiniMax-M2\.` (`fixed-on`, `requestStyle: "none"`).
   - **MiMo (`mimo`)**: `^mimo-v2\.` (`toggle`, `thinking-type`, `supportsDisable: true`).
   - **OpenRouter (`openrouter`)**: `/.*/` (`ownProviderOnly: true`, `effort`, `low/medium/high/max`, default `medium`, `openrouter-reasoning` — maps `"max"` to `"xhigh"`, `"off"` to `"none"`, omits `"auto"`).

3. **Request serialization**:
   - `resolveVendorRuntimeSettings` (`src/main/model/providers/runtime-settings.ts`) restricts `thinkingOverride` and `disableMaxToken` to custom endpoints (`getCustomEndpointMode(source.provider) !== null`); official presets normalize to `{ thinkingOverride: 0, disableMaxToken: false }`.
   - `ResponsesAdapter.buildRequest` (`src/main/model/providers/responses-adapter.ts`) converts `reasoning_effort` / `output_config.effort` / `thinking` / `enable_thinking` into `reasoning: { effort }` and strips the original fields; encrypted reasoning history and `include: ["reasoning.encrypted_content"]` are emitted only when `capability.responsesEncryptedReasoning === true` and `isOfficialOpenAIEndpoint(cfg.baseUrl)` holds.

### 3.3 Tool Calling & Prompt Caching

- **`tool_choice` policy** (`src/main/model/providers/tool-choice-policy.ts`): `resolveAutomaticToolChoicePolicy` and `resolveToolChoicePolicy` omit `tool_choice` (`"omit"`) for DeepSeek whenever thinking may be active; downgrade `"named"` to `"auto"` for MiniMax, Kimi (when thinking is active), and `anthropic` transport (when thinking is active); and respect `supportedModes` fallback ordering `["named", "required", "auto", "omit"]`.
- **Prompt caching**: `AnthropicAdapter.buildRequest` (`src/main/model/providers/anthropic-adapter.ts`) adds `cache_control: { type: "ephemeral" }` to `system` and the last 2 history messages (except `MiniMax-M3`, where `supportsMessageCacheBreakpoint` disables message-level breakpoints); `OpenAICompatAdapter.applyCacheHints` (`src/main/model/providers/openai-adapter.ts`) injects `prompt_cache_key: "firefly:kimi:<sha256>"` for Kimi.
- **Per-agent routing**: `resolveAgentModelProfile` (`src/main/model/config/agent-model-routing.ts`) routes bound agent profiles or falls back to the default model profile.
