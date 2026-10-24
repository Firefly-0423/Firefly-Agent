import type { BrowserWindow } from "electron";
import { TOAST_MAX_WORKAREA_RATIO, TOAST_WINDOW_WIDTH } from "./types";

/** 显示器可用区域：仅保留 toast 定位用到的四个数值，方便测试替换 */
export interface ToastDisplayWorkArea {
  height: number;
  width: number;
  y: number;
  x: number;
}

/** 矩形区域，与 electron 的 Rectangle 结构一致，供注入使用 */
export interface ToastBounds {
  height: number;
  y: number;
  x: number;
  width: number;
}

export interface ToastWindowDeps {
  /** 由 windows/create-toast-window 提供窗口实例；本模块不直接构造 BrowserWindow */
  createWindow(): BrowserWindow;
  /** 返回聊天窗口，不存在时为 null */
  getChatWindow(): BrowserWindow | null;
  /** 找出与给定区域相交的显示器；无交集时由实现回退到主屏 */
  getDisplayMatching(bounds: ToastBounds): { workArea: ToastDisplayWorkArea };
  /** 当前鼠标坐标 */
  getCursorScreenPoint(): { x: number; y: number };
}

/**
 * toast 窗口控制器：负责窗口实例的生命周期、选屏、高度与显隐。
 * 窗口创建后常驻，队列清空时仅隐藏；有内容时贴右下角以 showInactive 方式展示。
 */
export function createToastWindowController(deps: ToastWindowDeps) {
  let handle: BrowserWindow | null = null;
  let lastKnownChatArea: ToastBounds | null = null;
  let reportedHeight = 0;

  function obtainWindow(): BrowserWindow {
    if (!handle || handle.isDestroyed()) {
      handle = deps.createWindow();
    }
    return handle;
  }

  /**
   * 选屏顺序：当前聊天窗口所在屏 → 上一次记录到的聊天窗口区域所在屏 → 鼠标所在屏。
   * 最后一层由 getDisplayMatching 自身回退到主屏。
   */
  function chooseDisplay(): { workArea: ToastDisplayWorkArea } {
    const chat = deps.getChatWindow();
    if (chat && !chat.isDestroyed()) {
      try {
        const area = chat.getBounds();
        if (area.width > 0 && area.height > 0) {
          lastKnownChatArea = area;
          return deps.getDisplayMatching(area);
        }
      } catch {
        // 读取 bounds 时窗口正被销毁：继续尝试后续来源
      }
    }
    if (lastKnownChatArea !== null) {
      return deps.getDisplayMatching(lastKnownChatArea);
    }
    const pointer = deps.getCursorScreenPoint();
    return deps.getDisplayMatching({ x: pointer.x, y: pointer.y, width: 1, height: 1 });
  }

  /** 按内容高度计算窗口矩形：高度不超过工作区的指定比例，锚定右下角 */
  function refreshBounds(): void {
    const win = handle;
    if (!win || win.isDestroyed()) return;
    const { workArea: area } = chooseDisplay();
    const cap = Math.floor(area.height * TOAST_MAX_WORKAREA_RATIO);
    const h = Math.max(1, Math.min(reportedHeight, cap));
    const rect = {
      x: area.x + area.width - TOAST_WINDOW_WIDTH,
      y: area.y + area.height - h,
      width: TOAST_WINDOW_WIDTH,
      height: h,
    };
    try {
      win.setBounds(rect);
    } catch {
      // 窗口在设置时被销毁：忽略，下次展示前会重新计算
    }
  }

  return {
    /**
     * 接收渲染页上报的内容高度。变化后立即刷新 bounds，避免首帧在窗口很小时
     * 测得错误高度并一直沿用。隐藏期间同样记录，下次显示无需再算。
     */
    updateHeight(height: number): void {
      if (!Number.isFinite(height) || height <= 0) return;
      const next = Math.round(height);
      if (next === reportedHeight) return;
      reportedHeight = next;
      refreshBounds();
    },

    /** 依据是否仍有 toast 决定整窗显示或隐藏；展示前重新定位，屏幕或高度可能已变 */
    syncVisibility(hasToasts: boolean): void {
      if (hasToasts) {
        const win = obtainWindow();
        refreshBounds();
        if (!win.isVisible()) {
          win.showInactive();
        }
        return;
      }
      if (handle && !handle.isDestroyed() && handle.isVisible()) {
        handle.hide();
      }
    },

    /** 向渲染页投递消息；页面尚未就绪或正在销毁时丢弃，主进程状态仍为准 */
    send(channel: string, payload: unknown): void {
      const win = handle;
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // 投递失败（页面未加载或即将销毁）：放弃本次
      }
    },

    /** 启动期提前创建隐藏窗口，首次弹出时无需等待 */
    preload(): void {
      obtainWindow();
    },

    isVisible(): boolean {
      return !!handle && !handle.isDestroyed() && handle.isVisible();
    },

    /** 判断某个 webContents 是否为 toast 窗口自身，用于拦截伪造的 IPC 上报 */
    owns(webContents: { id: number }): boolean {
      const win = handle;
      if (!win || win.isDestroyed()) return false;
      return win.webContents.id === webContents.id;
    },

    dispose(): void {
      if (handle && !handle.isDestroyed()) {
        handle.destroy();
      }
      handle = null;
    },
  };
}

export type ToastWindowController = ReturnType<typeof createToastWindowController>;
