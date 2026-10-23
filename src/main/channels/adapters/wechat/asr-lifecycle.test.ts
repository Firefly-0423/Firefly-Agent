import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  engine: "aliyun",
  start: vi.fn(), sendAudio: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("real paths forbidden"); } } }));
vi.mock("../../../asr/asr-config", () => ({ getAsrConfig: () => fixture.engine === "mossland"
  ? { engine: "mossland", apiKey: "synthetic" }
  : { engine: "aliyun", appKey: "synthetic", accessKeyId: "synthetic", accessKeySecret: "synthetic", language: "zh" } }));
vi.mock("../../../asr/asr-dispatcher", () => ({ createAsrStream: () => fixture }));
vi.mock("./wechat-media-download", () => ({ downloadWechatMedia: async () => Buffer.from([0, 0]) }));

import { ILinkBotAdapter } from "./ilink-bot-adapter";

function transcribe(signal?: AbortSignal): Promise<string> {
  return (new ILinkBotAdapter() as any).transcribeVoice({ kind: "voice", media: { aes_key: "synthetic" }, sampleRate: 16000 }, "synthetic-message", signal);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); fixture.engine = "aliyun";
  fixture.start.mockResolvedValue(undefined); fixture.stop.mockResolvedValue("合成转写");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("WeChat ASR owns the entire asynchronous turn", () => {
  it("bounds token/handshake startup and blocks late audio submission after its deadline", async () => {
    let release!: () => void;
    fixture.start.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const result = transcribe().catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ message: "ASR timeout" });
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.stop).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.sendAudio).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the same deadline while final transcription is stalled", async () => {
    fixture.stop.mockImplementation(() => new Promise(() => {}));
    const result = transcribe().catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ message: "ASR timeout" });
    expect(fixture.sendAudio).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["aliyun", "mossland"])("returns the awaited %s final transcript and releases resources", async engine => {
    fixture.engine = engine;
    const result = transcribe().then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ value: "合成转写" });
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-progress startup when the inbound owner is cancelled", async () => {
    fixture.start.mockImplementation(() => new Promise(() => {}));
    const owner = new AbortController();
    const result = transcribe(owner.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.sendAudio).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
