import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { createWindowLifecycleTracker } from "./electron-window-lifecycle";
describe("window diagnostics over the close boundary", () => {
    it("reports the attached renderer then clears handles on close", () => {
        let destroyed = false;
        const window = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, webContents: { id: 319, isDestroyed: () => destroyed } });
        const closed = vi.fn();
        const owner = createWindowLifecycleTracker("chat-surface", { onClosed: closed });
        owner.attach(window);
        expect(owner.getDiagnostics()).toEqual({ name: "chat-surface", attached: true, windowDestroyed: false, webContentsId: 319, webContentsDestroyed: false, closedCount: 0 });
        destroyed = true;
        window.emit("closed");
        expect(closed).toHaveBeenCalledExactlyOnceWith(window);
        expect(owner.getWindow()).toBeNull();
        expect(owner.getDiagnostics()).toEqual({ name: "chat-surface", attached: false, windowDestroyed: null, webContentsId: null, webContentsDestroyed: null, closedCount: 1 });
    });
});
