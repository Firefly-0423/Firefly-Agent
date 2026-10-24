import { afterEach, describe, it, expect, vi } from "vitest";
import { createStartupReadiness } from "./readiness";
import { createShutdownCoordinator, type ShutdownPhase } from "./shutdown";
afterEach(() => vi.useRealTimers());
describe("controlled application shutdown", () => {
    it("honors fixed phase order, shares the signal and finalizes once", async () => {
        const readiness = createStartupReadiness();
        const stop = createShutdownCoordinator({ readiness, timeoutMs: 900 });
        const observed: string[] = [];
        const signals: AbortSignal[] = [];
        const phases: ShutdownPhase[] = ["quiesce", "stopProducers", "stopActiveWork", "stopExternalConsumers", "stopExternalProviders", "stopLocalResources", "flushPersistence"];
        for (const phase of [...phases].reverse())
            stop.register({ id: phase, phase, dispose: signal => { signals.push(signal); observed.push(phase); } });
        const finalAction = vi.fn(() => { observed.push("exit"); });
        expect([stop.isStopping(), stop.isFinalizing()]).toEqual([false, false]);
        const pending = stop.requestControlledShutdown({ reason: "menu-close", finalAction });
        expect(stop.isStopping()).toEqual(true);
        expect(readiness.getPhase()).toEqual("stopping");
        await Promise.all([pending, stop.requestControlledShutdown({ reason: "duplicate", finalAction })]);
        expect(observed).toEqual([...phases, "exit"]);
        expect(signals).toHaveLength(7);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        for (const signal of signals) {
            expect(signal).toBe(signals[0]);
            expect(signal.aborted).toEqual(false);
        }
        expect(finalAction).toHaveBeenCalledTimes(1);
        expect(stop.isFinalizing()).toEqual(true);
        expect(readiness.getPhase()).toEqual("stopped");
    });
    it("starts same-phase entries concurrently and continues after a rejection", async () => {
        const events: string[] = [];
        let unblock!: () => void;
        const wait = new Promise<void>(resolve => { unblock = resolve; });
        const log = vi.fn();
        const stop = createShutdownCoordinator({ readiness: createStartupReadiness(), log });
        stop.register({ id: "rejected-producer", phase: "stopProducers", dispose: async () => { events.push("failure"); throw new Error("producer failed"); } });
        stop.register({ id: "following-consumer", phase: "stopExternalConsumers", dispose: () => { events.push("consumer"); } });
        stop.register({ id: "waiting-resource", phase: "stopLocalResources", dispose: async () => { await wait; events.push("waiting"); } });
        stop.register({ id: "releasing-resource", phase: "stopLocalResources", dispose: () => { events.push("releasing"); unblock(); } });
        await stop.requestControlledShutdown({ reason: "close", finalAction: () => { events.push("exit"); } });
        expect(events).toEqual(["failure", "consumer", "releasing", "waiting", "exit"]);
        expect(log).toHaveBeenCalled();
    });
    it("aborts at the total deadline without waiting for a stuck resource", async () => {
        vi.useFakeTimers();
        const log = vi.fn();
        const readiness = createStartupReadiness();
        const stop = createShutdownCoordinator({ readiness, timeoutMs: 50, log });
        const interrupted = vi.fn();
        stop.register({ id: "blocked-resource", phase: "stopProducers", dispose: signal => {
                signal.addEventListener("abort", interrupted, { once: true });
                return new Promise<void>(() => undefined);
            } });
        const pending = stop.requestControlledShutdown({ reason: "deadline", finalAction: vi.fn() });
        await vi.advanceTimersByTimeAsync(50);
        await pending;
        expect(interrupted).toHaveBeenCalledTimes(1);
        expect(readiness.getPhase()).toEqual("stopped");
        expect(stop.isFinalizing()).toEqual(true);
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0][0])).toContain("blocked-resource");
    });
    it("omits unregistered resources and isolates synchronous emergency failures", async () => {
        const log = vi.fn();
        const stop = createShutdownCoordinator({ readiness: createStartupReadiness(), log });
        const removed = vi.fn();
        stop.register({ id: "unregistered", phase: "quiesce", dispose: removed })();
        const durable = vi.fn();
        stop.registerEmergencyFlush("broken-store", () => { throw new Error("disk failure"); });
        stop.registerEmergencyFlush("healthy-store", durable);
        expect(() => stop.emergencyFlush()).not.toThrow();
        expect(durable).toHaveBeenCalledTimes(1);
        stop.emergencyFlush();
        expect(durable).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalled();
        await stop.requestControlledShutdown({ reason: "done", finalAction: vi.fn() });
        expect(removed).not.toHaveBeenCalled();
    });
});
describe("draft shutdown preflight", () => {
    it("shares a pending decision, leaves services live on veto, and allows retry", async () => {
        let choose!: (answer: boolean) => void;
        const beforeShutdown = vi.fn(() => new Promise<boolean>(resolve => { choose = resolve; }));
        const readiness = createStartupReadiness();
        const stop = createShutdownCoordinator({ readiness, beforeShutdown });
        const dispose = vi.fn();
        const finalAction = vi.fn();
        stop.register({ id: "runtime", phase: "quiesce", dispose });
        const first = stop.requestControlledShutdown({ reason: "menu", finalAction });
        const repeated = stop.requestControlledShutdown({ reason: "window", finalAction });
        await Promise.resolve();
        expect(beforeShutdown).toHaveBeenCalledTimes(1);
        expect(stop.isStopping()).toEqual(false);
        expect(readiness.getPhase()).toEqual("preparing");
        expect(dispose).not.toHaveBeenCalled();
        choose(false);
        expect(await first).toEqual(false);
        expect(await repeated).toEqual(false);
        expect(stop.isStopping()).toEqual(false);
        expect(readiness.getPhase()).toEqual("preparing");
        expect(dispose).not.toHaveBeenCalled();
        expect(finalAction).not.toHaveBeenCalled();
        const retry = stop.requestControlledShutdown({ reason: "retry", finalAction });
        await Promise.resolve();
        choose(true);
        expect(await retry).toEqual(true);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(finalAction).toHaveBeenCalledTimes(1);
    });
    it("fails closed on a rejected preflight and recovers on a later approval", async () => {
        const beforeShutdown = vi.fn().mockRejectedValueOnce(new Error("dialog unavailable")).mockResolvedValueOnce(true);
        const readiness = createStartupReadiness();
        const stop = createShutdownCoordinator({ readiness, beforeShutdown, log: vi.fn() });
        const finalAction = vi.fn();
        expect(await stop.requestControlledShutdown({ reason: "first", finalAction })).toEqual(false);
        expect(readiness.getPhase()).toEqual("preparing");
        expect(stop.isStopping()).toEqual(false);
        expect(finalAction).not.toHaveBeenCalled();
        expect(await stop.requestControlledShutdown({ reason: "second", finalAction })).toEqual(true);
        expect(finalAction).toHaveBeenCalledTimes(1);
    });
});
