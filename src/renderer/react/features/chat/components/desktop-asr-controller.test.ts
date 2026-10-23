import { afterEach, expect, it, vi } from "vitest";
import { DesktopAsrController } from "./desktop-asr-controller";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((r,j) => { resolve=r; reject=j; }); return { promise, resolve, reject }; }
function setup(overrides: Record<string, any> = {}) {
  const events: string[] = []; const text: string[] = []; const errors: string[] = [];
  let send!: (pcm: Uint8Array) => void; let microphoneError!: (error: string) => void;
  const capture = { stop: async () => { events.push("capture.stop"); }, cancel: () => { events.push("capture.cancel"); } };
  const api = { start: async () => { events.push("start"); return { ok: true }; }, frame: async () => { events.push("frame"); return { ok: true }; }, stop: async () => { events.push("stop"); return { ok: true, text: "dictated" }; }, cancel: async () => { events.push("cancel"); return { ok: true }; }, ...overrides.api };
  const controller = new DesktopAsrController({ api, capture: async (_signal, frame, error) => { events.push("capture"); send = frame; microphoneError = error; return overrides.capture ? overrides.capture() : capture; }, onText: value => text.push(value), onState: (_state, error) => { if (error) errors.push(error); }, ...overrides.deps });
  return { controller, events, text, errors, capture, send: (pcm = new Uint8Array(2)) => send(pcm), microphoneError: () => microphoneError("microphone_error") };
}
afterEach(() => vi.useRealTimers());
it("starts only on request, ignores repeat starts, drains frames and fills once without sending a chat message", async () => {
  const h = setup(); expect(h.events).toEqual([]);
  await Promise.all([h.controller.start(), h.controller.start()]); h.send();
  await Promise.all([h.controller.stop(), h.controller.stop()]);
  expect(h.events).toEqual(["start", "capture", "capture.stop", "frame", "stop", "capture.cancel"]); expect(h.text).toEqual(["dictated"]);
});
it("reports unconfigured service before requesting microphone and sanitizes permission denial", async () => {
  const h = setup({ api: { start: async () => ({ ok: false, code: "unconfigured" }) } }); await h.controller.start();
  expect(h.events).not.toContain("capture"); expect(h.errors).toEqual(["unconfigured"]);
  const denied = setup({ capture: async () => { throw Object.assign(new Error("private-device"), { name: "NotAllowedError" }); } });
  await denied.controller.start(); expect(denied.errors).toEqual(["microphone_denied"]); expect(denied.events).toContain("cancel");
});
it("cancels pending start and never opens the microphone after a late service response", async () => {
  const pending = deferred<any>(); const h = setup({ api: { start: () => pending.promise } });
  const started = h.controller.start(); h.controller.cancel(); pending.resolve({ ok: true }); await started;
  expect(h.events).toEqual(["cancel"]); expect(h.text).toEqual([]);
});
it("releases a microphone permission result that arrives after cancellation", async () => {
  const pending = deferred<any>(); const h = setup({ capture: () => pending.promise });
  const started = h.controller.start(); await Promise.resolve(); h.controller.cancel(); pending.resolve(h.capture); await started;
  expect(h.events).toContain("capture.cancel"); expect(h.text).toEqual([]);
});
it("does not fill a new draft after stop was cancelled or the component disposed", async () => {
  const pending = deferred<any>(); const h = setup({ api: { stop: () => pending.promise } });
  await h.controller.start(); const stopped = h.controller.stop(); await Promise.resolve(); h.controller.dispose();
  pending.resolve({ ok: true, text: "old text" }); await stopped;
  expect(h.text).toEqual([]); await h.controller.start(); expect(h.events.filter(x => x === "start")).toHaveLength(1);
});
it("cancels capture on disconnect, failed PCM delivery and queue overflow", async () => {
  const failed = setup({ api: { frame: async () => ({ ok: false, code: "expired" }) } }); await failed.controller.start(); failed.send(); await new Promise(resolve => setTimeout(resolve, 0)); expect(failed.errors).toEqual(["expired"]); expect(failed.events).toContain("capture.cancel");
  const queued = setup({ api: { frame: () => new Promise(() => {}) } }); await queued.controller.start(); for (let n=0;n<9;n++) queued.send(); expect(queued.errors).toEqual(["limit"]); expect(queued.events).toContain("capture.cancel");
  const ended = setup(); await ended.controller.start(); ended.microphoneError(); expect(ended.errors).toEqual(["microphone_error"]);
});
it("expires a pending permission request and caps recording duration", async () => {
  vi.useFakeTimers(); const pending = deferred<any>(); const h = setup({ capture: () => pending.promise }); const started=h.controller.start(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(30_000); expect(h.errors).toEqual(["timeout"]); pending.resolve(h.capture); await started;
  const recording = setup(); await recording.controller.start(); await vi.advanceTimersByTimeAsync(110_000); expect(recording.text).toEqual(["dictated"]);
});
it("cancels a granted microphone if focus was lost during the permission prompt", async () => {
  const pending=deferred<any>();let focused=true;
  const h=setup({capture:()=>pending.promise,deps:{isFocused:()=>focused}});
  const started=h.controller.start();await Promise.resolve();focused=false;pending.resolve(h.capture);await started;
  expect(h.events).toContain("capture.cancel");expect(h.events).toContain("cancel");expect(h.errors).toEqual(["cancelled"]);expect(h.text).toEqual([]);
});
