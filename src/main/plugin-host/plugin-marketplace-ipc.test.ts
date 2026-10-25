import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { registerPluginMarketplaceIpc } from "./plugin-marketplace-ipc";
vi.mock("../startup/env", () => ({ isDev: true }));
vi.mock("electron", () => ({ app: { getAppPath: () => process.cwd() } }));

function fixture() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const mainFrame = { url: "http://localhost:5173/react/" };
  const owner = { isDestroyed: () => false, mainFrame } as unknown as WebContents;
  let current: WebContents | null = owner;
  const market = {
    listMarket: vi.fn(async () => ({ ok: true, plugins: [], mode: "bundled" as const })),
    installFromMarket: vi.fn(async () => ({ ok: true as const, plugin: { id: "text-stats", name: "文本统计", version: "1.0.0" } })),
  };
  registerPluginMarketplaceIpc({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    getHostWebContents: () => current, market });
  const event = { sender: owner, senderFrame: mainFrame } as IpcMainInvokeEvent;
  return { handlers, market, owner, event, setOwner: (value: WebContents | null) => { current = value; } };
}
describe("marketplace IPC ownership", () => {
  it("refuses a host navigated away from the chat document", async () => {
    const f = fixture();
    Object.assign(f.owner.mainFrame, { url: "https://example.com/" });
    expect(await f.handlers.get(IPC.PLUGINS_MARKET_INSTALL)!(f.event, "text-stats")).toMatchObject({ ok: false });
    expect(f.market.installFromMarket).not.toHaveBeenCalled();
  });
  it("allows the live chat-window main frame and passes only validated selector values", async () => {
    const f = fixture();
    expect(await f.handlers.get(IPC.PLUGINS_MARKET_LIST)!(f.event, "bundled:registry")).toMatchObject({ ok: true });
    expect(f.market.listMarket).toHaveBeenCalledWith("bundled:registry");
    expect(await f.handlers.get(IPC.PLUGINS_MARKET_INSTALL)!(f.event, "text-stats")).toMatchObject({ ok: true });
    expect(f.market.installFromMarket).toHaveBeenCalledWith("text-stats");
  });
  it.each(["foreign", "subframe", "missing-frame", "missing-owner", "destroyed-owner", "replaced-owner"])("fails closed for %s without reaching catalog or installer", async (kind) => {
    const f = fixture();
    if (kind === "foreign") f.event.sender = {} as WebContents;
    if (kind === "subframe") f.event.senderFrame = {} as IpcMainInvokeEvent["senderFrame"];
    if (kind === "missing-frame") f.event.senderFrame = null;
    if (kind === "missing-owner") f.setOwner(null);
    if (kind === "destroyed-owner") f.owner.isDestroyed = () => true;
    if (kind === "replaced-owner") f.setOwner({ isDestroyed: () => false, mainFrame: {} } as WebContents);
    expect(await f.handlers.get(IPC.PLUGINS_MARKET_LIST)!(f.event)).toMatchObject({ ok: false, plugins: [] });
    expect(await f.handlers.get(IPC.PLUGINS_MARKET_INSTALL)!(f.event, "text-stats")).toMatchObject({ ok: false });
    expect(f.market.listMarket).not.toHaveBeenCalled();
    expect(f.market.installFromMarket).not.toHaveBeenCalled();
  });
  it.each([null, "", {}, 42])("rejects an invalid install id %j", async (id) => {
    const f = fixture();
    expect(await f.handlers.get(IPC.PLUGINS_MARKET_INSTALL)!(f.event, id)).toMatchObject({ ok: false });
    expect(f.market.installFromMarket).not.toHaveBeenCalled();
  });
});
