import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: {} }));
import { createIpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { getOfflineBrowserAvailability, registerBrowserAvailabilityIpc } from "./browser-availability-ipc";

describe("closed browser availability transport", () => {
  it("returns only an immutable unavailable DTO without granting browser authority", () => {
    const value = getOfflineBrowserAvailability();
    expect(value).toEqual({ available: false, reason: "network_unavailable" });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(value).sort()).toEqual(["available", "reason"]);
  });
  it("uses the actual shared scope, ignores forged open inputs, and unregisters on disposal", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const scope = createIpcScope({ handle: (channel, listener) => handlers.set(channel, listener), on: () => {}, removeHandler: (channel) => handlers.delete(channel), removeListener: () => {} });
    registerBrowserAvailabilityIpc(scope);
    expect(handlers.size).toBe(1);
    const query = handlers.get(IPC.BROWSER_AVAILABILITY);
    expect(query).toBeTypeOf("function");
    expect(query?.({}, { gateOpen: true, url: "https://example.com", owner: {} })).toEqual({ available: false, reason: "network_unavailable" });
    scope.dispose(); expect(handlers.size).toBe(0);
  });
});
