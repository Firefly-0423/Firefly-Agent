import { useEffect } from "react";

const DRAG_THRESHOLD_PX = 4;
const TITLEBAR_HEIGHT_PX = 50;
const INTERACTIVE = 'button, a, input, select, textarea, [role="tab"], [role="button"], [contenteditable="true"], [data-no-window-drag]';

/** 标题栏与工作区标题行的空白处才算窗口拖动面（交互控件、侧栏、消息区都不是）。 */
export function isWindowDragSurface(target: EventTarget | null, clientY: number): boolean {
  if (!(target instanceof Element) || target.closest(INTERACTIVE)) return false;
  if (target.closest(".ff-workspace-header")) return true;
  if (clientY > TITLEBAR_HEIGHT_PX) return false;
  return target.classList.contains("ff-page") || target.closest(".ff-page-titlebar") !== null;
}

/**
 * 无边框透明窗口最大化后，系统不会因为拖动标题栏而还原窗口。
 * 最大化时把原生拖动区关掉（见 react-root.css 的 data-window-maximized），
 * 改由这里识别拖动手势并让主进程还原窗口、跟随光标；双击标题栏同样还原。
 */
export function useMaximizedWindowDrag(): void {
  useEffect(() => {
    const chat = window.chat;
    if (typeof chat?.isMaximized !== "function") return;
    const root = document.documentElement;
    let maximized = false;
    let frame = 0;
    let pending: { id: number; x: number; y: number } | null = null;
    let dragging = false;

    const sync = () => {
      frame = 0;
      void Promise.resolve(chat.isMaximized()).then((value) => {
        maximized = value === true;
        if (maximized) root.dataset.windowMaximized = "true";
        else delete root.dataset.windowMaximized;
      }, () => {
        maximized = false;
        delete root.dataset.windowMaximized;
      });
    };
    const scheduleSync = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };

    const finish = () => {
      pending = null;
      if (dragging) {
        dragging = false;
        chat.endWindowDrag();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!maximized || event.button !== 0 || !isWindowDragSurface(event.target, event.clientY)) return;
      pending = { id: event.pointerId, x: event.screenX, y: event.screenY };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pending || event.pointerId !== pending.id) return;
      if ((event.buttons & 1) === 0) {
        pending = null;
        return;
      }
      if (Math.hypot(event.screenX - pending.x, event.screenY - pending.y) < DRAG_THRESHOLD_PX) return;
      pending = null;
      dragging = true;
      chat.startWindowDrag();
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (maximized && isWindowDragSurface(event.target, event.clientY)) chat.toggleMaximize();
    };

    sync();
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("blur", finish);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
    document.addEventListener("dblclick", onDoubleClick, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      finish();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("blur", finish);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      document.removeEventListener("dblclick", onDoubleClick, true);
      delete root.dataset.windowMaximized;
    };
  }, []);
}
