import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsrStream } from "./asr-dispatcher";
afterEach(() => vi.unstubAllGlobals());
describe("batch ASR selection", () => {
    it("delivers Mossland transcription through both stop and final notification", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Spoken phrase" }))));
        const final = vi.fn();
        const partial = vi.fn();
        const session = createAsrStream({ apiKey: "test-transcriber", engine: "mossland" }, partial, final);
        await session.start();
        session.sendAudio(Buffer.from([4, 0, 9, 0]));
        expect(await session.stop()).toEqual("Spoken phrase");
        expect(final.mock.calls).toEqual([["Spoken phrase"]]);
        expect(partial).not.toHaveBeenCalled();
    });
});
