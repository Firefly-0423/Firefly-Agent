import { afterEach, expect, it, vi } from "vitest";
import { DesktopAsrService, DESKTOP_ASR_LIMITS } from "./desktop-asr-service";
const id = "recording-fixture-0001";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function setup(overrides: Record<string, unknown> = {}) {
  const received: Buffer[] = []; let cancels = 0;
  const stream = { start: async () => {}, sendAudio: (pcm: Buffer) => received.push(pcm), stop: async () => "转写文本", cancel: () => { cancels++; }, ...overrides };
  const service = new DesktopAsrService({ getConfig: () => ({ engine: "mossland", apiKey: "synthetic" }), createStream: () => stream });
  return { service, stream, received, cancels: () => cancels };
}
afterEach(() => vi.useRealTimers());
it("returns only the stopped session transcript and releases its owner", async () => {
  const { service, received } = setup();
  expect(await service.start(1, id)).toEqual({ ok: true });
  const frame = new Uint8Array([0, 1, 2, 3]);
  expect(service.frame(1, id, frame)).toEqual({ ok: true }); frame[0] = 99;
  expect(received[0]).toEqual(Buffer.from([0, 1, 2, 3]));
  expect(await service.stop(1, id)).toEqual({ ok: true, text: "转写文本" });
  expect(await service.stop(1, id)).toEqual({ ok: false, code: "expired" });
  expect(await service.start(1, "next-recording-0002")).toEqual({ ok: true }); service.dispose();
});
it("rejects disabled, blank credentials, invalid IDs and another session owner", async () => {
  const { service } = setup();
  expect(await service.start(1, "")).toEqual({ ok: false, code: "invalid_request" });
  await service.start(1, id);
  expect(await service.start(1, "recording-fixture-0002")).toEqual({ ok: false, code: "busy" });
  expect(service.frame(2, id, new Uint8Array(2))).toEqual({ ok: false, code: "expired" });
  expect(await service.stop(2, id)).toEqual({ ok: false, code: "expired" });
  service.cancel(2, id); expect(await service.stop(1, id)).toMatchObject({ ok: true });
  for (const config of [null, { engine: "mossland", apiKey: " " }, { engine: "aliyun", appKey: "x", accessKeyId: "", accessKeySecret: "x", language: "zh" }]) {
    const unconfigured = new DesktopAsrService({ getConfig: () => config as never, createStream: () => { throw new Error("must not connect"); } });
    expect(await unconfigured.start(1, id)).toEqual({ ok: false, code: "unconfigured" });
  }
});
it("cancels a pending start and suppresses late completion without damaging a newer recording", async () => {
  const pending = deferred<void>(); const { service, cancels } = setup({ start: () => pending.promise });
  const start = service.start(1, id); service.cancel(1, id); pending.resolve();
  expect(await start).toEqual({ ok: false, code: "cancelled" }); expect(cancels()).toBe(1);
  expect(await service.start(1, "next-recording-0002")).toEqual({ ok: true }); service.dispose();
});
it("cancels a pending stop and never returns its late text", async () => {
  const pending = deferred<string>(); const { service, cancels } = setup({ stop: () => pending.promise });
  await service.start(1, id); const stopping = service.stop(1, id); service.cancelAll();
  pending.resolve("must not appear"); expect(await stopping).toEqual({ ok: false, code: "cancelled" }); expect(cancels()).toBe(1);
});
it("bounds malformed frames, total PCM, frame count, start and recording duration", async () => {
  vi.useFakeTimers();
  for (const frame of [new Uint8Array(3), new Uint8Array(DESKTOP_ASR_LIMITS.maxFrameBytes + 2), "audio", {}]) {
    const { service, cancels } = setup(); await service.start(1, id);
    expect(service.frame(1, id, frame)).toEqual({ ok: false, code: "invalid_audio" }); expect(cancels()).toBe(1);
  }
  const bytes = setup(); await bytes.service.start(1, id);
  for (let n = 0; n < DESKTOP_ASR_LIMITS.maxBytes / DESKTOP_ASR_LIMITS.maxFrameBytes; n++) expect(bytes.service.frame(1, id, new Uint8Array(DESKTOP_ASR_LIMITS.maxFrameBytes)).ok).toBe(true);
  expect(bytes.service.frame(1, id, new Uint8Array(2))).toEqual({ ok: false, code: "limit" });
  const count = setup(); await count.service.start(1, id);
  for (let n = 0; n < DESKTOP_ASR_LIMITS.maxFrames; n++) count.service.frame(1, id, new Uint8Array(2));
  expect(count.service.frame(1, id, new Uint8Array(2))).toEqual({ ok: false, code: "limit" });
  const timed = setup(); await timed.service.start(1, id); await vi.advanceTimersByTimeAsync(DESKTOP_ASR_LIMITS.recordingMs);
  expect(timed.cancels()).toBe(1); expect(await timed.service.stop(1, id)).toEqual({ ok: false, code: "expired" });
  const pending = setup({ start: () => new Promise(() => {}) }); const start = pending.service.start(1, id);
  await vi.advanceTimersByTimeAsync(DESKTOP_ASR_LIMITS.operationMs); expect(await start).toEqual({ ok: false, code: "timeout" }); expect(pending.cancels()).toBe(1);
});
it("sanitizes provider failures and allows retry", async () => {
  const { service, cancels } = setup({ start: async () => { throw new Error("secret provider response"); } });
  expect(await service.start(1, id)).toEqual({ ok: false, code: "service_error" }); expect(cancels()).toBe(1);
  expect(await service.start(1, "next-recording-0002")).toEqual({ ok: false, code: "service_error" });
});
