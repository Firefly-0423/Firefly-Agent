import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const electron = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => electron.userData }, shell: { openPath: vi.fn() } }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createNativeHistoryPresenceEndpoint } from "./native-history-presence-process";

// Protocol mocks still exercise the real absolute-path preflight. Native integration
// requires a Windows build: cargo build --manifest-path native/Cargo.toml
// --features history-read --bin firefly-history-presence.
const HELPER = process.env.FIREFLY_HISTORY_PRESENCE_TEST_HELPER
  ?? path.resolve("native/target/debug/firefly-history-presence.exe");
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-presence-process-"));
});
afterEach(() => {
  expect(path.dirname(root)).toBe(os.tmpdir());
  fs.rmSync(root, { recursive: true });
});
describe("native metadata process endpoint", () => {
  it.runIf(process.platform === "win32")("maps real bounded helper results and confirms its exact exit [requires Windows native helper]", async () => {
    fs.mkdirSync(path.join(root, "transcripts", "a"), { recursive: true });
    const leaf = path.join(root, "transcripts", "a", "snapshot.json");
    fs.writeFileSync(leaf, "SYNTHETIC_BODY_NOT_JSON");
    const before = fs.readFileSync(leaf);
    const endpoint = createNativeHistoryPresenceEndpoint(HELPER);
    const session = await endpoint.open(root, 3000, new AbortController().signal);
    try {
      expect(await session.probe(["a", "absent", "../escape"], new AbortController().signal)).toEqual([
        { status: "present" }, { status: "missing", component: "session" },
        { status: "unknown-denied", reason: "history-invalid-path" },
      ]);
      expect(await session.probe(["a"], new AbortController().signal)).toEqual([{ status: "present" }]);
    } finally { await session.close(); }
    await session.close();
    expect(fs.readFileSync(leaf)).toEqual(before);
  });
  it("does not launch for a pre-cancelled scope", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, controller.signal)).rejects.toThrow("PRESENCE_CANCELLED");
  });
  it.runIf(process.platform === "win32")("closes a ready helper on cancellation [requires Windows native helper]", async () => {
    const controller = new AbortController();
    const session = await createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, controller.signal);
    controller.abort();
    await expect(session.probe(["a"], controller.signal)).rejects.toThrow("PRESENCE_CANCELLED");
    await session.close();
  });
  it("rejects invalid helper location and budgets before spawn", async () => {
    expect(() => createNativeHistoryPresenceEndpoint("relative.exe")).toThrow("PRESENCE_INVALID_HELPER");
    const endpoint = createNativeHistoryPresenceEndpoint(HELPER);
    for (const deadline of [0, 30001, NaN]) await expect(endpoint.open(root, deadline, new AbortController().signal)).rejects.toThrow("PRESENCE_INVALID_BUDGET");
  });
  it("rejects an absent helper without leaving an open child", async () => {
    await expect(createNativeHistoryPresenceEndpoint(path.join(root, "firefly-history-presence.exe")).open(root, 3000, new AbortController().signal)).rejects.toThrow("PRESENCE_PROCESS_FAILED");
  });
  it.runIf(process.platform === "win32")("rejects an unavailable root [requires Windows native helper]", async () => {
    await expect(createNativeHistoryPresenceEndpoint(HELPER).open(path.join(root, "not-created"), 3000, new AbortController().signal)).rejects.toThrow("PRESENCE_NATIVE_FAILED");
  });
  it.runIf(process.platform === "win32")("rejects overlapping and oversized requests and confirms cleanup [requires Windows native helper]", async () => {
    const signal = new AbortController().signal;
    const session = await createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, signal);
    await expect(session.probe(Array.from({ length: 33 }, () => "a"), signal)).rejects.toThrow("PRESENCE_INVALID_BATCH");
    const first = session.probe(["a"], signal);
    await expect(session.probe(["b"], signal)).rejects.toThrow("PRESENCE_BUSY");
    expect(await first).toEqual([{ status: "missing", component: "transcripts" }]);
    await session.close();
  });
  it("rejects malformed, extra-field and oversized process frames", async () => {
    for (const reply of [
      '{"type":"results","version":2,"observations":[]}\n',
      '{"type":"results","version":1,"observations":[],"root":"foreign"}\n',
      'not-json\n', "x".repeat(8193),
    ]) {
      const fake = new EventEmitter() as ChildProcessWithoutNullStreams;
      fake.stdin = new PassThrough() as never; fake.stdout = new PassThrough() as never; fake.stderr = new PassThrough() as never;
      fake.kill = vi.fn(() => { fake.emit("close", 0); return true; });
      fake.stdin.on("data", (data: Buffer) => {
        if (data.toString().includes('"probe"')) fake.stdout.emit("data", Buffer.from(reply));
        else if (data.toString().includes('"cancel"')) fake.emit("close", 0);
      });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => fake.stdout.emit("data", Buffer.from('{"type":"ready","version":1}\n')));
        return fake;
      });
      const session = await createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, new AbortController().signal);
      await expect(session.probe(["a"], new AbortController().signal)).rejects.toThrow("PRESENCE_PROTOCOL_FAILED");
      await expect(session.close()).rejects.toThrow("PRESENCE_PROTOCOL_FAILED");
    }
  });
  it.runIf(process.platform === "win32")("connects actual Main cache selection through the real helper with zero source I/O [requires Windows native helper]", async () => {
    const { resolveRuntimeProfile } = await import("../runtime-profile");
    const { initializeStorageContext } = await import("../storage-context");
    // A production-shaped profile rooted entirely in the synthetic fixture; no live app.
    const context = initializeStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=production"], env: {}, isPackaged: true, productionAppData: root }));
    electron.userData = context.dataRoot;
    const chats = path.join(context.dataRoot, "firefly-chats");
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, "index.json"), JSON.stringify(["a", "b"].map((id) => ({ id, title: "synthetic", createdAt: 1, updatedAt: 1, messageCount: 0, mode: "chat" }))));
    fs.mkdirSync(path.join(context.dataRoot, "transcripts", "a"), { recursive: true });
    fs.writeFileSync(path.join(context.dataRoot, "transcripts", "a", "snapshot.json"), "SYNTHETIC_BODY");
    const store = await import("../chats/chats-store"); store.initialize(); // Synthetic setup before measurement.
    const { selectCachedHistoryCoverage, measureHistoryPresence } = await import("./native-history-coverage");
    const selected = selectCachedHistoryCoverage();
    const spies = ["readFileSync", "writeFileSync", "readdirSync", "mkdirSync", "statSync"].map((name) => vi.spyOn(fs, name as "readFileSync"));
    try {
      expect(await measureHistoryPresence(selected, createNativeHistoryPresenceEndpoint(HELPER))).toMatchObject({
        status: "measured", population: 2, present: 1, missing: 1, unknownDenied: 0, exactRatio: 0.5,
        evidence: { status: "not-evaluated", eligible: null },
      });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it("never confirms child exit when forced termination fails", async () => {
    vi.useFakeTimers();
    try {
      const fake = new EventEmitter() as ChildProcessWithoutNullStreams;
      fake.stdin = new PassThrough() as never; fake.stdout = new PassThrough() as never; fake.stderr = new PassThrough() as never;
      fake.kill = vi.fn(() => { throw new Error("synthetic kill denied"); });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => fake.stdout.emit("data", Buffer.from('{"type":"ready","version":1}\n')));
        return fake;
      });
      const session = await createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, new AbortController().signal);
      const confirmed = expect(session.close()).rejects.toThrow("PRESENCE_CLEANUP_FAILED");
      await vi.advanceTimersByTimeAsync(800);
      await confirmed;
    } finally { vi.useRealTimers(); }
  });

  it.each(["ready", "results", "after-results"])("refuses unsolicited frames after %s", async (phase) => {
      const fake = new EventEmitter() as ChildProcessWithoutNullStreams;
      fake.stdin = new PassThrough() as never; fake.stdout = new PassThrough() as never; fake.stderr = new PassThrough() as never;
      fake.kill = vi.fn(() => { fake.emit("close", 0); return true; });
      const result = '{"type":"results","version":1,"observations":[{"status":"present"}]}\n';
      fake.stdin.on("data", (data: Buffer) => {
        if (data.toString().includes('"probe"')) fake.stdout.emit("data", Buffer.from(phase === "results" ? result + result : result));
        else if (data.toString().includes('"cancel"')) fake.emit("close", 0);
      });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => fake.stdout.emit("data", Buffer.from('{"type":"ready","version":1}\n' + (phase === "ready" ? result : ""))));
        return fake;
      });
      const opening = createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, new AbortController().signal);
      if (phase === "ready") { await expect(opening).rejects.toThrow("PRESENCE_PROTOCOL_FAILED"); return; }
      const session = await opening;
      if (phase === "results") await expect(session.probe(["a"], new AbortController().signal)).rejects.toThrow("PRESENCE_PROTOCOL_FAILED");
      else { await session.probe(["a"], new AbortController().signal); fake.stdout.emit("data", Buffer.from(result)); }
      await expect(session.close()).rejects.toThrow("PRESENCE_PROTOCOL_FAILED");
  });
  it.each(["stdout", "stderr"] as const)("handles private %s errors without uncaught details", async (pipe) => {
      const fake = new EventEmitter() as ChildProcessWithoutNullStreams;
      fake.stdin = new PassThrough() as never; fake.stdout = new PassThrough() as never; fake.stderr = new PassThrough() as never;
      fake.kill = vi.fn(() => { fake.emit("close", 0); return true; });
      fake.stdin.on("data", (data: Buffer) => {
        if (data.toString().includes('"probe"')) fake[pipe].emit("error", new Error("synthetic private detail"));
        else if (data.toString().includes('"cancel"')) fake.emit("close", 0);
      });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => fake.stdout.emit("data", Buffer.from('{"type":"ready","version":1}\n'))); return fake;
      });
      const session = await createNativeHistoryPresenceEndpoint(HELPER).open(root, 3000, new AbortController().signal);
      await expect(session.probe(["a"], new AbortController().signal)).rejects.toThrow("PRESENCE_PROCESS_FAILED");
      await session.close();
  });

});
