import { describe, expect, it } from "vitest";
import { bootstrapReactSession, openSessionByIdWithDeps } from "./openSessionByDeps";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("external session opens racing newer selections", () => {
  it("drops the first delayed read after a newer sidebar selection", async () => {
    let current = true;
    let selections = 0;
    const read = deferred<{ mode: string }>();
    const pending = openSessionByIdWithDeps({
      sessionId: "old-work", isCurrent: () => current,
      getSession: () => read.promise,
      selectSession: async () => { selections++; return "selected" as const; },
    });
    current = false;
    read.resolve({ mode: "work" });
    expect(await pending).toEqual({ status: "stale" });
    expect(selections).toBe(0);
  });

  it("does not report opened when the second delayed read loses its selection generation", async () => {
    let current = true;
    const selection = deferred<"stale">();
    const started = deferred<void>();
    const pending = openSessionByIdWithDeps({
      sessionId: "old-work", isCurrent: () => current,
      getSession: async () => ({ mode: "work" }),
      selectSession: () => { started.resolve(); return selection.promise; },
    });
    await started.promise;
    current = false;
    selection.resolve("stale");
    expect(await pending).toEqual({ status: "stale" });
  });

  it("reports unavailable when the session disappears between its two reads", async () => {
    const sessions = new Map([["work-1", { mode: "work" }]]);
    const selection = deferred<void>();
    const started = deferred<void>();
    const pending = openSessionByIdWithDeps({
      sessionId: "work-1", isCurrent: () => true,
      getSession: async id => sessions.get(id) ?? null,
      selectSession: async id => { started.resolve(); await selection.promise; return sessions.has(id) ? "selected" : "unavailable"; },
    });
    await started.promise;
    sessions.delete("work-1");
    selection.resolve();
    expect(await pending).toEqual({ status: "unavailable" });
  });

  it("drops a late read failure rather than refreshing a newer selection", async () => {
    let current = true;
    const read = deferred<{ mode: string }>();
    const pending = openSessionByIdWithDeps({
      sessionId: "old-work", isCurrent: () => current,
      getSession: () => read.promise,
      selectSession: async () => "selected" as const,
    });
    current = false;
    read.reject(new Error("obsolete read failed"));
    await expect(pending).resolves.toEqual({ status: "stale" });
  });

  it("does not bootstrap-refresh or select over a newer user choice after a stale open", async () => {
    const refreshes: unknown[] = [];
    await bootstrapReactSession({
      urlSessionId: "old-work", currentMode: "chat",
      openSession: async () => ({ status: "stale" }),
      refreshSessions: async (...args) => { refreshes.push(args); },
    });
    expect(refreshes).toEqual([]);
  });
});
