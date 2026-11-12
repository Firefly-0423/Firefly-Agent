import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueLLMTask } from "./llm-queue";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("background model task options", () => {
    it("resolves without terminal output when logging is disabled", async () => {
        const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
        expect(await enqueueLLMTask("quiet-index-refresh", async () => 23, { log: false })).toEqual(23);
        expect(printed).not.toHaveBeenCalled();
    });
    it("propagates a one-shot rate limit without retrying", async () => {
        vi.useFakeTimers();
        const call = vi.fn().mockRejectedValue(new Error("request refused: 429"));
        const pending = enqueueLLMTask("single-attempt", call, { retryRateLimit: false, log: false });
        const checked = expect(pending).rejects.toThrow("429");
        await vi.runAllTimersAsync();
        await checked;
        expect(call).toHaveBeenCalledTimes(1);
    });
});
