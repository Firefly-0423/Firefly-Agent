import { BrowserWindow } from "electron";
import { createReactChatSessionDispatcher, type ReactChatSessionDispatcher } from "../chats/react-chat-session-dispatcher";

// 辅助窗口的共享引用集中在此模块，供窗口工厂与 IPC handler 读取。
// 外部模块拿到的是只读绑定，写入必须经由下方的 set* 函数。
export let toastWindow = null as BrowserWindow | null;
export let settingsWindow = null as BrowserWindow | null;
export let sidebarWindow = null as BrowserWindow | null;
export let reactChatWindow = null as BrowserWindow | null;
export let stickerManagerWindow = null as BrowserWindow | null;

export function setReactChatWindow(win: BrowserWindow | null): void { reactChatWindow = win; }
export function setToastWindow(win: BrowserWindow | null): void { toastWindow = win; }
export function setSidebarWindow(win: BrowserWindow | null): void { sidebarWindow = win; }
export function setSettingsWindow(win: BrowserWindow | null): void { settingsWindow = win; }
export function setStickerManagerWindow(win: BrowserWindow | null): void { stickerManagerWindow = win; }

// 启动期门闸：启动完成前新建的辅助窗口暂不显示，收到 STARTUP_READY 后统一放出。
let startupGateOpen = false;
let startupGateSealed = true;
const deferredShow = new Set<BrowserWindow>();

export function isStartupPhaseActive(): boolean {
  return startupGateSealed;
}

export function markStartupPhaseReady(): void {
  if (startupGateOpen) return;
  startupGateOpen = true;
  startupGateSealed = false;
  deferredShow.forEach((win) => {
    if (!win.isDestroyed()) win.show();
  });
  deferredShow.clear();
}

export function showWindowWhenStartupReady(win: BrowserWindow): void {
  const mustDefer = !startupGateOpen && startupGateSealed;
  if (mustDefer) {
    deferredShow.add(win);
  } else {
    win.show();
  }
}

/** React 聊天窗口的会话调度器：记录窗口 ready 状态与待切换的 sessionId。 */
export const reactChatSession: ReactChatSessionDispatcher = createReactChatSessionDispatcher();

/** 应用图标路径的取值函数，默认返回空串；由初始化阶段通过 setter 注入。 */
export let getCurrentAppIconPath: () => string = () => "";
export function setGetCurrentAppIconPath(fn: () => string): void { getCurrentAppIconPath = fn; }
