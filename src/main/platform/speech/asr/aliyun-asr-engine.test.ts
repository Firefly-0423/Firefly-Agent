import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => [] as Array<{
  options?: unknown;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): void;
}>);
vi.mock("ws", () => ({
  WebSocket: class {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; this.emit("close", 1000); });
    terminate = vi.fn(() => { this.readyState = 3; this.emit("close", 1006); });
    constructor(_url: string, readonly options?: unknown) { sockets.push(this); }
    on(event: string, callback: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
    }
    emit(event: string, ...args: unknown[]) {
      for (const callback of this.listeners.get(event) ?? []) callback(...args);
    }
  },
}));

import { AliyunAsrStream } from "./aliyun-asr-engine";

const token = () => new Response(JSON.stringify({ Token: { Id: "synthetic-token" } }));
const start = (stream: AliyunAsrStream) => stream.start("synthetic-app", "synthetic-id", "synthetic-secret", "zh");
const message = (name: string, result?: string) => Buffer.from(JSON.stringify({
  header: { status: 20000000, name }, payload: { result },
}));
async function ready(stream: AliyunAsrStream) {
  const starting = start(stream);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  socket.readyState = 1;
  socket.emit("open");
  socket.emit("message", message("TranscriptionStarted"));
  await starting;
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => token()));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("Aliyun ASR stop ownership", () => {
  it("limits each WebSocket message before the service payload is decoded", async () => {
    const stream = new AliyunAsrStream(() => {}, () => {});
    const socket = await ready(stream);
    try { expect(socket.options).toMatchObject({ maxPayload: 1024 * 1024 }); }
    finally { stream.cancel(); }
  });

  it.each(["SentenceEnd", "TranscriptionResultChanged"])("rejects a non-string %s result without delivering text", async name => {
    const partial = vi.fn(); const final = vi.fn();
    const stream = new AliyunAsrStream(partial, final);
    const socket = await ready(stream);
    socket.emit("message", Buffer.from(JSON.stringify({ header: { name, status: 20000000 }, payload: { result: { text: "invalid" } } })));
    const outcome = stream.stop().catch(error => error);
    try {
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(await outcome).toMatchObject({ message: "ASR_INVALID_TRANSCRIPT" });
      expect(partial).not.toHaveBeenCalled(); expect(final).not.toHaveBeenCalled();
    } finally { stream.cancel(); await outcome; }
  });

  it("bounds aggregate transcript text and preserves its failure across stop/cancel", async () => {
    const final = vi.fn();
    const stream = new AliyunAsrStream(() => {}, final);
    const socket = await ready(stream);
    for (let i = 0; i < 64; i++) socket.emit("message", message("SentenceEnd", "x".repeat(500)));
    const stopping = stream.stop().catch(error => error);
    socket.emit("message", message("SentenceEnd", "overflow"));
    try {
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(await stopping).toMatchObject({ message: "ASR_TRANSCRIPT_LIMIT" });
      expect(final).toHaveBeenCalledTimes(64);
      stream.cancel();
      await expect(stream.stop()).rejects.toThrow("ASR_TRANSCRIPT_LIMIT");
      await expect(stream.stop()).rejects.toThrow("ASR_TRANSCRIPT_LIMIT");
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { stream.cancel(); await stopping; }
  });

  it("does not start token acquisition after the stream was stopped", async () => {
    const stream = new AliyunAsrStream(() => {}, () => {});
    stream.stop();
    await expect(start(stream)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it("aborts token acquisition and never opens a late socket after stop", async () => {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: unknown, options?: RequestInit) => {
      signal = options?.signal ?? undefined;
      return new Promise<Response>((done) => { resolve = done; });
    });
    const stream = new AliyunAsrStream(() => {}, () => {});
    const starting = start(stream).catch(error => error);
    stream.stop();
    resolve(token()); // A non-cooperative transport may still complete after abort.
    expect(await starting).toMatchObject({ name: "AbortError" });
    expect(sockets).toHaveLength(0);
    expect(signal?.aborted).toBe(true);
  });

  it("terminates a connecting socket and ignores its late open event", async () => {
    const stream = new AliyunAsrStream(() => {}, () => {});
    const starting = start(stream).catch(error => error);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    stream.stop();
    expect(await starting).toMatchObject({ name: "AbortError" });
    socket.readyState = 1;
    socket.emit("open");
    stream.stop();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes an open stream once and still receives its final transcript before closing", async () => {
    const final = vi.fn();
    const stream = new AliyunAsrStream(() => {}, final);
    const socket = await ready(stream);
    stream.sendAudio(Buffer.from([0, 0]));
    const stopping = stream.stop();
    expect(stream.stop()).toBe(stopping);
    socket.emit("message", Buffer.from(JSON.stringify({ header: { status: 20000000, name: "SentenceEnd" }, payload: { result: "合成转写" } })));
    expect(final).toHaveBeenCalledWith("合成转写");
    expect(socket.send.mock.calls.map(([value]) => Buffer.isBuffer(value) ? "pcm" : JSON.parse(value).header.name)).toEqual([
      "StartTranscription", "pcm", "StopTranscription",
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(stopping).resolves.toBe("合成转写");
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for TranscriptionStarted and shares a repeated start", async () => {
    const stream = new AliyunAsrStream(() => {}, () => {});
    const first = start(stream);
    const second = start(stream);
    let resolved = false;
    void first.then(() => { resolved = true; });
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    expect(sockets).toHaveLength(1);
    expect(resolved).toBe(false);
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    await Promise.resolve();
    expect(resolved).toBe(false);
    sockets[0].emit("message", message("TranscriptionStarted"));
    await Promise.all([first, second]);
    stream.cancel();
  });

  it("rejects token failures without opening a socket", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    await expect(start(new AliyunAsrStream(() => {}, () => {}))).rejects.toThrow("HTTP 401");
    expect(sockets).toHaveLength(0);
  });

  it("cancel closes an open socket without sending StopTranscription or delivering late text", async () => {
    const final = vi.fn();
    const stream = new AliyunAsrStream(() => {}, final);
    const socket = await ready(stream);
    const sends = socket.send.mock.calls.length;
    stream.sendAudio(Buffer.from([0, 0]));
    stream.cancel();
    socket.emit("message", message("SentenceEnd", "late"));
    await expect(stream.stop()).resolves.toBe("");
    expect(socket.send).toHaveBeenCalledTimes(sends);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(final).not.toHaveBeenCalled();
  });

  it("resolves stop on completion without waiting for the close deadline", async () => {
    const stream = new AliyunAsrStream(() => {}, () => {});
    const socket = await ready(stream);
    const stopping = stream.stop();
    socket.emit("message", message("SentenceEnd", "完成"));
    socket.emit("message", message("TranscriptionCompleted"));
    await expect(stopping).resolves.toBe("完成");
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
