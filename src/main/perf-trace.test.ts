import { afterEach, describe, expect, it, vi } from "vitest";
import { perf } from "./perf-trace";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("perf trace visibility", () => {
  it("keeps overlapping async turns and retained callbacks in their own scope", async () => {
    vi.stubEnv("FIREFLY_DEBUG_LOGS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const a = perf.withTurn(async trace => {
      trace.beginTurn("run-A");
      await gate;
      await perf.track("only-A", async () => {});
      return trace;
    });
    const b = perf.withTurn(trace => {
      trace.beginTurn("run-B");
      return trace;
    });
    // Returning an IPC-like ACK must not close the retained collector.
    expect(log.mock.calls.flat().join("\n")).not.toContain("TURN SUMMARY");
    await b.track("only-B", async () => { perf.begin("nested-B").end(); });
    release();
    const traceA = await a;
    log.mockClear();
    traceA.dump();
    const summaryA = log.mock.calls.flat().join("\n");
    expect(summaryA).toContain("run-A");
    expect(summaryA).toContain("only-A");
    expect(summaryA).not.toContain("only-B");
    log.mockClear();
    b.dump();
    const summaryB = log.mock.calls.flat().join("\n");
    expect(summaryB).toContain("run-B");
    expect(summaryB).toContain("nested-B");
    expect(summaryB).not.toContain("only-A");
    log.mockClear();
    b.dump();
    expect(log).not.toHaveBeenCalled();
  });

  it("restores nested scopes and records failed async phases without swallowing errors", async () => {
    vi.stubEnv("FIREFLY_DEBUG_LOGS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const failure = new Error("cancelled fixture");
    await perf.withTurn(async outer => {
      outer.beginTurn("outer");
      perf.withTurn(inner => {
        inner.beginTurn("inner");
        perf.begin("inner-only").end();
        inner.dump();
      });
      await expect(perf.track("failed-phase", async () => { throw failure; })).rejects.toBe(failure);
      const late = perf.begin("late");
      log.mockClear();
      outer.dump();
      expect(log.mock.calls.flat().join("\n")).toContain("failed-phase");
      expect(log.mock.calls.flat().join("\n")).not.toContain("inner-only");
      log.mockClear();
      late.end();
      expect(log).not.toHaveBeenCalled();
    });
  });

  it("does not put a previous turn's late phase into the next summary", () => {
    vi.stubEnv("FIREFLY_DEBUG_LOGS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    perf.beginTurn("A");
    const late = perf.begin("phase-A");
    perf.beginTurn("B");
    log.mockClear();
    late.end();
    perf.dump();
    expect(log.mock.calls.flat().join("\n")).not.toContain("phase-A");
  });

  it("records a phase only once when end is repeated", () => {
    vi.stubEnv("FIREFLY_DEBUG_LOGS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    perf.beginTurn("once");
    const timer = perf.begin("single-phase");
    timer.end();
    timer.end();
    log.mockClear();
    perf.dump();
    expect(log.mock.calls.flat().filter(line => String(line).includes("single-phase"))).toHaveLength(1);
  });

  it("hides performance timing by default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    perf.beginTurn("test");
    perf.mark("checkpoint");
    perf.dump();

    expect(log).not.toHaveBeenCalled();
  });

  it("restores performance timing when debug logging is enabled", () => {
    vi.stubEnv("FIREFLY_DEBUG_LOGS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    perf.beginTurn("test");
    perf.mark("checkpoint");
    perf.dump();

    expect(log.mock.calls.flat().join("\n")).toContain("[Perf]");
  });
});
