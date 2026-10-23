import { Menu, Tray, type MenuItemConstructorOptions } from "electron";
import { type WindowActivationRequest } from "../application/window-activation";
import { loadTrayIcon } from "./tray-icon";

export type CreateTrayDependencies = {
  /** 窗口类菜单统一发激活请求，是否立刻打开由 activation broker 决定 */
  requestActivation(request: WindowActivationRequest): void;
  /** 桌宠开关直接执行，桌宠不处理通用的主窗口激活请求 */
  togglePetWindow(): void;
  quit(): void;
  /** 仅原生侧使用的诊断入口，渲染层与工具接口中不存在 */
  memoryOnlineOnce?: { run(): void; cancel(): void };
};

const item = (label: string, click: () => void): MenuItemConstructorOptions => ({ label, click });

export function buildTrayMenuTemplate(deps: CreateTrayDependencies): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    item("打开聊天窗口", () => { deps.requestActivation({ kind: "chat" }); }),
    item("设置", () => { deps.requestActivation({ kind: "settings" }); }),
    item("显示/隐藏桌宠", () => { deps.togglePetWindow(); }),
  ];

  if (deps.memoryOnlineOnce) {
    template.push(
      item("记忆 H：一次性在线测试（≤¥5）", () => { deps.memoryOnlineOnce!.run(); }),
      item("取消记忆 H 在线测试", () => { deps.memoryOnlineOnce!.cancel(); }),
    );
  }

  template.push({ type: "separator" }, item("退出", () => { deps.quit(); }));
  return template;
}

export function createTray(deps: CreateTrayDependencies): Tray {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip("Firefly");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(deps)));
  return tray;
}
