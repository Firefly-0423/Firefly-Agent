import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import * as path from "node:path";
import { createGitWorkspaceWatcher, createNativeRecursiveWatcher, type NativeEventEvidence } from "./git-workspace-watcher";

const native = vi.hoisted(() => ({ listener: undefined as undefined | ((event: string, filename: string | Buffer | null) => void), close: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: Object.assign((value: string) => value, { native: (value: string) => value }),
    watch: vi.fn((_root, _options, listener) => {
      native.listener = listener;
      return { once: vi.fn(), close: native.close };
    }),
  };
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("native watcher provenance with a synthetic native event source", () => {
  it("preserves classification and exact debounce chains without suppressing unknown events", async () => {
    vi.useFakeTimers();
    const records: NativeEventEvidence[] = [];
    onTestFailed(() => console.error("[watcher-failure-provenance]", JSON.stringify(records, null, 2)));
    let phase = "objects";
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({
      createWatcher: createNativeRecursiveWatcher,
      onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80,
      diagnostics: { phase: () => phase, record: (event) => records.push(event) },
    });
    const root = path.resolve("synthetic-workspace");
    try {
      await watcher.subscribe({ sessionId: "test", workspaceRoot: root, gitDir: path.join(root, ".git") });
      native.listener!("change", ".git/objects/aa/hash");
      await vi.advanceTimersByTimeAsync(80);
      expect(changed).not.toHaveBeenCalled();
      expect(records).toContainEqual(expect.objectContaining({ stage: "native", phase, classification: "IGNORED", ignored: true }));
      phase = "source";
      native.listener!("rename", "a.ts");
      native.listener!("change", "a.ts");
      await vi.advanceTimersByTimeAsync(79);
      expect(changed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(records.filter((event) => event.stage === "fire").map((event) => [event.filename, event.fireId])).toEqual([["a.ts", 1], ["a.ts", 1]]);
      phase = "unknown";
      native.listener!("change", null);
      await vi.advanceTimersByTimeAsync(80);
      expect(changed).toHaveBeenCalledTimes(2);
      const unknown = records.filter((event) => event.filename === null);
      expect(unknown.map((event) => event.stage)).toEqual(["native", "schedule", "fire"]);
      expect(unknown[2]).toMatchObject({ classification: "UNCLASSIFIED", ignored: null, candidate: null, scheduleId: 3, fireId: 2, phase });
      expect(new Set(unknown.map((event) => event.sequence)).size).toBe(1);
      expect(records.filter((event) => event.stage === "schedule").map((event) => event.scheduleId)).toEqual([1, 2, 3]);
      expect(records.filter((event) => event.classification === "IGNORED").every((event) => event.stage === "native")).toBe(true);
      native.listener!("change", "later.ts");
      await vi.advanceTimersByTimeAsync(80);
      expect(changed).toHaveBeenCalledTimes(3);
      expect(records.at(-1)).toMatchObject({ stage: "fire", filename: "later.ts", fireId: 3 });
    } finally { await watcher.dispose(); }
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it("records Buffer fallback and cancels a pending fire on dispose", async () => {
    vi.useFakeTimers();
    const records: NativeEventEvidence[] = [];
    onTestFailed(() => console.error("[watcher-failure-provenance]", JSON.stringify(records, null, 2)));
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({
      createWatcher: createNativeRecursiveWatcher, onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80,
      diagnostics: { phase: () => "buffer", record: (event) => records.push(event) },
    });
    try {
      const root = path.resolve("synthetic-workspace");
      await watcher.subscribe({ sessionId: "test", workspaceRoot: root, gitDir: path.join(root, ".git") });
      native.listener!("change", Buffer.from(".git/objects/hash"));
      await vi.advanceTimersByTimeAsync(80);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(records.at(-1)).toMatchObject({ stage: "fire", filenameType: "buffer", classification: "UNCLASSIFIED", candidate: null, ignored: null });
      native.listener!("change", "pending.ts");
      await watcher.dispose();
      await vi.advanceTimersByTimeAsync(80);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(records.filter((event) => event.filename === "pending.ts").map((event) => event.stage)).toEqual(["native", "schedule"]);
    } finally { await watcher.dispose(); }
  });

  it("keeps diagnostic collection off by default without changing fallback behavior", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FIREFLY_VITEST_DIAGNOSTICS", "");
    const info = vi.spyOn(console, "info");
    const factory = vi.fn(createNativeRecursiveWatcher);
    const changed = vi.fn();
    const watcher = createGitWorkspaceWatcher({ createWatcher: factory, onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });
    try {
      const root = path.resolve("synthetic-workspace");
      await watcher.subscribe({ sessionId: "test", workspaceRoot: root, gitDir: path.join(root, ".git") });
      expect(factory.mock.calls[0][2]).toBeUndefined();
      native.listener!("change", null);
      await vi.advanceTimersByTimeAsync(80);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(info).not.toHaveBeenCalled();
    } finally { await watcher.dispose(); }
  });
});
