import { expect, it } from "vitest";
import { createPluginIpcRouter } from "./ipc-router";

function routes() {
  const router = createPluginIpcRouter();
  router.register("plugin:catalog:status", () => ({ revision: 18 }));
  router.register("plugin:catalog:failure", () => { throw new Error("catalog unavailable"); });
  return router;
}
const request = (channel: string, pluginId = "catalog") => ({ pluginId, channel, args: [], caller: "panel" as const });

it("wraps successful values and normalizes handler exceptions", async () => {
  const router = routes();
  expect(await router.dispatch(request("status"))).toStrictEqual({ data: { revision: 18 }, ok: true });
  expect(await router.dispatch(request("failure"))).toStrictEqual({ error: "catalog unavailable", ok: false });
});

it("passes arguments to an asynchronous registered handler", async () => {
  const router = routes();
  router.register("plugin:catalog:sum", async (left: number, right: number) => left + right);
  expect(await router.dispatch({ ...request("sum"), args: [7, 12] })).toStrictEqual({ ok: true, data: 19 });
});

it("rejects unregistered channels and prevents another plugin from borrowing a route", async () => {
  const router = routes();
  const missing = await router.dispatch(request("unregistered"));
  expect(missing.ok).toEqual(false);
  expect(!missing.ok && missing.error).toContain("未注册");
  expect((await router.dispatch(request("status", "absent"))).ok).toEqual(false);
  expect((await router.dispatch(request("status", "other-catalog"))).ok).toEqual(false);
});

it.each(["Catalog", "ca_talog", "../escape", "catalog:other", ""])("rejects malformed plugin identifier %s", async pluginId => {
  expect((await routes().dispatch(request("status", pluginId))).ok).toEqual(false);
});

it.each(["route:other", "plugin:catalog:status", "../escape", "", "route name"])("rejects malformed channel segment %s", async channel => {
  expect((await routes().dispatch(request(channel))).ok).toEqual(false);
});

it("invalidates both direct invocation and panel dispatch when a channel is removed", async () => {
  const router = routes();
  router.unregister("plugin:catalog:status");
  expect(() => router.invokeRegistered("plugin:catalog:status", [])).toThrow(/未注册/);
  expect((await router.dispatch(request("status"))).ok).toEqual(false);
});

it("rejects a duplicate registration while retaining the first direct handler", () => {
  const router = createPluginIpcRouter();
  router.register("plugin:catalog:value", () => 19);
  expect(() => router.register("plugin:catalog:value", () => 20)).toThrow(/已注册/);
  expect(router.invokeRegistered("plugin:catalog:value", [])).toEqual(19);
});
