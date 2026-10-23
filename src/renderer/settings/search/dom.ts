// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const searchEnabledCheckbox = control<HTMLInputElement | null>("plugin-search-enabled");
export const searchConfig = control<HTMLElement | null>("plugin-search-config");
export const searchEngineSelect = control<HTMLSelectElement | null>("search-engine");
export const searchBochaKeyInput = control<HTMLInputElement | null>("search-bocha-key");
export const searchTavilyKeyInput = control<HTMLInputElement | null>("search-tavily-key");
export const searchMinimaxKeyInput = control<HTMLInputElement | null>("search-minimax-key");
export const searchAnySearchKeyInput = control<HTMLInputElement | null>("search-anysearch-key");
export const searchBochaRow = control<HTMLElement | null>("search-bocha-row");
export const searchTavilyRow = control<HTMLElement | null>("search-tavily-row");
export const searchMinimaxRow = control<HTMLElement | null>("search-minimax-row");
export const searchAnySearchRow = control<HTMLElement | null>("search-anysearch-row");
