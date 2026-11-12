import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackground, createBackgroundTaskRunner, MCP_RESTORE_BARRIER_TIMEOUT_MS, type BackgroundDependencies } from "./background";
import { createStartupReadiness } from "./readiness";
import { createShutdownCoordinator } from "./shutdown";
afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function environment() {
    const readiness = createStartupReadiness();
    for (const phase of ["shell-ready", "core-ready", "background-starting"] as const)
        readiness.transition(phase);
    const events: string[] = [];
    const action = (name: string) => vi.fn(async () => { events.push(name); });
    const channels = { start: action("network"), shutdown: vi.fn() };
    const scheduler = { start: action("clock"), stop: vi.fn() };
    const deps: BackgroundDependencies = {
        readiness, shutdown: createShutdownCoordinator({ readiness }), core: {} as never,
        channels: channels as never, scheduler: scheduler as never,
        restoreMcp: action("restore"), pruneRemovedMcp: action("prune"), syncBuiltInMcp: action("sync"),
        reconcileMemory: action("memory"), scheduleEmbeddingRefresh: action("vectors"), initializeReranker: action("ranking"),
        prewarmScreenshot: action("capture"), scheduleUpdateCheck: action("updates"), startProactiveTrigger: action("trigger"),
    };
    return { deps, channels, scheduler, events };
}
describe("background task ownership", () => {
    it("disposes late resources before stop completes and rejects subsequent tasks", async () => {
        const resource = deferred<{
            dispose(): Promise<void>;
        }>();
        const cleanup = deferred<void>();
        const entered = deferred<void>();
        const dispose = vi.fn(async () => { entered.resolve(); await cleanup.promise; });
        const runner = createBackgroundTaskRunner();
        const running = runner.run("delayed-result", async () => resource.promise);
        let complete = false;
        const stopping = runner.stop().then(() => { complete = true; });
        resource.resolve({ dispose });
        await entered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(complete).toEqual(false);
        cleanup.resolve();
        await Promise.all([running, stopping]);
        expect(complete).toEqual(true);
        expect(dispose).toHaveBeenCalledTimes(1);
        await expect(runner.run("after-close", async () => undefined)).rejects.toThrow("stopped");
    });
});
describe("soft-start dependency groups", () => {
    it.each(["success", "failure", "timeout"])("continues to ready when MCP result is %s", async (outcome) => {
        const { deps, channels, scheduler, events } = environment();
        if (outcome === "failure") {
            deps.restoreMcp = async () => { throw new Error("provider unavailable"); };
            deps.prewarmScreenshot = async () => { throw new Error("capture unavailable"); };
        }
        if (outcome === "timeout") {
            vi.useFakeTimers();
            deps.restoreMcp = () => new Promise(() => undefined);
        }
        const background = startBackground(deps);
        if (outcome === "timeout")
            await vi.advanceTimersByTimeAsync(MCP_RESTORE_BARRIER_TIMEOUT_MS);
        await background.settled;
        expect(channels.start).toHaveBeenCalledTimes(1);
        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(deps.readiness.getPhase()).toEqual("ready");
        if (outcome === "success")
            expect(events.filter(event => ["restore", "network", "clock"].includes(event))).toEqual(["restore", "network", "clock"]);
        else
            expect(deps.readiness.getDegradedReasons().has("mcp")).toEqual(true);
        if (outcome === "failure")
            expect(deps.readiness.getDegradedReasons().has("screenshot")).toEqual(true);
    });
    it("awaits proactive and scheduler teardown before the final exit action", async () => {
        const { deps, scheduler } = environment();
        const triggerEntered = deferred<void>();
        const triggerReleased = deferred<void>();
        const schedulerEntered = deferred<void>();
        const schedulerReleased = deferred<void>();
        deps.startProactiveTrigger = async () => ({ dispose: async () => { triggerEntered.resolve(); await triggerReleased.promise; } });
        scheduler.stop.mockImplementation(async () => { schedulerEntered.resolve(); await schedulerReleased.promise; });
        await startBackground(deps).settled;
        const exit = vi.fn();
        const closing = deps.shutdown.requestControlledShutdown({ reason: "close", finalAction: exit });
        await triggerEntered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(exit).not.toHaveBeenCalled();
        triggerReleased.resolve();
        await schedulerEntered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(exit).not.toHaveBeenCalled();
        schedulerReleased.resolve();
        await closing;
        expect(exit).toHaveBeenCalledTimes(1);
        expect(scheduler.stop).toHaveBeenCalledTimes(1);
        expect(deps.readiness.getPhase()).toEqual("stopped");
    });
});
