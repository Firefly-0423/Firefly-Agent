// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../../components/ui/SidebarToggle", () => ({ SidebarToggle: () => null }));
vi.mock("../../../components/ui/ModeMenu", () => ({
  ModeMenu: ({ variant = "sidebar" }: { variant?: string }) => createElement("output", { "data-mode-location": variant }),
}));
vi.mock("../../../components/ui/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../../components/ui/NewTaskButton", () => ({ NewTaskButton: () => createElement("b", null, "Start conversation") }));
vi.mock("./AppUpdateEntry", () => ({ AppUpdateEntry: () => null }));
vi.mock("./ConversationSidebar", () => ({
  ConversationSidebar: ({ listStatus }: { listStatus: string }) => createElement("output", { "data-session-status": listStatus }),
}));
import { ChatPageNavigation } from "./ChatPageNavigation";

const props = (patch: Partial<ComponentProps<typeof ChatPageNavigation>> = {}): ComponentProps<typeof ChatPageNavigation> => ({
  collapsed: false, activePanel: null, mode: "chat", sessions: [], sessionListStatus: "ready",
  onToggleCollapsed: vi.fn(), onModeChange: vi.fn(), onNewTask: vi.fn(), onTogglePanel: vi.fn(),
  onSelectSession: vi.fn(), onOpenProject: vi.fn(), onRenameSession: vi.fn(), onDeleteSession: vi.fn(),
  onTogglePinSession: vi.fn(), onExportSession: vi.fn(), onMinimize: vi.fn(), onMaximize: vi.fn(),
  onCloseWindow: vi.fn(), onOpenSettings: vi.fn(), ...patch,
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test.each([
  { activePanel: "tool" as const, sessionListStatus: "loading" as const },
  { activePanel: "plugin" as const, sessionListStatus: "error" as const },
])("retains sidebar modes and session $sessionListStatus with the $activePanel panel open", (patch) => {
  document.body.innerHTML = renderToStaticMarkup(createElement(ChatPageNavigation, props(patch)));
  expect(document.querySelector('[data-mode-location="sidebar"]')).not.toBeNull();
  expect(document.querySelector('[data-mode-location="compact"]')).toBeNull();
  expect(document.querySelector('[data-rail-item="' + patch.activePanel + '"]')).not.toBeNull();
  expect(document.querySelector("[data-session-status]")?.getAttribute("data-session-status")).toBe(patch.sessionListStatus);
  if (patch.activePanel === "plugin") {
    expect(document.querySelector('[data-rail-item="plugin"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector(".ff-page-titlebar")).not.toBeNull();
  }
});

test("places mode selection beside the avatar when the sidebar is folded", () => {
  const html = renderToStaticMarkup(createElement(ChatPageNavigation, props({ collapsed: true, mode: "work" })));
  expect(html).toContain('data-mode-location="compact"');
  expect(html).not.toContain('data-mode-location="sidebar"');
});

test.each([
  { mode: "chat" as const, handler: true, visible: true },
  { mode: "work" as const, handler: true, visible: false },
  { mode: "chat" as const, handler: false, visible: false },
])("gates temporary conversation entry: %j", async ({ mode, handler, visible }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const start = vi.fn();
  try {
    await act(async () => root.render(createElement(ChatPageNavigation, props({ mode, onNewTemporaryChat: handler ? start : undefined }))));
    const entry = host.querySelector<HTMLButtonElement>("button.ff-page-newtask__temporary");
    if (!visible) expect(entry).toBeNull();
    else {
      expect(entry?.getAttribute("aria-label")).toBe("临时聊天");
      expect(entry?.parentElement?.classList.contains("ff-page-newtask")).toBe(true);
      expect(entry?.previousElementSibling?.textContent).toBe("Start conversation");
      await act(async () => entry!.click());
      expect(start).toHaveBeenCalledTimes(1);
    }
  } finally { await act(async () => root.unmount()); }
});
