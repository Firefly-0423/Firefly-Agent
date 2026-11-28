import { afterEach, describe, it, expect, vi } from "vitest";
import { MosslandAsrStream, encodePcm16MonoWav } from "./mossland-asr-engine";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Mossland wire format", () => {
    it("encodes little-endian mono 16-bit samples with a complete WAV header", () => {
        const samples = Buffer.from([15, 3, 92, 7]);
        const wav = encodePcm16MonoWav(samples);
        expect([wav.toString("ascii", 0, 4), wav.toString("ascii", 8, 12), wav.toString("ascii", 12, 16), wav.toString("ascii", 36, 40)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
        expect([wav.readUInt32LE(4), wav.readUInt32LE(16), wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34), wav.readUInt32LE(40)]).toEqual([40, 16, 1, 1, 16000, 32000, 2, 16, 4]);
        expect(wav.subarray(44)).toEqual(samples);
    });
    it("posts all captured frames as a single named WAV attachment", async () => {
        const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Transcript result" })));
        vi.stubGlobal("fetch", send);
        const delivered = vi.fn();
        const session = new MosslandAsrStream("caption-token", delivered);
        await session.start();
        session.sendAudio(Buffer.from([12, 1]));
        session.sendAudio(Buffer.from([64, 2]));
        expect(await session.stop()).toEqual("Transcript result");
        expect(delivered.mock.calls).toEqual([["Transcript result"]]);
        expect(send).toHaveBeenCalledTimes(1);
        const [url, request] = send.mock.calls[0];
        expect(url).toEqual("https://api.mosi.cn/v1/audio/transcriptions");
        expect(request.method).toEqual("POST");
        expect(new Headers(request.headers).get("Authorization")).toEqual("Bearer caption-token");
        expect(request.body).toBeInstanceOf(FormData);
        const body = request.body as FormData;
        expect([body.get("model"), body.get("response_format")]).toEqual(["moss-transcribe", "json"]);
        const audio = body.get("file") as File;
        expect(audio).toBeInstanceOf(File);
        expect([audio.name, audio.type]).toEqual(["speech.wav", "audio/wav"]);
        expect(Buffer.from(await audio.arrayBuffer()).subarray(44)).toEqual(Buffer.from([12, 1, 64, 2]));
    });
});
describe("transcription completion and interruption", () => {
    it("does not upload an empty or cancelled recording and forbids restarting a cancelled one", async () => {
        const send = vi.fn();
        vi.stubGlobal("fetch", send);
        const delivered = vi.fn();
        const empty = new MosslandAsrStream("test-token", delivered);
        expect(await empty.stop()).toEqual("");
        const cancelled = new MosslandAsrStream("test-token", delivered);
        await cancelled.start();
        cancelled.sendAudio(Buffer.from([3, 0]));
        cancelled.cancel();
        cancelled.sendAudio(Buffer.from([7, 0]));
        expect(await cancelled.stop()).toEqual("");
        expect(send).not.toHaveBeenCalled();
        expect(delivered).not.toHaveBeenCalled();
        await expect(cancelled.start()).rejects.toMatchObject({ name: "AbortError" });
    });
    it.each([true, false])("times out a stalled body after headers with ok=%s", async (ok) => {
        vi.useFakeTimers();
        let signal!: AbortSignal;
        vi.stubGlobal("fetch", vi.fn((_url, request) => {
            signal = request.signal;
            return Promise.resolve({ ok, status: ok ? 200 : 401, json: () => new Promise(() => undefined), text: () => new Promise(() => undefined) });
        }));
        const delivered = vi.fn();
        const session = new MosslandAsrStream("deadline-token", delivered);
        session.sendAudio(Buffer.from([8, 0]));
        const checked = expect(session.stop()).rejects.toThrow("Mossland 转写超时");
        await vi.advanceTimersByTimeAsync(30001);
        await checked;
        expect(signal.aborted).toEqual(true);
        expect(delivered).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toEqual(0);
    });
    it("aborts an upload and ignores a late uncooperative result", async () => {
        vi.useFakeTimers();
        let release!: (response: Response) => void;
        let signal!: AbortSignal;
        vi.stubGlobal("fetch", vi.fn((_url, request) => {
            signal = request.signal;
            return new Promise<Response>(resolve => { release = resolve; });
        }));
        const delivered = vi.fn();
        const session = new MosslandAsrStream("cancel-token", delivered);
        session.sendAudio(Buffer.from([21, 0]));
        const pending = session.stop();
        session.cancel();
        expect(await pending).toEqual("");
        expect(signal.aborted).toEqual(true);
        expect(vi.getTimerCount()).toEqual(0);
        release(new Response(JSON.stringify({ text: "This must be ignored" })));
        await Promise.resolve();
        await Promise.resolve();
        expect(delivered).not.toHaveBeenCalled();
    });
    it("reports the shared authentication failure verbatim", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error", code: "authentication_error", param: null } }), { status: 401 })));
        const session = new MosslandAsrStream("rejected-token", vi.fn());
        session.sendAudio(Buffer.from([33, 0]));
        await expect(session.stop()).rejects.toThrow("Mossland 转写失败：API Key 无效，请检查 Authorization 头 (HTTP 401, code: authentication_error)");
    });
});
