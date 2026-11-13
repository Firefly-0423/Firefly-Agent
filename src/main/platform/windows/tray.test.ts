import { beforeEach, expect, it, vi } from "vitest";
import { buildTrayMenuTemplate, createTray } from "./tray";

vi.mock("electron", () => ({
  app: { getAppPath: () => "E:/garden-app", quit: vi.fn() },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  Menu: { buildFromTemplate: vi.fn(template => template) },
  Tray: class { setToolTip = vi.fn(); setContextMenu = vi.fn(); },
}));
beforeEach(() => vi.clearAllMocks());
const callbacks = () => ({ quit: vi.fn(), togglePetWindow: vi.fn(), requestActivation: vi.fn() });
it("exposes only the supported menu and routes window actions in order", () => {
  const actions = callbacks();
  const menu = buildTrayMenuTemplate(actions);
  const labels = menu.map(entry => entry.label);
  expect(labels).not.toContain("打开状态面板");
  expect(labels).not.toContain("QQ Music 状态");
  expect(labels).toEqual(["打开聊天窗口", "设置", "显示/隐藏桌宠", undefined, "退出"]);
  for (const label of ["打开聊天窗口", "设置"]) {
    (menu.find(entry => entry.label === label)!.click as () => void)();
  }
  expect(actions.requestActivation.mock.calls).toEqual([[{ kind: "chat" }], [{ kind: "settings" }]]);
});
it("executes pet visibility and exit callbacks without requesting a window", () => {
  const actions = callbacks();
  const menu = buildTrayMenuTemplate(actions);
  for (const label of ["显示/隐藏桌宠", "退出"]) (menu.find(entry => entry.label === label)!.click as () => void)();
  expect(actions.quit).toHaveBeenCalledTimes(1);
  expect(actions.togglePetWindow).toHaveBeenCalledTimes(1);
  expect(actions.requestActivation.mock.calls).toEqual([]);
});
it("installs the generated context menu on a tray labelled Firefly", async () => {
  const { Menu } = await import("electron");
  const tray = createTray(callbacks());
  expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
  expect(tray.setContextMenu).toHaveBeenCalledExactlyOnceWith(vi.mocked(Menu.buildFromTemplate).mock.results[0].value);
  expect(tray.setToolTip).toHaveBeenCalledWith("Firefly");
});
