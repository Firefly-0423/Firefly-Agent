import type {} from "../../global";
import { applyProviderEditorLayout } from "./provider-editor";
import { resolveApiEndpoint, type ApiTransport } from "../../../shared/api-endpoint";
import { CUSTOM_ENDPOINT_PROVIDERS, getCustomEndpointMode, getCustomEndpointPresentation, validateCustomEndpointConfig } from "../custom-endpoint-state";
import { apiState } from "./state";
import { apiForm, presetCards, presetWebsiteLink, displayNameInput, baseUrlInput, baseUrlResetBtn, modelInput, apiKeyInput, apiKeyLabel, apiKeyHint, transportSelect, transportHint, endpointPreview, customEndpointControls, customEndpointOverrides, customEndpointSummary, workFlowAdaptBtn, apiNoteText } from "./dom";
import type { ModelPreset } from "../shared/types";
import { selectButtons } from "../shared/option-group";
import { MODEL_PRESETS, sortPresetsForDisplay } from "./presets";
import { showHtmlModal } from "../shared/modal";
import { setSaveStatus } from "../shared/save-status";
import { t } from "../i18n";

export function initEndpointView(hooks: { fillModelOptions: (preset: ModelPreset, preferredModel?: string) => void; updateProfileDraftState: () => void }) {
const { fillModelOptions, updateProfileDraftState } = hooks;
function presetLogo(preset: ModelPreset): HTMLSpanElement {
  const logo = document.createElement("span");
  logo.className = "preset-card__logo";
  if (!preset.iconUrl) {
    logo.textContent = preset.shortName.charAt(0);
    return logo;
  }
  const image = document.createElement("img");
  Object.assign(image, { src: preset.iconUrl, alt: "", width: 24, height: 24 });
  logo.appendChild(image);
  return logo;
}

function fillPresetOptions(): void {
  if (!presetCards) return;
  presetCards.replaceChildren();
  const visible = sortPresetsForDisplay(MODEL_PRESETS).filter(preset => !preset.hiddenInPresetList && !preset.customEndpointMode);
  visible.forEach(preset => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "preset-card";
    choice.dataset.provider = preset.providerName;
    if (preset.disabled) {
      choice.classList.add("is-disabled");
      choice.disabled = true;
    }
    choice.appendChild(presetLogo(preset));
    const name = document.createElement("span");
    name.className = "preset-card__name";
    name.textContent = preset.shortName;
    if (preset.disabled) name.textContent += t("settings.preset.disabledSuffix");
    choice.appendChild(name);
    presetCards.appendChild(choice);
  });
}

function setActivePresetCard(provider: string): void {
  if (!presetCards) return;
  const selected = getCustomEndpointMode(provider) ? CUSTOM_ENDPOINT_PROVIDERS.cloud : provider;
  for (const card of presetCards.querySelectorAll<HTMLElement>(".preset-card")) {
    card.classList.toggle("is-active", card.dataset.provider === selected);
  }
}

function findPreset(provider: string): ModelPreset {
  const firstAvailable = MODEL_PRESETS.find(candidate => !candidate.disabled) ?? MODEL_PRESETS[0];
  return MODEL_PRESETS.find(candidate => candidate.providerName === provider) ?? firstAvailable;
}

/** 模式按钮已删除——模型名永远从 input 读取。保留函数名供旧调用点用，语义不变。 */
function getCurrentModelValue(): string {
  return modelInput.value;
}

const LOCAL_ENDPOINT_AUTH_FALLBACK = "__FIREFLY_LOCAL_NO_AUTH__";

function getApiKeyForRequest(): string {
  const key = apiKeyInput.value.trim();
  if (getCustomEndpointMode(apiState.activeProvider) !== "local" || key) return key;
  return LOCAL_ENDPOINT_AUTH_FALLBACK;
}

function validateActiveCustomEndpoint(): string | null {
  const kind = getCustomEndpointMode(apiState.activeProvider);
  return kind ? validateCustomEndpointConfig(kind, {
    baseUrl: baseUrlInput.value,
    model: getCurrentModelValue(),
    apiKey: apiKeyInput.value,
  }) : null;
}

function updateEndpointPreview(): void {
  const protocol = transportSelect.value as ApiTransport;
  const address = baseUrlInput.value.trim();
  const defaultSuffix = protocol === "anthropic" ? "/v1/messages" : protocol === "responses" ? "/responses" : "/chat/completions";
  if (!address) {
    endpointPreview.textContent = t("settings.api.endpointPreview.default", { defaultSuffix });
    return;
  }
  const resolved = resolveApiEndpoint(address, protocol);
  endpointPreview.textContent = resolved.appendedSuffix
    ? t("settings.api.endpointPreview.suffix", { appendedSuffix: resolved.appendedSuffix, url: resolved.url })
    : t("settings.api.endpointPreview.full", { url: resolved.url });
}

