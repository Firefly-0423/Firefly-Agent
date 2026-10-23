// Plugins 面板的业务逻辑：天气、出行、内置 MCP 开关的配置读取、保存与事件绑定。
// 从 settings.ts 拆分出来，依赖 ./dom 中的 plugins DOM 引用，以及 ./state 中的防抖计时器。
// 这是一个带副作用的模块：加载时就会绑定事件并做一次初始读取。

import { weatherEnabledCheckbox, weatherConfig, weatherSourceSelect, amapFields, amapKeyInput, travelEnabledCheckbox, travelConfig, travelAmapKeyInput, playwrightMcpCheckbox, musicEnabledCheckbox } from "./dom";
import { pluginsState } from "./state";

type GeneralConfig = NonNullable<Awaited<ReturnType<NonNullable<Window["settings"]>["getGeneral"]>>>;

/** 写入一个通用配置字段。窗口没有 settings 桥时直接返回；保存失败交给 onFailure 记日志，不向外抛。 */
async function writeGeneralField(field: string, value: unknown, onFailure: (err: unknown) => void): Promise<void> {
  if (!window.settings) return;
  try {
    await window.settings?.saveGeneral({ [field]: value });
  } catch (err) {
    onFailure(err);
  }
}

/** 读取通用配置后交给 apply；读取或应用时出错都交给 onFailure。 */
async function readGeneralConfig(apply: (cfg: GeneralConfig | undefined) => void, onFailure: (err: unknown) => void): Promise<void> {
  try {
    apply(await window.settings?.getGeneral());
  } catch (err) {
    onFailure(err);
  }
}

// ===== 天气（Open-Meteo / 高德） =====

export function syncWeatherConfigVisibility(): void {
  if (weatherConfig) weatherConfig.style.display = weatherEnabledCheckbox?.checked ? "block" : "none";
  syncWeatherFieldsVisibility();
}

export function syncWeatherFieldsVisibility(): void {
  const src = weatherSourceSelect?.value ?? "open-meteo";
  // 只有选择高德时才显示高德 Key 输入框
  if (amapFields) amapFields.style.display = src === "amap" ? "block" : "none";
}

export function saveWeatherField(field: string, value: unknown): Promise<void> {
  return writeGeneralField(field, value, (err) => console.warn("[plugins] 保存天气配置失败:", field, err));
}

export function loadWeatherConfig(): Promise<void> {
  return readGeneralConfig((cfg) => {
    if (cfg) {
      if (weatherEnabledCheckbox) weatherEnabledCheckbox.checked = Boolean(cfg.weatherEnabled);
      if (weatherSourceSelect) weatherSourceSelect.value = cfg.weatherSource === "amap" ? "amap" : "open-meteo";
      if (amapKeyInput) amapKeyInput.value = String(cfg.amapKey ?? "");
    }
    syncWeatherConfigVisibility();
  }, (err) => console.warn("[plugins] 加载天气配置失败", err));
}

// ===== 出行工具 =====

export function syncTravelConfigVisibility(): void {
  if (travelConfig) travelConfig.style.display = travelEnabledCheckbox?.checked ? "block" : "none";
}

export function saveTravelField(field: string, value: unknown): Promise<void> {
  return writeGeneralField(field, value, (err) => console.warn("[plugins] 保存出行配置失败:", field, err));
}

export function loadTravelConfig(): Promise<void> {
  return readGeneralConfig((cfg) => {
    if (cfg) {
      if (travelEnabledCheckbox) travelEnabledCheckbox.checked = Boolean(cfg.travelEnabled);
      if (travelAmapKeyInput) travelAmapKeyInput.value = String(cfg.amapKey ?? "");
    }
    syncTravelConfigVisibility();
  }, (err) => console.warn("[plugins] 加载出行配置失败", err));
}

// ===== 内置 MCP 工具开关 =====
// Playwright MCP（浏览器自动化）由 playwrightMcpEnabled 控制；
// 主进程的 syncPlaywrightMcp() 会监听该字段变化，自动注册或移除 MCP server。

export function saveBuiltinMcpField(field: string, value: unknown): Promise<void> {
  return writeGeneralField(field, value, (err) => console.warn(`[settings] 保存 ${field} 失败:`, err));
}

export function loadBuiltinMcpToggles(): Promise<void> {
  return readGeneralConfig((cfg) => {
    if (cfg && musicEnabledCheckbox) {
      // 没有这个字段时按开启处理：升级前音乐工具一直是可用的
      musicEnabledCheckbox.checked = cfg.musicEnabled !== false;
    }
    if (cfg && playwrightMcpCheckbox) {
      // 默认关闭：浏览器使用系统 Edge，MCP 随应用一起提供，不需要额外下载
      playwrightMcpCheckbox.checked = Boolean(cfg.playwrightMcpEnabled);
    }
  }, (err) => console.warn("[settings] 加载内置 MCP 开关失败", err));
}

// ===== 事件绑定（模块加载时执行） =====
weatherEnabledCheckbox?.addEventListener("change", function () {
  syncWeatherConfigVisibility();
  void saveWeatherField("weatherEnabled", this.checked);
});
weatherSourceSelect?.addEventListener("change", function () {
  syncWeatherFieldsVisibility();
  void saveWeatherField("weatherSource", this.value);
});
amapKeyInput?.addEventListener("change", function () {
  void saveWeatherField("amapKey", this.value.trim());
});
// 防抖保存：粘贴后 800ms 自动保存
amapKeyInput?.addEventListener("input", function () {
  clearTimeout(pluginsState.amapKeyDebounceTimer);
  pluginsState.amapKeyDebounceTimer = setTimeout(() => {
    void saveWeatherField("amapKey", this.value.trim());
  }, 800);
});

travelEnabledCheckbox?.addEventListener("change", function () {
  syncTravelConfigVisibility();
  void saveTravelField("travelEnabled", this.checked);
});
travelAmapKeyInput?.addEventListener("change", function () {
  // 存到同一个 amapKey 字段（与天气查询共用）
  void saveTravelField("amapKey", this.value.trim());
});
// 防抖保存：粘贴后 800ms 自动保存
travelAmapKeyInput?.addEventListener("input", function () {
  clearTimeout(pluginsState.travelAmapKeyDebounceTimer);
  pluginsState.travelAmapKeyDebounceTimer = setTimeout(() => {
    void saveTravelField("amapKey", this.value.trim());
  }, 800);
});

musicEnabledCheckbox?.addEventListener("change", function () {
  void saveBuiltinMcpField("musicEnabled", this.checked);
});

playwrightMcpCheckbox?.addEventListener("change", function () {
  void saveBuiltinMcpField("playwrightMcpEnabled", this.checked);
});

// 模块加载时各读取一次配置，顺序：天气 → 出行 → 内置 MCP
for (const load of [loadWeatherConfig, loadTravelConfig, loadBuiltinMcpToggles]) void load();
