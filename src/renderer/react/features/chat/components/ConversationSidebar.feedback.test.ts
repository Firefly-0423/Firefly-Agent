// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const ports = vi.hoisted(() => ({ confirm: vi.fn(), modalConfirm: vi.fn() }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => ({ confirm: ports.confirm }) }));
vi.mock("@ant-design/x", () => ({
  Conversations: ({ items }: { items: Array<{ key: string; label: React.ReactNode }> }) =>
    React.createElement("ul", null, items.map(item => React.createElement("li", { key: item.key, "data-session-id": item.key }, item.label))),
}));
vi.mock("antd", () => ({
  Menu: ({ items, onClick }: { items: Array<{ key: string; label: React.ReactNode }>; onClick: (event: { key: string }) => void }) =>
    React.createElement("nav", null, items.map(item => React.createElement("button",
      { key: item.key, "data-action": item.key, onClick: () => onClick({ key: item.key }) }, item.label))),
  Modal: Object.assign(() => null, { confirm: ports.modalConfirm }), Input: () => null,
  Dropdown: ({ children }: { children: React.ReactNode }) => children,
  Popover: ({ children }: { children: React.ReactNode }) => children,
}));
import { ConversationSidebar } from "./ConversationSidebar";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test.each([false, true])("waits for dangerous confirmation before deleting; answer=%s", async (accepted) => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const native = vi.spyOn(window, "confirm");
  let decide!: (answer: boolean) => void;
  ports.confirm.mockReset().mockImplementation(() => new Promise<boolean>(resolve => { decide = resolve; }));
  ports.modalConfirm.mockClear();
  const remove = vi.fn(), root = createRoot(document.body.appendChild(document.createElement("main")));
  try {
    await React.act(async () => root.render(React.createElement(ConversationSidebar, {
      mode: "chat", sessions: [{ id: "archived-session", title: "Archive discussion", createdAt: 500, updatedAt: 900 }],
      listStatus: "ready", onSelect: vi.fn(), onOpenProject: vi.fn(), onRename: vi.fn(), onDelete: remove,
      onTogglePin: vi.fn(), onExport: vi.fn(),
    })));
    await React.act(async () => document.querySelector("[data-session-id]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await React.act(async () => (document.querySelector('[data-action="delete"]') as HTMLButtonElement).click());
    expect(remove).not.toHaveBeenCalled();
    expect(ports.confirm).toHaveBeenCalledTimes(1);
    expect(ports.confirm.mock.calls[0][0]).toMatchObject({ dangerous: true });
    await React.act(async () => decide(accepted));
    expect(remove.mock.calls).toStrictEqual(accepted ? [["archived-session"]] : []);
    expect(native).not.toHaveBeenCalled();
    expect(ports.modalConfirm).not.toHaveBeenCalled();
  } finally { await React.act(async () => root.unmount()); native.mockRestore(); }
});
