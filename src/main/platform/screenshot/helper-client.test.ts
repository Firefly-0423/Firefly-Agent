import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { ElectronScreenshotHelperClient, type HelperChildProcess } from "./helper-client";

function attachNativeProcess(pipe: { destroyed?: boolean; throwOnWrite?: boolean } = {}) {
  const output = new EventEmitter();
  const errors = new EventEmitter();
  const lifecycle = new EventEmitter();
  const input = new EventEmitter();
  const observeInput = vi.spyOn(input, "on");
  const write = vi.fn((_line: string) => {
    if (pipe.throwOnWrite) throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
    return true;
  });
  const processPort: HelperChildProcess = {
    stdin: { write, destroyed: pipe.destroyed, on: (event, callback) => input.on(event, callback) },
    stdout: output, stderr: errors, on: (event, callback) => lifecycle.on(event, callback),
  };
  let ticket = 70;
  const api = new ElectronScreenshotHelperClient({
    screenshotDirectory: "D:\\capture-output", resolveHelperPath: () => "D:\\Firefly\\bin\\capture.exe",
    parentProcessId: 87, now: () => 4500, createRequestId: () => `ticket-${++ticket}`,
    logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() }, spawnImpl: () => processPort,
  });
  const send = (event: Record<string, unknown>) => output.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  return { api, write, observeInput, input, send, exit: () => lifecycle.emit("exit", 9, null),
    boot: async () => { const waiting = api.ensureStarted(); send({ type: "ready", protocolVersion: 1 }); await waiting; } };
}

function complete(requestId: string, extra: Record<string, unknown> = {}) {
  return { type: "completed", requestId, fileName: null, mime: "image/png", width: 14, height: 28,
    clipboardWritten: true, hasAnnotations: true, ...extra };
}
const released = (requestId: string) => ({ type: "capture-released", requestId, width: 960, height: 540, clipboardWritten: true });

describe("Native capture process requests", () => {
  it("starts ready without opening a capture and serializes only helper command fields", async () => {
    const port = attachNativeProcess();
    await port.boot();
    expect([port.api.processState, port.api.captureState]).toEqual(["ready", "idle"]);
    const pending = port.api.start("clipboard-only", "hotkey");
    expect(port.api.captureState).toEqual("freezing");
    expect(port.write.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { requestId: "ticket-71", type: "start", mode: "clipboard-only" },
    ]);
    expect(port.api.pendingRequests.get("ticket-71")).toMatchObject({ source: "hotkey", captureReleased: false });
    for (const phase of ["selecting", "selected", "committing"] as const) {
      port.send({ type: "interaction-state", requestId: "ticket-71", state: phase });
      expect(port.api.captureState).toEqual(phase);
    }
    port.send(complete("ticket-71"));
    expect(await pending).toEqual({ requestId: "ticket-71", filePath: null, width: 14, height: 28,
      mime: "image/png", clipboardWritten: true, hasAnnotations: true });
    expect(port.api.captureState).toEqual("idle");
    expect(port.api.pendingRequests.size).toEqual(0);
  });

  it.runIf(process.platform === "win32")("retains an encoding request after interaction releases", async () => {
    const port = attachNativeProcess();
    await port.boot();
    const pending = port.api.start("clipboard-and-file", "chat-button");
    port.send(released("ticket-71"));
    expect(port.api.pendingRequests.get("ticket-71")).toMatchObject({ source: "chat-button", captureReleased: true });
    expect(port.api.captureState).toEqual("idle");
    port.send(complete("ticket-71", { fileName: "f1e2d3c4-b5a6-4789-9abc-1234567890ab.png", width: 960, height: 540, hasAnnotations: false }));
    expect(await pending).toMatchObject({ filePath: "D:\\capture-output\\f1e2d3c4-b5a6-4789-9abc-1234567890ab.png" });
    expect(port.api.pendingRequests.size).toEqual(0);
  });

  it("keeps a newer capture freezing when earlier encoding fails", async () => {
    const port = attachNativeProcess();
    await port.boot();
    const encoding = port.api.start("clipboard-and-file", "chat-button");
    port.send(released("ticket-71"));
    const capture = port.api.start("clipboard-only", "hotkey");
    expect(port.api.captureState).toEqual("freezing");
    const failed = expect(encoding).rejects.toThrow("encode-failed: storage unavailable");
    port.send({ type: "error", requestId: "ticket-71", code: "encode-failed", message: "storage unavailable", recoverable: true });
    await failed;
    expect(port.api.captureState).toEqual("freezing");
    port.send(complete("ticket-72"));
    expect(await capture).toMatchObject({ requestId: "ticket-72" });
  });

  it("fails both encoding and active capture requests on process exit", async () => {
    const port = attachNativeProcess();
    await port.boot();
    const encoding = port.api.start("clipboard-and-file", "chat-button");
    port.send(released("ticket-71"));
    const capture = port.api.start("clipboard-only", "hotkey");
    const rejected = [expect(encoding).rejects.toThrow("HELPER_EXITED:9"), expect(capture).rejects.toThrow("HELPER_EXITED:9")];
    port.exit();
    await Promise.all(rejected);
    expect(port.api.pendingRequests.size).toEqual(0);
    expect(port.api.captureState).toEqual("idle");
  });
});

describe("Closed helper input pipe", () => {
  it("does not write a shutdown command to a destroyed input stream", async () => {
    const port = attachNativeProcess({ destroyed: true });
    void port.api.ensureStarted();
    await expect(port.api.shutdown()).resolves.toBeUndefined();
    expect(port.write).not.toHaveBeenCalled();
  });

  it("contains synchronous input write errors during shutdown", async () => {
    const port = attachNativeProcess({ throwOnWrite: true });
    void port.api.ensureStarted();
    await expect(port.api.shutdown()).resolves.toBeUndefined();
    expect(port.write).toHaveBeenCalledExactlyOnceWith('{"type":"shutdown"}\n');
  });

  it("handles asynchronous input stream errors without throwing", async () => {
    const port = attachNativeProcess();
    void port.api.ensureStarted();
    expect(port.observeInput).toHaveBeenCalledWith("error", expect.any(Function));
    expect(() => port.input.emit("error", Object.assign(new Error("pipe closed"), { code: "EPIPE" }))).not.toThrow();
  });
});
