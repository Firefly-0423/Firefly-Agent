import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ app: new (class { listeners = new Map<string, Function>(); on(name: string, callback: Function) { this.listeners.set(name, callback); } })(), open: vi.fn() }));
vi.mock("electron", () => ({ app: mocks.app, shell: { openExternal: mocks.open } }));
vi.mock("../env", () => ({ isDev: false }));
import { installGlobalNavigationGuard } from "./external-link";
import { registerBrowserGuestRouting } from "../browser/browser-guest-routing";
describe("global navigation with exact native browser guest", () => {
  it("keeps allowed guest navigation in place, denies retired guests, and never opens them externally", () => {
    installGlobalNavigationGuard();
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    mocks.app.listeners.get("web-contents-created")!({}, contents);
    const off = registerBrowserGuestRouting(contents, url => url === "https://example.com/allowed");
    const event = { preventDefault: vi.fn(), url: "https://example.com/allowed" };
    contents.emit("will-navigate", event, event.url);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
    off(); contents.emit("will-navigate", event, event.url);
    expect(event.preventDefault).toHaveBeenCalledTimes(1); expect(mocks.open).not.toHaveBeenCalled();
    contents.setWindowOpenHandler.mock.calls[0][0]({ url: event.url });
    expect(mocks.open).not.toHaveBeenCalled();
    const other = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    mocks.app.listeners.get("web-contents-created")!({}, other);
    other.emit("will-navigate", { preventDefault: vi.fn() }, "https://example.com/external");
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/external");
  });
});
