import { afterEach, it, expect, vi } from "vitest";
import { createPluginResourceTracker } from "./resources";
afterEach(() => vi.useRealTimers());

it("releases all remaining resources in reverse registration order", async () => {
  const tracker = createPluginResourceTracker();
  const trace: number[] = [];
  tracker.track("tool", "lookup", () => { trace.push(10); });
  tracker.track("ipc", "query", () => { trace.push(20); });
  tracker.track("onDispose", "shutdown", () => { trace.push(30); });
  await tracker.dispose();
  expect(trace).toStrictEqual([30, 20, 10]);
});

it("shares the same disposal promise and invokes a cleanup only once", async () => {
  const tracker = createPluginResourceTracker();
  const cleanup = vi.fn();
  tracker.track("tool", "lookup", cleanup);
  const original = tracker.dispose();
  expect(tracker.dispose()).toBe(original);
  await original;
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("releases a manually removed resource once and reports subsequent release as false", async () => {
  const tracker = createPluginResourceTracker();
  const cleanup = vi.fn();
  tracker.track("tool", "lookup", cleanup);
  expect(await tracker.release("tool", "lookup")).toEqual(true);
  expect(await tracker.release("tool", "lookup")).toEqual(false);
  await tracker.dispose();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("forgets a resource without invoking its cleanup", async () => {
  const tracker = createPluginResourceTracker();
  const cleanup = vi.fn();
  tracker.track("ipc", "query", cleanup);
  expect(tracker.forget("ipc", "query")).toEqual(true);
  expect(tracker.forget("ipc", "query")).toEqual(false);
  await tracker.dispose();
  expect(cleanup).not.toHaveBeenCalled();
});

it("reports a cleanup timeout and continues releasing later resources", async () => {
  vi.useFakeTimers();
  const errors = vi.fn();
  const tracker = createPluginResourceTracker(errors);
  const trace: string[] = [];
  tracker.track("tool", "earliest", () => { trace.push("earliest"); });
  tracker.track("onDispose", "blocked", () => { trace.push("blocked"); return new Promise<void>(() => {}); });
  tracker.track("ipc", "query", () => { trace.push("query"); });
  tracker.track("tool", "latest", () => { trace.push("latest"); });
  const completed = tracker.dispose();
  await vi.advanceTimersByTimeAsync(6000);
  await completed;
  expect(trace).toStrictEqual(["latest", "query", "blocked", "earliest"]);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(String(errors.mock.calls[0][2])).toContain("清理超时");
});

it("reports a throwing cleanup without abandoning the remaining callbacks", async () => {
  const errors = vi.fn();
  const tracker = createPluginResourceTracker(errors);
  const trace: string[] = [];
  tracker.track("tool", "early", () => { trace.push("early"); });
  tracker.track("ipc", "failing", () => { trace.push("failing"); throw new Error("resource offline"); });
  tracker.track("onDispose", "late", () => { trace.push("late"); });
  await tracker.dispose();
  expect(trace).toStrictEqual(["late", "failing", "early"]);
  expect(errors).toHaveBeenCalledTimes(1);
});

it("rejects registration after stop and duplicate kind/key pairs", async () => {
  const tracker = createPluginResourceTracker();
  tracker.track("tool", "lookup", () => {});
  expect(() => tracker.track("tool", "lookup", () => {})).toThrow(/已登记/);
  await tracker.dispose();
  expect(() => tracker.track("tool", "another", () => {})).toThrow(/停止后/);
});
