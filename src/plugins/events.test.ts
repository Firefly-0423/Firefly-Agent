import { afterEach, it, expect, vi } from "vitest";
import { createPluginEventBus, PLUGIN_EVENT_LISTENER_TIMEOUT_MS } from "./events";
afterEach(() => vi.useRealTimers());

it("defers ordinary event delivery beyond the current call stack", async () => {
  const bus = createPluginEventBus();
  const trace: number[] = [];
  bus.on("host:chat:message", () => { trace.push(7); });
  const delivery = bus.emit("host:chat:message", { text: "Review available" });
  expect(trace).toStrictEqual([]);
  await delivery;
  expect(trace).toStrictEqual([7]);
});

it("isolates synchronous listener errors while preserving subscription order", async () => {
  const errors = vi.fn();
  const bus = createPluginEventBus(errors);
  const trace: number[] = [];
  bus.on("host:chat:message", () => { trace.push(10); });
  bus.on("host:chat:message", () => { throw new Error("subscriber unavailable"); });
  bus.on("host:chat:message", () => { trace.push(30); });
  await bus.emit("host:chat:message", { text: "Review available" });
  expect(trace).toStrictEqual([10, 30]);
  expect(errors.mock.calls).toStrictEqual([["host:chat:message", expect.any(Error)]]);
});

it("resolves ordinary publication without waiting for asynchronous listeners", async () => {
  const bus = createPluginEventBus();
  let release!: () => void;
  let published = false;
  bus.on("host:chat:message", () => new Promise<void>(resolve => { release = resolve; }));
  const delivery = bus.emit("host:chat:message", undefined).then(() => { published = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(published).toEqual(true);
  release();
  await delivery;
});

it("reports asynchronous rejection after ordinary event delivery", async () => {
  const errors = vi.fn();
  const bus = createPluginEventBus(errors);
  bus.on("host:chat:message", async () => { throw new Error("subscriber rejected payload"); });
  await bus.emit("host:chat:message", undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(errors.mock.calls).toStrictEqual([["host:chat:message", expect.objectContaining({ message: "subscriber rejected payload" })]]);
});

it("takes a stable listener snapshot and makes cancellation idempotent", async () => {
  const bus = createPluginEventBus();
  const first = vi.fn();
  const second = vi.fn();
  let cancelSecond = () => {};
  bus.on("host:runtime:ready", () => { first(); cancelSecond(); });
  cancelSecond = bus.on("host:runtime:ready", second);
  await bus.emit("host:runtime:ready", undefined);
  cancelSecond();
  await bus.emit("host:runtime:ready", undefined);
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(1);
});

it("awaits lifecycle listeners sequentially and continues after a thrown error", async () => {
  const errors = vi.fn();
  const bus = createPluginEventBus(errors);
  const trace: number[] = [];
  bus.on("host:plugins:ready", async () => { await Promise.resolve(); trace.push(10); });
  bus.on("host:plugins:ready", () => { throw new Error("lifecycle unavailable"); });
  bus.on("host:plugins:ready", () => { trace.push(30); });
  await bus.emitLifecycleBarrier("host:plugins:ready", undefined);
  expect(trace).toStrictEqual([10, 30]);
  expect(errors.mock.calls).toStrictEqual([["host:plugins:ready", expect.any(Error)]]);
});

it.each(["ordinary", "barrier"] as const)("reports %s listener timeouts while allowing the following listener", async mode => {
  vi.useFakeTimers();
  const errors = vi.fn();
  const bus = createPluginEventBus(errors);
  const continuation = vi.fn();
  const name = mode === "barrier" ? "host:plugins:stopping" : "host:runtime:ready";
  bus.on(name, () => new Promise<void>(() => {}));
  bus.on(name, continuation);
  const delivery = mode === "barrier" ? bus.emitLifecycleBarrier(name, undefined) : bus.emit(name, undefined);
  await vi.advanceTimersByTimeAsync(PLUGIN_EVENT_LISTENER_TIMEOUT_MS);
  await delivery;
  expect(continuation).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls).toStrictEqual([[name, expect.objectContaining({
    message: expect.stringContaining(mode === "barrier" ? "执行超时" : "异步执行超时"),
  })]]);
});

it("validates namespaces and event segments on both subscription and publishing paths", async () => {
  const bus = createPluginEventBus();
  expect(() => bus.on("unqualified", () => {})).toThrow(/事件名/);
  expect(() => bus.on("host:invalid name", () => {})).toThrow(/事件名/);
  expect(() => bus.on("plugin:catalog", () => {})).toThrow(/插件 id/);
  await expect(bus.emit("foreign:event", undefined)).rejects.toThrow(/命名空间/);
  await expect(bus.emitLifecycleBarrier("foreign:event", undefined)).rejects.toThrow(/命名空间/);
});
