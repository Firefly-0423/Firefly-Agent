import { screen, type BrowserWindow } from "electron";
import fs from "node:fs";
import { AtomicJsonStore } from "../atomic-json-store";
import { getStorageContext } from "../storage-context";
import { isChatWindowState, resolveChatWindow, type ChatWindowState, type ResolvedChatWindow } from "./chat-window-state";

const SAVE_DELAY_MS = 400;

function openStore(): { store: AtomicJsonStore<ChatWindowState>; file: string } | undefined {
  try {
    const file = getStorageContext().files.chatWindowState;
    return { store: new AtomicJsonStore<ChatWindowState>(file, isChatWindowState), file };
  } catch { return undefined; }
}

/** The store never overwrites an unreadable file, so a corrupt one would block saving forever; this file is only a convenience, so set it aside and write a fresh one. */
function writeReplacingInvalid(opened: NonNullable<ReturnType<typeof openStore>>, state: ChatWindowState): void {
  try {
    opened.store.write(state);
  } catch (error) {
    if ((error as Error).message !== "ATOMIC_JSON_EXISTING_INVALID") throw error;
    fs.renameSync(opened.file, `${opened.file}.invalid`);
    opened.store.write(state);
  }
}

/** 窗口位置只是便利：读不到、文件损坏、存储未就绪，都退回首次居中，绝不挡住启动。 */
function readSaved(): ChatWindowState | undefined {
  try { return openStore()?.store.read(undefined as unknown as ChatWindowState) ?? undefined; }
  catch { return undefined; }
}

/** 这次聊天窗口应该开在哪、是否最大化。 */
export function resolveInitialChatWindow(): ResolvedChatWindow {
  const cursor = screen.getCursorScreenPoint();
  const displays = screen.getAllDisplays();
  const workAreas = displays.map(display => display.workArea);
  const primary = screen.getPrimaryDisplay().workArea;
  const cursorArea = displays.find(({ workArea: { x, y, width, height } }) => cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height)?.workArea ?? primary;
  return resolveChatWindow(readSaved(), workAreas, cursorArea, primary);
}

/** 窗口移动/缩放/最大化后稍等片刻落盘，关闭时立刻落盘。最大化时记的是还原后的大小。 */
export function trackChatWindowState(window: BrowserWindow): void {
  const opened = openStore();
  if (!opened) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    try { writeReplacingInvalid(opened, { ...window.getNormalBounds(), maximized: window.isMaximized() }); }
    catch { /* best effort */ }
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  window.on("resize", later);
  window.on("move", later);
  window.on("maximize", later);
  window.on("unmaximize", later);
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