function applyCustomEndpointUI(preset: ModelPreset): void {
  const mode = getCustomEndpointMode(preset.providerName);
  customEndpointControls.hidden = mode === null || Boolean(apiState.editingProfileId);
  customEndpointOverrides.hidden = mode === null;
  transportSelect.disabled = false;
  if (mode) {
    apiState.customEndpointMode = mode;
    const view = getCustomEndpointPresentation(mode);
    selectButtons(customEndpointControls, "[data-custom-endpoint-mode]", button => button.dataset.customEndpointMode === mode);
    customEndpointSummary.textContent = t(mode === "local" ? "settings.customEndpoint.localHint" : "settings.customEndpoint.cloudHint");
    apiKeyLabel.textContent = view.apiKeyOptional ? t("settings.customEndpoint.apiKey.optional") : "API Key";
    apiKeyHint.textContent = t(view.apiKeyOptional ? "settings.customEndpoint.apiKey.localHint" : "settings.customEndpoint.apiKey.proxyHint");
    apiKeyInput.placeholder = view.apiKeyOptional ? t("settings.customEndpoint.apiKey.optionalPlaceholder") : "sk-...";
    baseUrlInput.placeholder = view.baseUrlPlaceholder;
    modelInput.placeholder = t("settings.customEndpoint.modelPlaceholder");
    transportHint.textContent = t("settings.customEndpoint.transportHint");
    baseUrlResetBtn.title = t("settings.customEndpoint.baseUrlResetTitle");
    apiNoteText.textContent = t("settings.customEndpoint.note");
    return;
  }
  apiKeyLabel.textContent = "API Key";
  apiKeyHint.textContent = t("settings.api.keyHint.default");
  apiKeyInput.placeholder = "sk-...";
  baseUrlInput.placeholder = "https://api.deepseek.com";
  modelInput.placeholder = t("settings.api.modelPlaceholder.default");
  transportHint.textContent = t("settings.api.transportHint.default");
  baseUrlResetBtn.title = t("settings.api.baseUrlResetTitle.default");
  apiNoteText.textContent = t("settings.api.note.default");
}

function presetAddress(preset: ModelPreset, protocol: ApiTransport, address: string): string {
  if (!preset.anthropicBaseUrl) return address;
  if (protocol === "anthropic" && address === preset.baseUrl) return preset.anthropicBaseUrl;
  if ((protocol === "openai" || protocol === "responses") && address === preset.anthropicBaseUrl) return preset.baseUrl;
  return address;
}

function showPresetWebsite(preset: ModelPreset): void {
  if (!preset.websiteUrl) {
    presetWebsiteLink.style.display = "none";
    return;
  }
  presetWebsiteLink.href = preset.websiteUrl;
  presetWebsiteLink.title = t("settings.preset.websiteTitle", { shortName: preset.shortName });
  presetWebsiteLink.style.display = "";
}

function applyPreset(
  providerName: string,
  preferredModel?: string,
  preferredApiKey?: string,
  preferredBaseUrl?: string,
  preferredDisplayName?: string,
  preferredExplicitTransport?: ApiTransport,
): void {
  const chosen = findPreset(providerName);
  setActivePresetCard(chosen.providerName);
  displayNameInput.value = preferredDisplayName && preferredDisplayName !== chosen.shortName ? preferredDisplayName : "";
  displayNameInput.placeholder = chosen.shortName;
  const protocol = preferredExplicitTransport ?? chosen.transport;
  baseUrlInput.value = presetAddress(chosen, protocol, preferredBaseUrl ?? chosen.baseUrl);
  fillModelOptions(chosen, preferredModel);
  const custom = getCustomEndpointMode(chosen.providerName);
  // 无鉴权的本地标记不显示在输入框；切换档案必须清掉上一份密钥。
  apiKeyInput.value = custom === "local" && preferredApiKey === LOCAL_ENDPOINT_AUTH_FALLBACK ? "" : preferredApiKey ?? "";
  transportSelect.value = protocol;
  applyCustomEndpointUI(chosen);
  updateEndpointPreview();
  showPresetWebsite(chosen);
  apiState.activeProvider = chosen.providerName;
  applyProviderEditorLayout(apiForm, custom ? "custom" : "preset", Boolean(apiState.editingProfileId));
}

