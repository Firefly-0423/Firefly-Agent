import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installAppShutdownHandlers, attachWindowsSessionEndHandlers } from "./electron-lifecycle";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
function lifecycle() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, { quit: vi.fn(), removeListener: vi.spyOn(emitter, "removeListener") });
}
const coordinator = () => createShutdownCoordinator({ readiness: createStartupReadiness(), timeoutMs: 800 });
describe("Electron exit adapters", () => {
    it("intercepts initial quit until cleanup completes and then permits final quit", async () => {
        const app = lifecycle();
        const shutdown = coordinator();
        const detach = installAppShutdownHandlers({ app, coordinator: shutdown });
        const first = { preventDefault: vi.fn() };
        app.emit("before-quit", first);
        expect(first.preventDefault).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
        expect(shutdown.isFinalizing()).toEqual(true);
        const final = { preventDefault: vi.fn() };
        app.emit("before-quit", final);
        expect(final.preventDefault).not.toHaveBeenCalled();
        detach();
    });
    it("unsubscribes application quit interception", () => {
        const app = lifecycle();
        installAppShutdownHandlers({ app, coordinator: coordinator() })();
        const event = { preventDefault: vi.fn() };
        app.emit("before-quit", event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(app.removeListener).toHaveBeenCalledExactlyOnceWith("before-quit", expect.any(Function));
    });
    it.each([false, true])("unsubscribes session-end flushing when detached=%s", detached => {
        const window = lifecycle();
        const shutdown = coordinator();
        const flush = vi.fn();
        shutdown.registerEmergencyFlush("durable-records", flush);
        const detach = attachWindowsSessionEndHandlers({ window, coordinator: shutdown });
        if (detached)
            detach();
        window.emit("query-session-end", { preventDefault: vi.fn() });
        window.emit("session-end", { preventDefault: vi.fn() });
        expect(flush).toHaveBeenCalledTimes(detached ? 0 : 1);
        expect(shutdown.isStopping()).toEqual(false);
        detach();
    });
});
