import { screen } from "electron";

export interface PanelLayout { x: number; y: number; }

type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

function pin(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * 把窗口位置限制在 workArea 内，至少保留 minVisibleW × minVisibleH 可见。
 * 窗口可以部分越界，但可见部分不会小于该阈值。
 */
export function clampWindowToWorkArea(
  pos: PanelLayout,
  size: Size,
  workArea: Rect,
  minVisibleW = 120,
  minVisibleH = 80,
): PanelLayout {
  const xRange: [number, number] = [
    workArea.x - size.width + minVisibleW,
    workArea.x + workArea.width - minVisibleW,
  ];
  const yRange: [number, number] = [
    workArea.y - size.height + minVisibleH,
    workArea.y + workArea.height - minVisibleH,
  ];
  return { x: pin(pos.x, ...xRange), y: pin(pos.y, ...yRange) };
}

/**
 * 多面板自适应布局：
 * - 总宽不超过 workArea 时三块面板水平居中并排；
 * - 超出时 chat 居中，sidebar 与 tasks 靠右并垂直错开；
 * 每块面板都经过 clampWindowToWorkArea。
 */
export function computePanelLayout(
  workArea: Rect,
  panels: Size[],
  gap = 8,
): PanelLayout[] {
  const totalWidth = panels.reduce((sum, p, i) => sum + p.width + (i > 0 ? gap : 0), 0);
  const tallest = Math.max(...panels.map((p) => p.height));
  const baseY =
    workArea.height >= tallest ? workArea.y + Math.floor((workArea.height - tallest) / 2) : workArea.y;

  if (totalWidth <= workArea.width) {
    let left = workArea.x + Math.floor((workArea.width - totalWidth) / 2);
    return panels.map((panel) => {
      const placed = clampWindowToWorkArea({ x: left, y: baseY }, panel, workArea);
      left += panel.width + gap;
      return placed;
    });
  }

  const [chat, sidebar, tasks] = panels;

  const chatPos = clampWindowToWorkArea(
    { x: workArea.x + Math.floor((workArea.width - chat.width) / 2), y: baseY },
    chat,
    workArea,
  );

  // sidebar 优先紧挨 chat 右侧，放不下就贴 workArea 右边缘
  const rightmostX = workArea.x + workArea.width - sidebar.width;
  const sidebarPos = clampWindowToWorkArea(
    { x: Math.min(chatPos.x + chat.width + gap, rightmostX), y: baseY },
    sidebar,
    workArea,
  );

  // tasks 同样贴右，纵向比 sidebar 低 48px
  const tasksPos = clampWindowToWorkArea(
    { x: Math.min(sidebarPos.x, rightmostX), y: sidebarPos.y + 48 },
    tasks,
    workArea,
  );

  return [chatPos, sidebarPos, tasksPos];
}

// 计算 chat / sidebar / tasks 三个窗口的初始位置：
// 取鼠标所在的显示器，窗口按 workArea 自适应并至少 120×80 可见。
export function computeLayout(): {
  chat: PanelLayout;
  sidebar: PanelLayout;
  tasks: PanelLayout;
} {
  const cursor = screen.getCursorScreenPoint();
  const underCursor = screen.getAllDisplays().find((d) => {
    const { x, y, width, height } = d.workArea;
    return cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height;
  });
  const { workArea } = underCursor ?? screen.getPrimaryDisplay();

  const [chat, sidebar, tasks] = computePanelLayout(
    workArea,
    [
      { width: 1280, height: 760 },
      { width: 320, height: 760 },
      { width: 320, height: 760 },
    ],
    8,
  );
  return { chat, sidebar, tasks };
}
