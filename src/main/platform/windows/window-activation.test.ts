import { describe, expect, it, vi } from "vitest";
import { createWindowActivationBroker } from "./window-activation";
describe("deferred desktop navigation", () => {
    it("coalesces each kind while preserving independent destinations", async () => {
        const broker = createWindowActivationBroker();
        const focusLoading = vi.fn();
        const activate = vi.fn();
        broker.bind({ focusLoading, activate });
        broker.request({ kind: "chat", sessionId: "discarded-session" });
        broker.request({ kind: "chat", sessionId: "selected-session" });
        expect(focusLoading).toHaveBeenCalledTimes(2);
        expect(activate).not.toHaveBeenCalled();
        broker.request({ kind: "settings", section: "appearance" });
        broker.request({ kind: "music" });
        await broker.markReady();
        expect(activate.mock.calls).toEqual([
            [{ kind: "chat", sessionId: "selected-session" }],
            [{ kind: "settings", section: "appearance" }], [{ kind: "music" }],
        ]);
        await broker.markReady();
        expect(activate).toHaveBeenCalledTimes(3);
    });
    it("drains an earlier chat only once then dispatches sidebar directly", async () => {
        const broker = createWindowActivationBroker();
        const activate = vi.fn();
        const focusLoading = vi.fn();
        broker.request({ kind: "chat" });
        broker.bind({ activate, focusLoading });
        broker.request({ kind: "sidebar" });
        expect(focusLoading).toHaveBeenCalledTimes(1);
        await broker.markReady();
        await broker.markReady();
        expect(activate.mock.calls).toEqual([[{ kind: "chat" }], [{ kind: "sidebar" }]]);
        focusLoading.mockClear();
        broker.request({ kind: "sidebar" });
        await Promise.resolve();
        await Promise.resolve();
        expect(focusLoading).not.toHaveBeenCalled();
        expect(activate).toHaveBeenCalledTimes(3);
        expect(activate).toHaveBeenNthCalledWith(3, { kind: "sidebar" });
    });
    it("discards queued and future navigation on shutdown", async () => {
        const broker = createWindowActivationBroker();
        const activate = vi.fn();
        const focusLoading = vi.fn();
        broker.bind({ activate, focusLoading });
        broker.stop();
        broker.request({ kind: "chat" });
        await broker.markReady();
        expect(broker.isReady()).toEqual(false);
        expect(activate).not.toHaveBeenCalled();
        expect(focusLoading).not.toHaveBeenCalled();
    });
    it("drains a single queued request once", async () => {
        const broker = createWindowActivationBroker();
        const activate = vi.fn();
        broker.bind({ activate, focusLoading: vi.fn() });
        broker.request({ kind: "chat" });
        await broker.markReady();
        await broker.markReady();
        expect(activate.mock.calls).toEqual([[{ kind: "chat" }]]);
    });
});
