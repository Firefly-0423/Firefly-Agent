import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import { resolveInitialChatWindow, trackChatWindowState } from "./chat-window-placement";
import { CHAT_MIN_HEIGHT, CHAT_MIN_WIDTH } from "./chat-window-state";
import { MARK_GLASS_SCRIPT, resolveGlassWindowOptions } from "./glass-material";
import {
  stickerManagerWindow,
  showWindowWhenStartupReady,
  settingsWindow,
  setStickerManagerWindow,
  setSettingsWindow,
  setReactChatWindow,
  reactChatWindow,
  reactChatSession,
  getCurrentAppIconPath,
} from "./window-state";

/** 聊天窗口句柄：窗口对象 + 页面加载（由启动编排器调用）+ 显示。 */
export interface ReactChatWindowHandle {
  show(sessionId?: string): void;
  load(sessionId?: string): Promise<void>;
  window: BrowserWindow;
}

/** 所有辅助窗口共用的 webPreferences：开启隔离、关闭 Node 集成，并挂载统一 preload。 */
function auxWebPreferences() {
  return {
    preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  };
}

/**
 * 取得聊天窗口的 BrowserWindow（不加载页面）。
 * 页面加载必须等核心 IPC 注册完成后再由 loadReactChatWindowPage 触发。
 */
export function createReactChatWindowShell(): BrowserWindow {
  if (reactChatWindow && !reactChatWindow.isDestroyed()) return reactChatWindow;

  // 新窗口意味着会话调度状态需要重置
  reactChatSession.reset();

  const placement = resolveInitialChatWindow();
  const win = new BrowserWindow({
    ...placement.bounds,
    resizable: true,
    transparent: true,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    icon: getCurrentAppIconPath(),
    title: "流萤 · 聊天",
    minHeight: CHAT_MIN_HEIGHT,
    minWidth: CHAT_MIN_WIDTH,
    webPreferences: auxWebPreferences(),
  });
  setReactChatWindow(win);
  if (placement.maximized) win.maximize();
  trackChatWindowState(win);

  // 同文档导航（history.replaceState 等）不会卸载渲染页，因此不标记为加载中
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) reactChatSession.markLoading();
  });

  win.on("closed", () => {
    // 只有当全局引用仍指向这个窗口时才清理，防止旧窗口的 closed 误伤新窗口
    if (reactChatWindow !== win) return;
    setReactChatWindow(null);
    reactChatSession.reset();
  });
  return win;
}

/**
 * 加载聊天页面。带会话时 search 以 "?" 开头，符合 Electron 的 url 约定。
 * 加载错误原样抛出，由启动阶段统一处理。
 */
export function loadReactChatWindowPage(window: BrowserWindow, sessionId?: string): Promise<void> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : undefined;
  if (isDev) {
    return window.loadURL(`http://localhost:5173/react/${query ?? ""}`);
  }
  const indexFile = path.join(app.getAppPath(), "dist", "renderer", "react", "index.html");
  return window.loadFile(indexFile, query ? { search: query } : undefined);
}

/** 显示聊天窗口并聚焦；携带 sessionId 时顺带切换会话。 */
export function showReactChatWindow(sessionId?: string): void {
  const chat = reactChatWindow;
  if (!chat || chat.isDestroyed()) return;
  chat.show();
  chat.focus();
  if (sessionId) dispatchOrQueueReactSession(sessionId);
}

/** 若渲染页已就绪则立即发送切换指令；否则由调度器排队，等 ready 后再发。 */
export function dispatchOrQueueReactSession(sessionId: string): void {
  const win = reactChatWindow;
  if (!win?.webContents) return;
  const ready = reactChatSession.queueOrTake(sessionId);
  if (ready) win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, ready);
}

/** 旧版独立状态窗口已经下线，这里保留空实现以兼容调用方。 */
export function createSidebarWindow(): void {}

/** 打开设置窗口；已存在则复用，并在需要时切换到指定分区。 */
export function createSettingsWindow(section?: string): void {
  const current = settingsWindow;
  if (current && !current.isDestroyed()) {
    current.show();
    current.focus();
    // loadURL 不会重新触发，所以用事件通知页面切换分区
    if (section) current.webContents.send(IPC.SETTINGS_SWITCH_SECTION, section);
    return;
  }

  const { x: areaX, y: areaY, width: areaW, height: areaH } = screen.getPrimaryDisplay().workArea;
  const size = { height: 920, width: 1060 };
  const glass = resolveGlassWindowOptions(process.platform, process.getSystemVersion());
  const win = new BrowserWindow({
    y: areaY + Math.max(0, Math.floor((areaH - size.height) / 2)),
    x: areaX + Math.max(0, Math.floor((areaW - size.width) / 2)),
    ...size,
    minHeight: 580,
    minWidth: 920,
    title: "流萤 · 设置",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    // 玻璃材质的窗口选项必须压过上面的默认值，同时不能盖住下面两项
    ...glass.options,
    resizable: true,
    webPreferences: auxWebPreferences(),
  });
  setSettingsWindow(win);
  if (glass.glass) {
    // 玻璃材质需要页面侧打标记，每次 dom-ready（含重新加载）都补一次
    win.webContents.on("dom-ready", () => {
      void win.webContents.executeJavaScript(MARK_GLASS_SCRIPT).catch(() => undefined);
    });
  }

  const anchor = section ? `#${section}` : "";
  if (isDev) {
    void win.loadURL("http://localhost:5173/settings/" + anchor);
  } else {
    void win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "settings", "index.html"), {
      hash: section || "",
    });
  }

  win.once("ready-to-show", () => showWindowWhenStartupReady(win));
  win.on("closed", () => setSettingsWindow(null));
}

/** 打开表情包管理窗口。成功返回 { ok: true }，加载失败返回 { ok: false, error }。 */
export async function createStickerManagerWindow(): Promise<{ ok: boolean; error?: string }> {
  const current = stickerManagerWindow;
  if (current && !current.isDestroyed()) {
    current.show();
    current.focus();
    current.moveTop();
    return { ok: true };
  }

  const anchor = settingsWindow?.getBounds();
  const { x: areaX, y: areaY, width: areaW, height: areaH } = screen.getPrimaryDisplay().workArea;
  const width = 520;
  const height = 420;
  const win = new BrowserWindow({
    webPreferences: auxWebPreferences(),
    parent: settingsWindow ?? undefined,
    resizable: true,
    transparent: true,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    title: "表情包管理",
    minHeight: 360,
    minWidth: 460,
    height,
    width,
    y: anchor ? anchor.y + 64 : areaY + Math.max(0, Math.floor((areaH - height) / 2)),
    x: anchor
      ? anchor.x + Math.max(24, Math.floor((anchor.width - width) / 2))
      : areaX + Math.max(0, Math.floor((areaW - width) / 2)),
  });
  setStickerManagerWindow(win);

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[stickers] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  try {
    if (isDev) {
      await win.loadURL("http://localhost:5173/sticker-manager/");
    } else {
      await win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "sticker-manager", "index.html"));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[stickers] failed to load sticker manager window", error);
    win.close();
    return { ok: false, error: message };
  }

  win.once("ready-to-show", () => {
    showWindowWhenStartupReady(win);
    win.focus();
    win.moveTop();
  });
  win.on("closed", () => setStickerManagerWindow(null));

  return { ok: true };
}
