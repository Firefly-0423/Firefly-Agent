import { afterEach, expect, it, vi } from "vitest";
import { Resolver } from "node:dns/promises";
import { createTrustedBrowserResolver } from "./trusted-browser-resolver";
const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const config = { server: "192.168.31.1", port: 53 };
it("retains admission until BOTH native promises settle after cancellation, across bindings", async () => {
  const held = Array.from({ length: 32 }, () => deferred<string[]>());
  let index = 0;
  vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(() => Promise.reject(Object.assign(Error("synthetic early failure"), { code: "ENOTFOUND" })));
  vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(() => held[index++].promise);
  const cancel = vi.spyOn(Resolver.prototype, "cancel").mockImplementation(() => {}); // Model a native completion delayed after cancel.
  const first = createTrustedBrowserResolver(config, new AbortController().signal); dispose.push(first.dispose);
  const pending = Array.from({ length: 32 }, () => first.resolve("example.com").catch(error => error));
  first.dispose(); expect(cancel).toHaveBeenCalledTimes(32);
  const fresh = createTrustedBrowserResolver(config, new AbortController().signal); dispose.push(fresh.dispose);
  await expect(fresh.resolve("example.com")).rejects.toMatchObject({ code: "EBUSY" }); expect(index).toBe(32);
  held.forEach(entry => entry.resolve([])); expect((await Promise.all(pending)).every(error => error.code === "ECANCELLED")).toBe(true);
  vi.restoreAllMocks();
});
it("a synchronous second-family exception still awaits the already started native query", async () => {
  const first = deferred<string[]>(); dispose.push(() => first.resolve([]));
  vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(() => first.promise);
  vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(() => { throw Object.assign(Error("synthetic resolver failure"), { code: "EREFUSED" }); });
  const r = createTrustedBrowserResolver(config, new AbortController().signal); dispose.push(r.dispose);
  let settled = false; const pending = r.resolve("example.com").catch(error => error).finally(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  first.resolve([]); expect(await pending).toMatchObject({ code: "EREFUSED", message: "browser DNS unavailable" });
});
it("the owned 5s deadline cancels native work but retains all slots until real settlement", async () => {
  vi.useFakeTimers(); const held = Array.from({ length: 32 }, () => deferred<string[]>()); let index = 0;
  dispose.push(() => held.forEach(entry => entry.resolve([])));
  vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(() => Promise.resolve(["93.184.216.34"]));
  vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(() => held[index++].promise);
  const cancel = vi.spyOn(Resolver.prototype, "cancel").mockImplementation(() => {});
  const r = createTrustedBrowserResolver(config, new AbortController().signal); dispose.push(r.dispose);
  let settled = 0; const pending = Array.from({ length: 32 }, () => r.resolve("example.com").catch(error => error).finally(() => { settled++; }));
  await vi.advanceTimersByTimeAsync(5000); expect(cancel).toHaveBeenCalledTimes(32); expect(settled).toBe(0);
  await expect(r.resolve("example.com")).rejects.toMatchObject({ code: "EBUSY" }); expect(index).toBe(32);
  held.forEach(entry => entry.resolve([])); expect((await Promise.all(pending)).every(error => error.code === "ETIMEOUT")).toBe(true);
});
