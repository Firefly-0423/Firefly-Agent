import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: {} }));
import { createIpcScope } from "./ipc-scope";
function transport() {
    return { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() };
}
describe("owned IPC registrations", () => {
    it("forwards listeners by identity and disposes each registration once", () => {
        const main = transport();
        const owned = createIpcScope(main);
        const invoke = vi.fn();
        const receive = vi.fn();
        owned.handle("test:invoke", invoke);
        owned.on("test:receive", receive);
        expect(main.handle.mock.calls).toEqual([["test:invoke", invoke]]);
        expect(main.on.mock.calls).toEqual([["test:receive", receive]]);
        owned.dispose();
        owned.dispose();
        expect(main.removeHandler.mock.calls).toEqual([["test:invoke"]]);
        expect(main.removeListener.mock.calls).toEqual([["test:receive", receive]]);
    });
    it("rejects an already owned invoke channel", () => {
        const owned = createIpcScope(transport());
        owned.handle("test:unique", vi.fn());
        expect(() => owned.handle("test:unique", vi.fn())).toThrow("IPC channel already registered: test:unique");
    });
    it("does not unregister a dynamically removed handler during disposal", () => {
        const main = transport();
        const owned = createIpcScope(main);
        owned.handle("plugin:fixture:request", vi.fn());
        owned.removeHandler("plugin:fixture:request");
        owned.dispose();
        expect(main.removeHandler.mock.calls).toEqual([["plugin:fixture:request"]]);
        expect(() => owned.handle("test:late", vi.fn())).toThrow("IPC scope already disposed");
    });
});
