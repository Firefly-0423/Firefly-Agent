import { app, nativeImage, type Tray } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { broadcastToAllWindows } from "../windows/broadcast";
import type { WindowManager } from "../windows/window-manager";
import { setGetCurrentAppIconPath } from "../windows/window-state";
import { normalizeChatAppearance } from "../../shared/chat-appearance";
import { updateLocaleContext } from "../locale-context";
import { validateSearchApiKey } from "../orchestrator/search-backend-filter";
import { addMcpServer, listMcpServers, removeMcpServer } from "../orchestrator/mcp-manager";
import { getAppIconPath } from "../windows/app-icon";
import { loadTrayIcon } from "../windows/tray-icon";
import { syncBuiltInToolToggles } from "../orchestrator/tools/registry/tool-registration";
import { loadModelSettings, getPublicModelConfig } from "./model-settings";
import type { GeneralSettings } from "./general-settings";
import type { UiIcon } from "../../shared/ui-icon";
import { syncLaunchAtLogin } from "./launch-at-login";

export interface GeneralSettingsLifecycleDependencies {
  get windowManager(): WindowManager | null;
  get tray(): Tray | null;
  get screenshotService(): { replaceHotkey: (hotkey: string) => { ok: boolean } | null } | null;
  get proactiveLifecycle(): { getProactiveChatService: () => { invalidate: () => void } | null };
  broadcastToAuxWindows(channel: string, payload: unknown): void;
}

type Deps = GeneralSettingsLifecycleDependencies;

const MINIMAX_MCP_ID = "minimax-web-search";

/** 对象类设置用 JSON 形态比较是否变化。 */
const jsonChanged = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** 启动时（无 before）整体应用窗口类设置；保存时仅处理发生变化的项。 */
export function applyGeneralSettings(settings: GeneralSettings, deps: Deps, before?: GeneralSettings): void {
  const moved = (read: (s: GeneralSettings) => unknown): boolean => !before || read(before) !== read(settings);

  if (moved((s) => s.petAlwaysOnTop)) {
    deps.windowManager?.setPetWindowAlwaysOnTop(settings.petAlwaysOnTop);
  }
  if (moved((s) => s.petVisible)) {
    const manager = deps.windowManager;
    if (settings.petVisible) {
      manager?.showPetWindow();
    } else {
      manager?.hidePetWindow();
    }
  }
  if (moved((s) => s.launchAtLogin)) {
    syncLaunchAtLogin(settings.launchAtLogin, app);
  }
  if (moved((s) => s.petZoom)) {
    deps.windowManager?.applyPetWindowZoom(settings.petZoom);
  }
}

/** 切换应用图标。图标文件加载失败时仅告警，保留当前图标。 */
export function applyUiIcon(iconSetting: UiIcon, deps: Deps): void {
  const image = nativeImage.createFromPath(getAppIconPath(iconSetting));
  if (image.isEmpty()) {
    console.warn("[Firefly] failed to load selected app icon:", iconSetting);
    return;
  }
  deps.tray?.setImage(loadTrayIcon());
  deps.windowManager?.setIconForAllWindows(image);
}

/** 生成 MiniMax 搜索 MCP 的注册参数，密钥在此统一去除首尾空白。 */
function minimaxRegistration(rawKey: string) {
  const env = { MINIMAX_API_KEY: rawKey.trim(), MINIMAX_API_HOST: "https://api.minimaxi.com" };
  return { id: MINIMAX_MCP_ID, name: "MiniMax搜索", transport: "stdio" as const, command: "uvx", args: ["minimax-coding-plan-mcp", "-y"], env };
}

