// 保持模块初始化时的查找顺序，卡片组提供与旧选择框相同的接口。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const apiForm = control<HTMLFormElement>("api-form");
export const apiRuntimeForm = control<HTMLFormElement>("api-runtime-form");
export const presetCards = control<HTMLElement>("preset-cards");
export const profileList = control<HTMLElement>("model-profile-list");
export const profileListCount = control<HTMLElement>("profile-list-count");
export const profileEditorTitle = control<HTMLElement>("profile-editor-title");
export const deleteProfileBtn = control<HTMLButtonElement>("delete-profile-btn");
export const presetWebsiteLink = control<HTMLAnchorElement>("preset-website-link");
export const displayNameInput = control<HTMLInputElement>("display-name");
export const baseUrlInput = control<HTMLInputElement>("base-url");
export const baseUrlResetBtn = control<HTMLButtonElement>("base-url-reset-btn");
export const modelInput = control<HTMLInputElement>("model-input");
export const modelInputSuggestions = control<HTMLDataListElement>("model-input-suggestions");
export const contextWindowInput = control<HTMLInputElement>("context-window-input");
export const inputModalitiesSelect = control<HTMLElement>("input-modalities-select");
export const inputModalitiesHint = control<HTMLElement>("input-modalities-hint");
export const apiKeyInput = control<HTMLInputElement>("api-key");
export const apiKeyLabel = control<HTMLElement>("api-key-label");
export const apiKeyHint = control<HTMLElement>("api-key-hint");
export const testConnectionBtn = control<HTMLButtonElement | null>("test-connection-btn");

const protocolHost = document.getElementById("transport-select");
const protocolCards = Array.from(
  protocolHost?.querySelectorAll<HTMLButtonElement>("button[data-value]") ?? [],
);
let selectedProtocol = protocolCards[0]?.dataset.value ?? "openai";
const observers = new Set<() => void>();

function refreshCards(): void {
  protocolCards.forEach((card) => {
    const pressed = card.dataset.value === selectedProtocol;
    card.classList.toggle("is-active", pressed);
    card.setAttribute("aria-pressed", pressed ? "true" : "false");
  });
}

protocolCards.forEach((card) => {
  card.addEventListener("click", () => {
    if (card.disabled) return;
    if (card.dataset.value === selectedProtocol) return;
    selectedProtocol = card.dataset.value ?? selectedProtocol;
    refreshCards();
    observers.forEach((notify) => notify());
  });
});
refreshCards();

export const transportSelect = {
  get value(): string { return selectedProtocol; },
  set value(next: string) {
    if (selectedProtocol === next) return;
    selectedProtocol = next;
    refreshCards();
  },
  get disabled(): boolean {
    return protocolCards.length > 0 && protocolCards.every((card) => card.disabled);
  },
  set disabled(next: boolean) {
    protocolCards.forEach((card) => { card.disabled = next; });
  },
  addEventListener(type: "change", listener: () => void): void {
    if (type === "change") observers.add(listener);
  },
};

export const transportHint = control<HTMLElement>("transport-hint");
export const endpointPreview = control<HTMLElement>("endpoint-preview");
export const customEndpointControls = control<HTMLElement>("custom-endpoint-controls");
export const customEndpointOverrides = control<HTMLElement>("custom-endpoint-overrides");
export const customEndpointSummary = control<HTMLElement>("custom-endpoint-summary");
export const customEndpointGuideBtn = control<HTMLButtonElement>("custom-endpoint-guide-btn");
export const workFlowAdaptBtn = control<HTMLButtonElement | null>("work-flow-adapt-btn");
export const apiNoteText = control<HTMLElement>("api-note-text");
export const fetchModelsBtn = control<HTMLButtonElement | null>("fetch-models-btn");
export const fetchModelsStatus = control<HTMLElement | null>("fetch-models-status");
export const fetchModelsPicker = control<HTMLElement | null>("fetch-models-picker");
export const fetchModelsSearch = control<HTMLInputElement | null>("fetch-models-search");
export const fetchModelsList = control<HTMLElement | null>("fetch-models-list");
export const fetchModelsEmpty = control<HTMLElement | null>("fetch-models-empty");
export const embeddingDimensionsInput = control<HTMLInputElement | null>("embedding-dimensions-input");
export const modelRequestTimeoutSecInput = control<HTMLInputElement>("model-request-timeout-sec");
export const modelRequestTimeoutSecReset = control<HTMLButtonElement>("model-request-timeout-sec-reset-btn");
export const toggleEnableThinking = control<HTMLInputElement>("toggle-enable-thinking");
export const toggleDisableThinking = control<HTMLInputElement>("toggle-disable-thinking");
export const toggleDisableMaxToken = control<HTMLInputElement>("toggle-disable-max-token");
