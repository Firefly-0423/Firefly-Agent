import { describe, expect, it } from "vitest";
import { createStartupReadiness } from "./readiness";
describe("startup wait contracts", () => {
    it("resolves both existing and newly created core waiters", async () => {
        const state = createStartupReadiness();
        const early = state.waitFor("core-ready");
        state.transition("shell-ready");
        state.transition("core-ready");
        await expect(early).resolves.toBeUndefined();
        await expect(state.waitFor("core-ready")).resolves.toBeUndefined();
    });
    it("keeps capability degradation separate from lifecycle progress", () => {
        const state = createStartupReadiness({ now: () => 71 });
        state.transition("shell-ready");
        state.markDegraded({ capability: "search", message: "index unavailable", at: 71 });
        state.transition("core-ready");
        expect(state.getPhase()).toEqual("core-ready");
        expect(state.getDegradedReasons().has("search")).toEqual(true);
        state.clearDegraded("search");
        expect(state.getDegradedReasons().has("search")).toEqual(false);
        expect(state.getPhase()).toEqual("core-ready");
    });
    it("rejects a skipped startup phase without mutating its current phase", () => {
        const state = createStartupReadiness();
        expect(() => state.transition("ready")).toThrow("invalid startup phase transition: preparing -> ready");
        expect(state.getPhase()).toEqual("preparing");
    });
    it.each([["failed", "startup failed"], ["stopping", "startup aborted: stopping"]] as const)("rejects pending work on %s", async (phase, message) => {
        const state = createStartupReadiness();
        const outcome = state.waitFor(phase === "failed" ? "core-ready" : "ready");
        state.transition(phase);
        await expect(outcome).rejects.toThrow(message);
    });
    it("honors caller cancellation", async () => {
        const state = createStartupReadiness();
        const cancellation = new AbortController();
        const outcome = state.waitFor("ready", cancellation.signal);
        cancellation.abort();
        await expect(outcome).rejects.toThrow(/abort/i);
        await expect(state.waitFor("ready", cancellation.signal)).rejects.toThrow("startup wait aborted");
    });
});
