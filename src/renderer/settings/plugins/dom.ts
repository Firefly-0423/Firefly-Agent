// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const weatherEnabledCheckbox = control<HTMLInputElement | null>("plugin-weather-enabled");
export const weatherConfig = control<HTMLElement | null>("plugin-weather-config");
export const weatherSourceSelect = control<HTMLSelectElement | null>("weather-source");
export const amapFields = control<HTMLElement | null>("amap-fields");
export const amapKeyInput = control<HTMLInputElement | null>("amap-key");
export const travelEnabledCheckbox = control<HTMLInputElement | null>("plugin-travel-enabled");
export const travelConfig = control<HTMLElement | null>("plugin-travel-config");
export const travelAmapKeyInput = control<HTMLInputElement | null>("travel-amap-key");
export const musicEnabledCheckbox = control<HTMLInputElement | null>("plugin-music-enabled");
export const playwrightMcpCheckbox = control<HTMLInputElement | null>("plugin-playwright-mcp-enabled");
export const permissionBlocksWrap = control<HTMLElement | null>("plugin-file-permission");
export const permissionNote = control<HTMLElement | null>("plugin-file-note");
