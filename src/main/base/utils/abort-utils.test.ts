import { describe, it, expect, vi } from "vitest";
import { raceWithSignal, createAbortError, isAbortError, isCancellationError } from "./abort-utils";
describe("cancellation at promise boundaries", () => {
    it("keeps the original failure and detaches the abort subscription", async () => {
        const stop = new AbortController();
        const detached = vi.spyOn(stop.signal, "removeEventListener");
        const failure = new Error("network unavailable");
        await expect(raceWithSignal(Promise.reject(failure), stop.signal)).rejects.toBe(failure);
        expect(detached).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    });
    it("returns a settled value and releases its subscription", async () => {
        const stop = new AbortController();
        const detached = vi.spyOn(stop.signal, "removeEventListener");
        const value = { completed: 7 };
        expect(await raceWithSignal(Promise.resolve(value), stop.signal)).toBe(value);
        expect(detached).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    });
    it("interrupts a source that has not completed", async () => {
        const stop = new AbortController();
        const outcome = raceWithSignal(new Promise<number>(() => undefined), stop.signal);
        stop.abort();
        await expect(outcome).rejects.toMatchObject({ name: "AbortError", message: "Operation aborted" });
    });
    it("rejects an already cancelled request and preserves an unguarded promise", async () => {
        const original = Promise.resolve(17);
        expect(raceWithSignal(original)).toBe(original);
        await expect(raceWithSignal(original, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
        expect(isAbortError(createAbortError())).toBe(true);
        expect(isAbortError({ name: "AbortError" })).toBe(false);
        expect(isCancellationError(new Error("failure"))).toBe(false);
        expect(isCancellationError(null, AbortSignal.abort())).toBe(true);
    });
});
