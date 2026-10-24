import {
  searchEnabledCheckbox, searchConfig,
  searchEngineSelect, searchBochaKeyInput, searchTavilyKeyInput,
  searchMinimaxKeyInput, searchAnySearchKeyInput, searchBochaRow,
  searchTavilyRow, searchMinimaxRow, searchAnySearchRow,
} from "./dom";

// 展示与密钥保存沿用同一厂商顺序。
const searchProviders = [
  { engine: "bocha", row: searchBochaRow, input: searchBochaKeyInput, field: "searchBochaKey" },
  { engine: "tavily", row: searchTavilyRow, input: searchTavilyKeyInput, field: "searchTavilyKey" },
  { engine: "minimax", row: searchMinimaxRow, input: searchMinimaxKeyInput, field: "searchMinimaxKey" },
  { engine: "anySearch", row: searchAnySearchRow, input: searchAnySearchKeyInput, field: "searchAnySearchKey" },
];
let persistedEngine = "off";
let rememberedProvider = "bocha";
let selectionPending = false;

export function syncSearchConfigVisibility(): void {
  if (searchConfig !== null) {
    searchConfig.style.display = searchEnabledCheckbox?.checked ? "block" : "none";
  }
  syncSearchEngineRows();
}

export function syncSearchEngineRows(): void {
  const selected = searchEngineSelect?.value ?? "off";
  for (const provider of searchProviders) {
    if (provider.row) provider.row.style.display = provider.engine === selected ? "flex" : "none";
  }
}

export async function saveSearchField(field: string, value: unknown): Promise<boolean> {
  if (window.settings) {
    try {
      await window.settings?.saveGeneral({ [field]: value });
      return true;
    } catch (failure) {
      console.warn("[plugins] 保存搜索配置失败:", field, failure);
    }
  }
  return false;
}

export async function loadSearchConfig(): Promise<void> {
  try {
    const stored = await window.settings?.getGeneral();
    if (!stored) return;
    const restoredEngine = String(stored.searchEngine ?? "off");
    persistedEngine = restoredEngine;
    if (restoredEngine !== "off") rememberedProvider = restoredEngine;
    if (searchEngineSelect) searchEngineSelect.value = rememberedProvider;
    if (searchBochaKeyInput) searchBochaKeyInput.value = String(stored.searchBochaKey ?? "");
    if (searchTavilyKeyInput) searchTavilyKeyInput.value = String(stored.searchTavilyKey ?? "");
    if (searchMinimaxKeyInput) searchMinimaxKeyInput.value = String(stored.searchMinimaxKey ?? "");
    if (searchAnySearchKeyInput) searchAnySearchKeyInput.value = String(stored.searchAnySearchKey ?? "");
    if (searchEnabledCheckbox) searchEnabledCheckbox.checked = restoredEngine !== "off";
    syncSearchConfigVisibility();
  } catch (failure) {
    console.warn("[plugins] 加载搜索配置失败", failure);
  }
}

function disableSearchSelection(disabled: boolean): void {
  if (searchEnabledCheckbox) searchEnabledCheckbox.disabled = disabled;
  if (searchEngineSelect) searchEngineSelect.disabled = disabled;
}

async function saveSearchEngineSelection(): Promise<void> {
  if (selectionPending) return;
  selectionPending = true;
  disableSearchSelection(true);
  const provider = searchEngineSelect?.value || rememberedProvider;
  const requestedEngine = searchEnabledCheckbox?.checked ? provider : "off";
  try {
    const saved = await saveSearchField("searchEngine", requestedEngine);
    if (saved) {
      persistedEngine = requestedEngine;
      rememberedProvider = provider;
    } else {
      if (searchEnabledCheckbox) searchEnabledCheckbox.checked = persistedEngine !== "off";
      if (searchEngineSelect) searchEngineSelect.value = rememberedProvider;
    }
  } finally {
    selectionPending = false;
    disableSearchSelection(false);
    syncSearchConfigVisibility();
  }
}

function changedSearchEnablement(): void {
  syncSearchConfigVisibility();
  void saveSearchEngineSelection();
}
function changedSearchProvider(): void {
  syncSearchEngineRows();
  void saveSearchEngineSelection();
}
searchEnabledCheckbox?.addEventListener("change", changedSearchEnablement);
searchEngineSelect?.addEventListener("change", changedSearchProvider);

const credentialTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
for (const { engine, input, field } of searchProviders) {
  if (input === null) continue;
  const persist = (): void => { void saveSearchField(field, input.value.trim()); };
  input.addEventListener("change", persist);
  input.addEventListener("blur", persist);
  input.addEventListener("input", () => {
    clearTimeout(credentialTimers[engine]);
    credentialTimers[engine] = setTimeout(persist, 800);
  });
}
void loadSearchConfig();