// ── 模型厂商 Work 流程适配说明 ──────────────────────────────
// 展示各厂商结构化输出档位与实测兼容性；「详细文档」在 app 内本地渲染完整实测报告。
// 模型厂商 Work 流程适配（手写 HTML，避免引入 markdown 渲染依赖）
const WORK_FLOW_COMPAT_MD = `
<h2>模型兼容性</h2>
<blockquote>流萤会根据不同厂商自动选择对应的 Structured Output Profile。</blockquote>
<table>
  <thead>
    <tr><th>厂商</th><th>支持状态</th><th>档位</th><th>已实测模型</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td>OpenAI</td><td>⚠️ 文档适配</td><td>A</td><td>-</td><td>已完成官方协议适配，等待实测。</td></tr>
    <tr><td>Claude</td><td>⚠️ 文档适配</td><td>A</td><td>-</td><td>已完成官方协议适配，等待实测。</td></tr>
    <tr><td>Kimi</td><td>✅ 已实测</td><td>A</td><td>K2.6、K2.7 Code</td><td>推荐普通 API，Coding 端点不建议用于 Work。</td></tr>
    <tr><td>DeepSeek</td><td>✅ 已实测</td><td>B</td><td>V4.1 Flash、V4 Pro</td><td>推荐，速度快、稳定。</td></tr>
    <tr><td>Qwen</td><td>✅ 已实测</td><td>B</td><td>Qwen3.7 Max</td><td>推荐，表现稳定。</td></tr>
    <tr><td>GLM</td><td>✅ 已实测</td><td>B</td><td>GLM 5.1、5.2</td><td>推荐，4.7 不建议。</td></tr>
    <tr><td>MiMo</td><td>✅ 已实测</td><td>B</td><td>MiMo 2.5、2.5 Pro</td><td>推荐，表现稳定。</td></tr>
    <tr><td>MiniMax</td><td>✅ 已实测</td><td>M</td><td>MiniMax M3</td><td>推荐，需使用 M 档适配。</td></tr>
    <tr><td>OpenRouter</td><td>⚠️ 文档适配</td><td>D</td><td>-</td><td>聚合网关，型号由所选模型决定，未实测；请自行验证。</td></tr>
    <tr><td>其他模型</td><td>⚠️ 文档适配</td><td>D</td><td>-</td><td>使用通用兼容模式，请自行验证。</td></tr>
  </tbody>
</table>
<h3>档位说明</h3>
<ul>
  <li><strong>A</strong>：原生 JSON Schema / Function Calling</li>
  <li><strong>B</strong>：JSON Object + 本地校验</li>
  <li><strong>M</strong>：MiniMax 专用适配</li>
  <li><strong>D</strong>：通用兼容模式（未知模型 / 自定义端点）</li>
</ul>
`.trim();

function buildWorkFlowAdaptBody(): string {
  return [
    '<div class="custom-endpoint-guide-warning work-flow-adapt-meta">',
    "  <strong>模型厂商 Work 流程适配</strong>",
    '  <span class="work-flow-adapt-date">最新更新于 2026/7/24</span>',
    "</div>",
    `<div class="work-flow-adapt-table">${WORK_FLOW_COMPAT_MD}</div>`,
  ].join("\n");
}

workFlowAdaptBtn?.addEventListener("click", () => {
  void showHtmlModal({
    title: t("settings.workFlow.adaptTitle"),
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.25" r="1.1" fill="currentColor"/></svg>',
    htmlBody: buildWorkFlowAdaptBody(),
  });
});

baseUrlResetBtn.addEventListener("click", () => {
  const chosen = findPreset(apiState.activeProvider);
  if (!chosen) return;
  baseUrlInput.value = transportSelect.value === "anthropic" && chosen.anthropicBaseUrl ? chosen.anthropicBaseUrl : chosen.baseUrl;
  updateEndpointPreview();
  setSaveStatus(t("settings.api.baseUrlResetOk"));
  updateProfileDraftState();
});

function changeTransport(): void {
  const chosen = findPreset(apiState.activeProvider);
  const stripSlash = (url: string): string => url.replace(/\/$/, "");
  const address = stripSlash(baseUrlInput.value.trim());
  const known = [chosen.baseUrl, chosen.anthropicBaseUrl].filter((url): url is string => Boolean(url)).map(stripSlash);
  const protocol = transportSelect.value;
  if (known.includes(address)) {
    if (protocol === "anthropic" && chosen.anthropicBaseUrl) baseUrlInput.value = chosen.anthropicBaseUrl;
    else if (protocol === "openai" || protocol === "responses") baseUrlInput.value = chosen.baseUrl;
  }
  updateEndpointPreview();
  if (protocol === "anthropic" && !chosen.anthropicBaseUrl && chosen.transport !== "anthropic") {
    transportHint.textContent = t("settings.api.anthropicHintMissing");
  }
  setSaveStatus(t("settings.status.dirty"));
  updateProfileDraftState();
}
baseUrlInput.addEventListener("input", updateEndpointPreview);
transportSelect.addEventListener("change", changeTransport);


return { fillPresetOptions, findPreset, applyPreset, getCurrentModelValue, getApiKeyForRequest, validateActiveCustomEndpoint };
}
