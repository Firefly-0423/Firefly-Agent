import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  selectCachedHistoryCoverage, measureHistoryPresence,
  type PresenceEndpoint, type CoverageSelection,
} from "./native-history-coverage";

const main = vi.hoisted(() => ({
  context: { dataRoot: "E:\\synthetic-profile" },
  cache: { state: "ready", rootDir: "E:\\synthetic-profile\\firefly-chats", ids: [] } as Record<string, unknown>,
}));
vi.mock("../storage-context", () => ({ getStorageContext: () => main.context }));
vi.mock("../chats/chats-store", () => ({ getCachedSessionIdsForCoverage: () => main.cache }));

function endpoint(statuses: unknown[] = []): PresenceEndpoint & { batches: string[][]; closed: number } {
  const state = { batches: [] as string[][], closed: 0 };
  return Object.assign(state, {
    async open(root: string) {
      expect(root).toBe(main.context.dataRoot);
      return {
        async probe(ids: readonly string[]) {
          state.batches.push([...ids]);
          return statuses.length ? statuses : ids.map(() => ({ status: "present" }));
        },
        close() { state.closed++; },
      };
    },
  });
}
beforeEach(() => {
  main.context = { dataRoot: "E:\\synthetic-profile" };
  main.cache = { state: "ready", rootDir: path.join(main.context.dataRoot, "firefly-chats"), ids: [] };
});
describe("metadata presence census", () => {
  it("reports cold and unreadable caches as not measured without opening an endpoint", async () => {
    const open = vi.fn();
    for (const state of ["not-ready", "read-failed", "budget-exhausted"]) {
      main.cache = { state, ids: null };
      const result = await measureHistoryPresence(selectCachedHistoryCoverage(), { open });
      expect(result.status).toBe("not-measured");
      expect(result.population).toBeNull();
      expect(result.present).toBeNull();
      expect(result.evidence.unknown).toBeNull();
    }
    expect(open).not.toHaveBeenCalled();
  });
  it("counts unknown separately and refuses to call presence effective evidence", async () => {
    main.cache.ids = ["a", "b", "c"];
    const api = endpoint([{ status: "present" }, { status: "missing", component: "snapshot" }, { status: "unknown-denied", reason: "history-native-open-failed" }]);
    const result = await measureHistoryPresence(selectCachedHistoryCoverage(), api);
    expect(result).toMatchObject({ status: "measured", population: 3, present: 1, missing: 1, unknownDenied: 1,
      exactRatio: null, lowerRatio: 1 / 3, upperRatio: 2 / 3,
      evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: 3, ratio: null } });
    expect(api.closed).toBe(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-profile");
  });
  it("handles genuine empty population without launching a child", async () => {
    const api = endpoint();
    expect(await measureHistoryPresence(selectCachedHistoryCoverage(), api)).toMatchObject({
      status: "measured", population: 0, present: 0, missing: 0, unknownDenied: 0, exactRatio: null,
    });
    expect(api.batches).toEqual([]);
  });
  it("rejects forged selections and a cache belonging to another profile", async () => {
    const api = endpoint();
    expect((await measureHistoryPresence({} as CoverageSelection, api)).status).toBe("not-measured");
    main.cache.rootDir = "E:\\another-profile\\firefly-chats";
    expect((await measureHistoryPresence(selectCachedHistoryCoverage(), api)).status).toBe("not-measured");
    expect(api.batches).toEqual([]);
  });
  it("freezes the population, deduplicates exact IDs, and leaves aliases and invalid IDs unknown", async () => {
    main.cache.ids = ["valid", "valid", "Case", "case", "../escape", "NUL", "trail."];
    const selected = selectCachedHistoryCoverage();
    main.cache.ids = ["later"];
    const api = endpoint();
    expect(await measureHistoryPresence(selected, api)).toMatchObject({ population: 6, present: 1, unknownDenied: 5, missing: 0 });
    expect(api.batches).toEqual([["valid"]]);
  });
  it("consumes each selection once", async () => {
    main.cache.ids = ["valid"];
    const selected = selectCachedHistoryCoverage();
    const api = endpoint();
    expect((await measureHistoryPresence(selected, api)).status).toBe("measured");
    expect((await measureHistoryPresence(selected, api)).status).toBe("not-measured");
    expect(api.batches).toEqual([["valid"]]);
  });
  it("uses batches of at most 32 without filesystem access", async () => {
    main.cache.ids = Array.from({ length: 65 }, (_, i) => String(i));
    const selected = selectCachedHistoryCoverage();
    const api = endpoint();
    const spies = ["readFileSync", "writeFileSync", "readdirSync", "mkdirSync", "statSync"].map((name) => vi.spyOn(fs, name as "readFileSync"));
    try {
      expect(await measureHistoryPresence(selected, api)).toMatchObject({ population: 65, present: 65, missing: 0, unknownDenied: 0, exactRatio: 1 });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
    expect(api.batches.map((batch) => batch.length)).toEqual([32, 32, 1]);
  });
  it("does not count malformed native replies as missing", async () => {
    main.cache.ids = ["a", "b"];
    for (const statuses of [[{ status: "missing", component: "arbitrary" }], [{ status: "present", bytes: "forbidden" }, { status: "present" }]]) {
      expect(await measureHistoryPresence(selectCachedHistoryCoverage(), endpoint(statuses))).toMatchObject({ present: 0, missing: 0, unknownDenied: 2 });
    }
  });
  it("keeps the denominator when the native endpoint cannot open", async () => {
    main.cache.ids = ["a", "b"];
    const api = { async open() { throw new Error("denied"); } };
    expect(await measureHistoryPresence(selectCachedHistoryCoverage(), api)).toMatchObject({ population: 2, present: 0, missing: 0, unknownDenied: 2 });
  });
  it("discards results on cancellation or profile replacement and closes the exact session", async () => {
    for (const cause of ["cancel", "profile"]) {
      main.cache.ids = ["a"];
      const selected = selectCachedHistoryCoverage();
      const controller = new AbortController();
      let finish!: (value: unknown) => void;
      let closeCount = 0;
      let started!: () => void;
      const probing = new Promise<void>((resolve) => { started = resolve; });
      const api: PresenceEndpoint = { async open() { return {
        probe: () => new Promise((resolve) => { finish = resolve; started(); }), close() { closeCount++; },
      }; } };
      const pending = measureHistoryPresence(selected, api, { signal: controller.signal });
      await probing;
      if (cause === "cancel") controller.abort(); else main.context = { ...main.context };
      finish([{ status: "present" }]);
      expect((await pending).status).toBe("not-measured");
      expect(closeCount).toBe(1);
    }
  });
  it("bounds a blocked child by a single total deadline", async () => {
    vi.useFakeTimers();
    try {
      main.cache.ids = ["a", "b"];
      let closed = 0;
      const api: PresenceEndpoint = { async open() { return { probe: () => new Promise(() => {}), close() { closed++; } }; } };
      const pending = measureHistoryPresence(selectCachedHistoryCoverage(), api);
      await vi.advanceTimersByTimeAsync(30000);
      expect(await pending).toMatchObject({ population: 2, unknownDenied: 2, present: 0, missing: 0 });
      expect(closed).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it("uses the remaining total deadline across batches and retains unprocessed candidates", async () => {
    vi.useFakeTimers();
    try {
      main.cache.ids = Array.from({ length: 33 }, (_, i) => String(i));
      let calls = 0;
      const api: PresenceEndpoint = { async open() { return {
        probe(ids) { calls++; return new Promise((resolve) => setTimeout(() => resolve(ids.map(() => ({ status: "present" }))), 20000)); },
        close() {},
      }; } };
      const pending = measureHistoryPresence(selectCachedHistoryCoverage(), api);
      await vi.advanceTimersByTimeAsync(30000);
      expect(await pending).toMatchObject({ population: 33, present: 32, unknownDenied: 1, exactRatio: null });
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it("closes a late open after cancellation without probing it", async () => {
    main.cache.ids = ["a"];
    const controller = new AbortController();
    let finish!: (session: Awaited<ReturnType<PresenceEndpoint["open"]>>) => void;
    let closed = 0; let probes = 0;
    const pending = measureHistoryPresence(selectCachedHistoryCoverage(), {
      open: () => new Promise((resolve) => { finish = resolve; }),
    }, { signal: controller.signal });
    controller.abort();
    expect((await pending).status).toBe("not-measured");
    finish({ async probe() { probes++; return []; }, close() { closed++; } });
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(1); expect(probes).toBe(0);
  });

  it("does not report success when the exact endpoint fails to close", async () => {
    main.cache.ids = ["a"];
    const api: PresenceEndpoint = { async open() { return {
      async probe() { return [{ status: "present" }]; }, close() { throw new Error("close failed"); },
    }; } };
    expect(await measureHistoryPresence(selectCachedHistoryCoverage(), api)).toMatchObject({ status: "not-measured", reason: "cleanup-failed", present: null });
  });
  it("rejects a late reply even if a stalled timer has not fired", async () => {
    main.cache.ids = ["a"];
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const api: PresenceEndpoint = { async open() { return {
      async probe() { clock = 30001; return [{ status: "present" }]; }, close() {},
    }; } };
    try {
      expect(await measureHistoryPresence(selectCachedHistoryCoverage(), api)).toMatchObject({ population: 1, present: 0, missing: 0, unknownDenied: 1, reasons: { deadline: 1 } });
    } finally { now.mockRestore(); }
  });

  it("awaits async child-exit confirmation and rejects async close failure", async () => {
    main.cache.ids = ["a"];
    let closed = false;
    const api: PresenceEndpoint = { async open() { return {
      async probe() { return [{ status: "present" }]; },
      async close() { await Promise.resolve(); closed = true; throw new Error("exit failed"); },
    }; } };
    expect(await measureHistoryPresence(selectCachedHistoryCoverage(), api)).toMatchObject({ status: "not-measured", reason: "cleanup-failed" });
    expect(closed).toBe(true);
  });
  it("bounds a nonsettling child close and refuses a success report", async () => {
    vi.useFakeTimers();
    try {
      main.cache.ids = ["a"];
      const api: PresenceEndpoint = { async open() { return {
        async probe() { return [{ status: "present" }]; }, close: () => new Promise(() => {}),
      }; } };
      const pending = measureHistoryPresence(selectCachedHistoryCoverage(), api);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ status: "not-measured", reason: "cleanup-failed" });
    } finally { vi.useRealTimers(); }
  });

});
