// 聊天窗口是 frame:false + transparent:true，Windows 不会像普通窗口那样在“最大化后拖标题栏”时自动还原。
// 渲染端在最大化状态下检测到拖动手势后通知主进程，由这里还原窗口并让它跟随光标。
import type { Rectangle } from "electron";

export interface DragPoint {
  x: number;
  y: number;
}

export interface RestoreBoundsInput {
  cursor: DragPoint;
  maximized: Rectangle;
  normal: Rectangle;
  workArea: Rectangle;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** 还原后的窗口：保持光标在窗口内的横向比例与纵向抓取位置，并保证窗口留在工作区内。 */
export function computeRestoredBounds({ cursor, maximized, normal, workArea }: RestoreBoundsInput): Rectangle {
  const width = Math.min(normal.width, workArea.width);
  const height = Math.min(normal.height, workArea.height);
  const ratioX = maximized.width > 0 ? clamp((cursor.x - maximized.x) / maximized.width, 0, 1) : 0.5;
  const grabY = clamp(cursor.y - maximized.y, 0, height - 1);
  return {
    x: Math.round(clamp(cursor.x - ratioX * width, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(cursor.y - grabY, workArea.y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}

export interface DraggableWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  getBounds(): Rectangle;
  getNormalBounds(): Rectangle;
  unmaximize(): void;
  setBounds(bounds: Rectangle): void;
}

export interface WindowDragDependencies {
  getCursor(): DragPoint;
  getWorkArea(point: DragPoint): Rectangle;
  /** 跟随光标的采样间隔（毫秒）。 */
  intervalMs?: number;
}

export interface WindowDragController {
  start(window: DraggableWindow): void;
  stop(): void;
  readonly active: boolean;
}

export function createWindowDragController(deps: WindowDragDependencies): WindowDragController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let follow: (() => void) | null = null;

  const stop = () => {
    // 松手前最后一次光标位置可能还没被采样到，结束时补一次。
    follow?.();
    if (timer) clearInterval(timer);
    timer = null;
    follow = null;
  };

  return {
    get active() {
      return timer !== null;
    },
    stop,
    start(window) {
      stop();
      if (window.isDestroyed()) return;
      const cursor = deps.getCursor();
      let bounds = window.getBounds();
      if (window.isMaximized()) {
        const restored = computeRestoredBounds({
          cursor,
          maximized: bounds,
          normal: window.getNormalBounds(),
          workArea: deps.getWorkArea(cursor),
        });
        window.unmaximize();
        window.setBounds(restored);
        bounds = restored;
      }
      const grab = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
      let last = { x: bounds.x, y: bounds.y };
      follow = () => {
        if (window.isDestroyed()) return;
        const point = deps.getCursor();
        const next = { x: point.x - grab.x, y: point.y - grab.y };
        if (next.x === last.x && next.y === last.y) return;
        last = next;
        // 同时给出宽高：只传位置时 Windows 的 DPI 缩放会让窗口尺寸逐步漂移。
        window.setBounds({ ...next, width: bounds.width, height: bounds.height });
      };
      timer = setInterval(() => {
        if (window.isDestroyed()) {
          stop();
          return;
        }
        follow?.();
      }, deps.intervalMs ?? 8);
    },
  };
}
