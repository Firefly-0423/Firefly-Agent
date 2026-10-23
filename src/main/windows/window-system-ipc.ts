import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { clearUsage, getSessionStats, getUsageHistory, getUsageReport } from "../token-usage-store";
import { listSessions } from "../chats/chats-store";
import { sidebarWindow, settingsWindow } from "./window-state";
import type { WindowManager } from "./window-manager";

export interface WindowSystemIpcDependencies {
  get windowManager(): WindowManager | null;
  /** 共享的 IPC scope，便于退出时统一注销；未提供则自建一个。 */
  ipc?: IpcScope;
  /**
   * 退出应用的入口，由组合根注入，避免本模块直接依赖 electron 的 app。
   */
  quit(): void;
}

/** 用量天数：非法或零值回落到 7，并限制在 1..90 之间 */
function clampUsageDays(raw: number): number {
  const parsed = Number(raw) || 7;
  return Math.min(90, Math.max(1, parsed));
}

/** 会话 id → 标题；读取失败时返回空表，调用方会按"已删除"处理 */
function buildSessionTitleIndex(): Map<string, string> {
  try {
    return new Map(listSessions().map((session) => [session.id, session.title]));
  } catch {
    return new Map<string, string>();
  }
}

/**
 * 注册窗口控制与系统入口的 IPC。
 * 其中的用量查询只是暂时挂在这里，之后应迁往统计模块。
 */
export function registerWindowSystemIpc(deps: WindowSystemIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  const manager = (): WindowManager | null => deps.windowManager;

  // ── 桌宠窗口 ──
  ipc.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
    manager()?.setPetWindowInteractive(interactive);
  });
  ipc.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
    manager()?.movePetWindowTo(x, y);
  });
  ipc.on(IPC.WINDOW_SET_DRAGGING, (_event, isDragging: boolean) => {
    manager()?.setPetWindowDragging(isDragging);
  });
  // 最小化与隐藏入口：preload 的 minimize()/hide() 依赖它们，缺失会导致按钮失效。
  ipc.on(IPC.WINDOW_MINIMIZE, () => {
    manager()?.minimizePetWindow();
  });
  ipc.handle(IPC.WINDOW_GET_CURSOR_POSITION, () => manager()?.getCursorScreenPosition() ?? { x: 0, y: 0 });

  // ── 侧边栏（已退役的独立状态窗口，保留消息入口以兼容旧页面） ──
  ipc.on(IPC.SIDEBAR_MINIMIZE, () => sidebarWindow?.minimize());
  ipc.on(IPC.SIDEBAR_CLOSE, () => sidebarWindow?.close());
  // 切换置顶，返回切换之后的状态（true 表示已置顶）
  ipc.handle(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP, () => {
    if (!sidebarWindow) return false;
    const target = !sidebarWindow.isAlwaysOnTop();
    sidebarWindow.setAlwaysOnTop(target, target ? "screen-saver" : "normal");
    return target;
  });
  ipc.on(IPC.SIDEBAR_OPEN_SETTINGS, (_event, section?: string) => {
    manager()?.createSettingsWindow(section);
  });

  // ── 设置与音乐入口 ──
  ipc.on(IPC.SETTINGS_MINIMIZE, () => settingsWindow?.minimize());
  ipc.on(IPC.SETTINGS_CLOSE, () => settingsWindow?.close());
  ipc.handle(IPC.MUSIC_OPEN_PLAYER, () => {
    manager()?.createSettingsWindow("music");
    return true;
  });
  ipc.handle(IPC.MUSIC_OPEN_SETTINGS, (_event, section?: string) => {
    manager()?.createSettingsWindow(section);
    return true;
  });

  // ── Token 用量（暂挂于此） ──
  ipc.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => getUsageReport(clampUsageDays(days)));
  ipc.handle(IPC.TOKEN_USAGE_CLEAR, () => {
    clearUsage();
  });
  // 用量排行里的会话 id 在此替换为标题；找不到标题的会话返回 null，由界面显示为"已删除"。
  ipc.handle(IPC.TOKEN_USAGE_HISTORY, (_event, days: number) => {
    const history = getUsageHistory(clampUsageDays(days));
    const titles = buildSessionTitleIndex();
    const sessions = history.sessions.map((session) => ({
      ...session,
      title: titles.get(session.id) ?? null,
    }));
    return { ...history, sessions };
  });
  // 会话级统计：无记录或 id 类型不对时返回 null
  ipc.handle(IPC.TOKEN_USAGE_SESSION_STATS, (_event, sessionId: unknown) =>
    typeof sessionId === "string" ? getSessionStats(sessionId) : null,
  );
}