/** 依据“选用 MiniMax”和“已注册”两个开关，同步 MCP 服务，并返回一段描述结果的字符串。 */
export async function syncVolcanoSearchMcp(settings: GeneralSettings): Promise<{ mcpSyncResult: string }> {
  const selected = settings.searchEngine === "minimax";
  const installed = listMcpServers().some((server) => server.id === MINIMAX_MCP_ID);

  if (selected) {
    const verdict = validateSearchApiKey(settings.searchMinimaxKey, "MiniMax API Key");
    const { length, trimmed, hasNonAscii, hasControlChars } = verdict.diagnostics;
    console.log(`[Firefly] MiniMax Key 校验: length=${length} trimmed=${trimmed} nonAscii=${hasNonAscii} controlChars=${hasControlChars}`);
    if (!verdict.valid) {
      console.error(`[Firefly] MiniMax Key 校验失败: ${verdict.error}`);
      if (installed) {
        try { await removeMcpServer(MINIMAX_MCP_ID); } catch (err) { console.error("[Firefly] MiniMax 搜索 MCP 移除异常:", err); }
      }
      return { mcpSyncResult: `key_invalid: ${verdict.error}` };
    }
  }

  // 情形一：选用且未注册 -> 注册
  if (selected && !installed) {
    console.log("[Firefly] 注册 MiniMax 搜索 MCP Server...");
    try {
      const reply = await addMcpServer(minimaxRegistration(settings.searchMinimaxKey));
      if (!reply.ok) {
        console.error("[Firefly] MiniMax 搜索 MCP 注册失败:", reply.error);
        return { mcpSyncResult: `register_failed: ${reply.error}` };
      }
      console.log("[Firefly] MiniMax 搜索 MCP 注册成功，工具:", reply.toolIds?.join(", "));
      return { mcpSyncResult: `registered: ${reply.toolIds?.join(", ") ?? "none"}` };
    } catch (err) {
      console.error("[Firefly] MiniMax 搜索 MCP 注册异常:", err);
      return { mcpSyncResult: `register_exception: ${err}` };
    }
  }

  // 情形二：未选用但已注册 -> 移除
  if (!selected && installed) {
    console.log("[Firefly] 移除 MiniMax 搜索 MCP Server...");
    try {
      await removeMcpServer(MINIMAX_MCP_ID);
      return { mcpSyncResult: "removed" };
    } catch (err) {
      console.error("[Firefly] MiniMax 搜索 MCP 移除异常:", err);
      return { mcpSyncResult: `remove_exception: ${err}` };
    }
  }

  // 情形三：选用且已注册 -> 以新密钥重注册
  if (selected && installed) {
    console.log("[Firefly] MiniMax 搜索 key 变化，重新注册 MCP Server...");
    try {
      await removeMcpServer(MINIMAX_MCP_ID);
      const outcome = await addMcpServer(minimaxRegistration(settings.searchMinimaxKey));
      if (!outcome.ok) {
        console.error("[Firefly] MiniMax 搜索 MCP 重新注册失败:", outcome.error);
        return { mcpSyncResult: `reregister_failed: ${outcome.error}` };
      }
      return { mcpSyncResult: "reregistered" };
    } catch (err) {
      console.error("[Firefly] MiniMax 搜索 MCP 重新注册异常:", err);
      return { mcpSyncResult: `reregister_exception: ${err}` };
    }
  }

  return { mcpSyncResult: "no_change" };
}

/** 把当前公开的模型配置推送给辅助窗口。 */
export function broadcastModelConfigChanged(broadcastToAuxWindows: (channel: string, payload: unknown) => void, settings = loadModelSettings()): void {
  broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
}

// ---- 保存后的各项反应，按既定顺序在 handleGeneralSettingsChanged 中调用 ----

function reactToLocale(before: GeneralSettings, after: GeneralSettings): void {
  if (before.language === after.language && before.asrLanguage === after.asrLanguage) { return; }
  updateLocaleContext({ uiLocale: after.language, dateLocale: after.language, asrLanguage: after.asrLanguage });
}

function reactToThemeAndAppearance(before: GeneralSettings, after: GeneralSettings, deps: Deps): void {
  const broadcast = (channel: string, payload: unknown) => deps.windowManager?.broadcast(channel, payload);
  if (jsonChanged(before.uiColors, after.uiColors)) { broadcast(IPC.UI_COLORS_CHANGED, after.uiColors); }
  if (before.uiTheme !== after.uiTheme) { broadcast(IPC.UI_THEME_CHANGED, after.uiTheme); }
  if (jsonChanged(before.uiFont, after.uiFont)) { broadcast(IPC.UI_FONT_CHANGED, after.uiFont); }

  const oldLook = normalizeChatAppearance(before);
  const newLook = normalizeChatAppearance(after);
  if (jsonChanged(oldLook, newLook)) { broadcastToAllWindows(IPC.CHAT_TYPOGRAPHY_CHANGED, newLook); }
}

function reactToHotkey(before: GeneralSettings, after: GeneralSettings, deps: Deps): void {
  if (before.screenshotHotkey === after.screenshotHotkey) { return; }
  const outcome = deps.screenshotService?.replaceHotkey(after.screenshotHotkey);
  if (outcome && !outcome.ok) {
    console.warn("[Firefly] 截图热键注册失败，可能被其他应用占用:", after.screenshotHotkey);
  }
}

function reactToProactive(before: GeneralSettings, after: GeneralSettings, deps: Deps): void {
  const changed = before.proactiveChatMode !== after.proactiveChatMode || before.proactiveDeliveryTarget !== after.proactiveDeliveryTarget;
  if (changed) { deps.proactiveLifecycle.getProactiveChatService()?.invalidate(); }
}

/**
 * 保存通用设置之后的副作用调度，执行顺序固定：
 * 窗口 -> 工具开关 -> 语言 -> 颜色/主题/字体 -> 外观广播 -> 图标 -> 截图热键 -> 主动消息 -> 搜索 MCP。
 */
export function handleGeneralSettingsChanged(before: GeneralSettings, after: GeneralSettings, deps: Deps): void {
  const steps: Array<() => void> = [
    () => applyGeneralSettings(after, deps, before),
    () => syncBuiltInToolToggles(after),
    () => reactToLocale(before, after),
    () => reactToThemeAndAppearance(before, after, deps),
    () => { if (before.uiIcon !== after.uiIcon) { applyUiIcon(after.uiIcon, deps); } },
    () => reactToHotkey(before, after, deps),
    () => reactToProactive(before, after, deps),
    () => setGetCurrentAppIconPath(() => getAppIconPath(after.uiIcon)),
    () => { void syncVolcanoSearchMcp(after); },
  ];
  steps.forEach((step) => step());
}
