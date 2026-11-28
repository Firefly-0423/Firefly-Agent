// 聊天窗口的初始大小/位置：首次居中，之后恢复上次的大小、位置与最大化状态。
// 纯函数部分不依赖 electron，便于单测；落盘用 AtomicJsonStore。

export interface Rect { x: number; y: number; width: number; height: number }

export interface ChatWindowState extends Rect {
  maximized: boolean;
}

export const CHAT_MIN_WIDTH = 960;
export const CHAT_MIN_HEIGHT = 540;
/** 首次打开：占工作区的比例，并限制上限，大屏上也不会铺满。 */
const FIRST_RUN_WIDTH_RATIO = 0.82;
const FIRST_RUN_HEIGHT_RATIO = 0.86;
const FIRST_RUN_MAX_WIDTH = 1440;
const FIRST_RUN_MAX_HEIGHT = 920;
/** 恢复位置时，窗口至少要有这么大一块落在某个显示器内，否则视为拔掉了显示器。 */
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 80;

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** 首次打开的大小：不超过工作区，也不小于窗口最小值（工作区更小时让位给工作区）。 */
export function defaultChatBounds(workArea: Rect): Rect {
  const width = clamp(Math.round(workArea.width * FIRST_RUN_WIDTH_RATIO), Math.min(CHAT_MIN_WIDTH, workArea.width), Math.min(FIRST_RUN_MAX_WIDTH, workArea.width));
  const height = clamp(Math.round(workArea.height * FIRST_RUN_HEIGHT_RATIO), Math.min(CHAT_MIN_HEIGHT, workArea.height), Math.min(FIRST_RUN_MAX_HEIGHT, workArea.height));
  return {
    width,
    height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** 读到的内容是否像一份窗口状态；损坏或被手改坏的文件一律当作没有。 */
export function isChatWindowState(value: unknown): value is ChatWindowState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const integer = (field: unknown): field is number => typeof field === "number" && Number.isSafeInteger(field);
  return integer(state.x) && integer(state.y) && integer(state.width) && integer(state.height)
    && (state.width as number) > 0 && (state.height as number) > 0 && typeof state.maximized === "boolean";
}

export interface ResolvedChatWindow {
  bounds: Rect;
  maximized: boolean;
}

/**
 * 决定窗口这次开在哪：
 * - 没有记录：在鼠标所在屏幕居中，用首次大小；
 * - 有记录且仍落在某个显示器内：原样恢复（大小限制在该显示器工作区和最小值之内）；
 * - 有记录但显示器已拔掉/分辨率变了导致看不见：回到主屏居中，保留记录里的大小。
 */
export function resolveChatWindow(
  saved: ChatWindowState | undefined,
  workAreas: readonly Rect[],
  cursorWorkArea: Rect,
  primaryWorkArea: Rect,
): ResolvedChatWindow {
  if (!saved) return { bounds: defaultChatBounds(cursorWorkArea), maximized: false };

  const visibleOn = workAreas.find(area => {
    const shared = overlap(saved, area);
    return shared.width >= Math.min(MIN_VISIBLE_WIDTH, saved.width) && shared.height >= Math.min(MIN_VISIBLE_HEIGHT, saved.height);
  });
  const area = visibleOn ?? primaryWorkArea;
  const width = clamp(saved.width, Math.min(CHAT_MIN_WIDTH, area.width), area.width);
  const height = clamp(saved.height, Math.min(CHAT_MIN_HEIGHT, area.height), area.height);
  if (!visibleOn) {
    return {
      bounds: { width, height, x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2) },
      maximized: saved.maximized,
    };
  }
  return {
    bounds: {
      width,
      height,
      x: clamp(saved.x, area.x, area.x + area.width - width),
      y: clamp(saved.y, area.y, area.y + area.height - height),
    },
    maximized: saved.maximized,
  };
}
