import { afterEach, expect, it, vi } from "vitest";
import { createPluginChannelService, type ChannelRunRequest } from "./channel-service";
import type { PluginManifestV1 } from "../../../shared/plugin-manifest";
import { PluginError } from "../../../shared/plugin-protocol";
const manifest = { id: "test.plugin", channels: [{ id: "inbox" }] } as PluginManifestV1;
const message = (text = "first") => ({ id: "inbox", message: { externalMessageId: text, chat: { type: "private", id: "user" }, sender: { id: "user" }, text, timestamp: 1 } });
function fixture() {
  const run = vi.fn(async (_request: ChannelRunRequest) => ({ reply: "answer" }));
  const call = vi.fn(async (_id: string, method: string) => method === "channel.send" ? { externalMessageId: "out" } : undefined);
  const recordRun = vi.fn(), recordSend = vi.fn();
  const redactOutbound = vi.fn((text: string) => text.replaceAll("sk-fixture-secret", "[secret]").replaceAll("C:\\Private\\secret.txt", "[path]"));
  const service = createPluginChannelService({ runner: { run }, tools: () => [], approveLocally: async () => false, recordSend, recordRun, redactOutbound });
  service.registerChannel(manifest, { id: "inbox" }, { call });
  return { service, run, call, recordRun, recordSend, redactOutbound };
}
afterEach(() => vi.useRealTimers());
it("redacts both model replies and explicit host sends before they cross the plugin boundary", async () => {
  const f = fixture(); await f.service.startPlugin(manifest.id);
  const raw = "key=sk-fixture-secret path=C:\\Private\\secret.txt";
  f.run.mockResolvedValue({ reply: raw });
  await f.service.deliver(manifest.id, message()); await f.service.whenIdle();
  await f.service.send(manifest.id, "inbox", { chat: { type: "private", id: "user" }, text: raw });
  const sent = f.call.mock.calls.filter(c => c[1] === "channel.send");
  expect(sent).toHaveLength(2);
  for (const call of sent) expect(call[2].message.text).toBe("key=[secret] path=[path]");
  expect(JSON.stringify(sent)).not.toContain("sk-fixture-secret"); expect(JSON.stringify(sent)).not.toContain("Private");
  expect(f.redactOutbound).toHaveBeenCalledTimes(2);
});
it("never posts an outbound message when the mandatory redactor fails", async () => {
  const f = fixture(); await f.service.startPlugin(manifest.id); f.redactOutbound.mockImplementation(() => { throw Error("redaction unavailable"); });
  await expect(f.service.send(manifest.id, "inbox", { chat: { type: "private", id: "u" }, text: "secret" })).rejects.toThrow("redaction unavailable");
  expect(f.call.mock.calls.filter(c => c[1] === "channel.send")).toEqual([]); expect(f.recordSend).not.toHaveBeenCalled();
});
it.each(["ERR_TIMEOUT", "ERR_CANCELLED", "ERR_UNAVAILABLE", "ERR_PERMISSION"] as const)("classifies %s only after posting and records a single send attempt", async code => {
  const f = fixture(); await f.service.startPlugin(manifest.id);
  f.call.mockImplementation(async (_id, _method, _params, options) => { options?.onPosted?.(); throw new PluginError(code, "synthetic"); });
  const sending = f.service.send(manifest.id, "inbox", { chat: { type: "private", id: "u" }, text: "hi" });
  if (code === "ERR_PERMISSION") { await expect(sending).rejects.toMatchObject({ code }); expect(f.recordSend).not.toHaveBeenCalled(); }
  else { await expect(sending).resolves.toMatchObject({ status: "unknown" }); expect(f.recordSend).toHaveBeenCalledTimes(1); }
  expect(f.call.mock.calls.filter(c => c[1] === "channel.send")).toHaveLength(1);
  expect(f.call.mock.calls.at(-1)![3]).toMatchObject({ timeoutMs: 30_000 });
});
it.each(["ERR_TIMEOUT", "ERR_CANCELLED", "ERR_UNAVAILABLE"] as const)("keeps pre-post %s rejection without unknown audit", async code => {
  const f = fixture(); await f.service.startPlugin(manifest.id);
  f.call.mockImplementation(async () => { throw new PluginError(code, "before post"); });
  await expect(f.service.send(manifest.id, "inbox", { chat: { type: "private", id: "u" }, text: "hi" })).rejects.toMatchObject({ code });
  expect(f.recordSend).not.toHaveBeenCalled(); expect(f.call.mock.calls.filter(c => c[1] === "channel.send")).toHaveLength(1);
});
it("accepts immediately and runs a thirty-second reply independently of the incoming request lifetime", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.service.startPlugin(manifest.id);
  f.run.mockImplementation(async request => { await new Promise(resolve => setTimeout(resolve, 30_000)); expect(request.signal.aborted).toBe(false); return { reply: "late" }; });
  const incoming = new AbortController(); let accepted = false;
  const admission = f.service.deliver(manifest.id, message(), incoming.signal).then(result => { accepted = result.accepted; });
  await vi.advanceTimersByTimeAsync(0); expect(accepted).toBe(true); await admission;
  incoming.abort(); await vi.advanceTimersByTimeAsync(10_000);
  expect(f.call.mock.calls.filter(c => c[1] === "channel.send")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(20_000); await f.service.whenIdle();
  expect(f.call.mock.calls.filter(c => c[1] === "channel.send")).toHaveLength(1);
});
it("runs the second conversation message only after the first reply is sent", async () => {
  const f = fixture(); await f.service.startPlugin(manifest.id); let finish!: (value: { reply: string }) => void;
  const order: string[] = [];
  f.run.mockImplementationOnce(request => { order.push("first run"); return new Promise(resolve => { finish = resolve; }); });
  f.run.mockImplementation(async () => { order.push("second run"); return { reply: "second" }; });
  f.call.mockImplementation(async (_id, method) => { if (method === "channel.send") { order.push("send"); return { externalMessageId: "out" }; } });
  await f.service.deliver(manifest.id, message()); await f.service.deliver(manifest.id, message("second"));
  expect(f.run).toHaveBeenCalledTimes(1); finish({ reply: "first" }); await f.service.whenIdle();
  expect(order).toEqual(["first run", "send", "second run", "send"]);
});
it("bounds each conversation at twenty admitted messages and discards queued messages on disable", async () => {
  const f = fixture(); await f.service.startPlugin(manifest.id);
  f.run.mockImplementation(() => new Promise(() => {}));
  for (let index = 0; index < 20; index++) await f.service.deliver(manifest.id, message(String(index)));
  await expect(f.service.deliver(manifest.id, message("overflow"))).rejects.toMatchObject({ code: "ERR_RATE_LIMITED" });
  expect(f.run).toHaveBeenCalledTimes(1);
  await f.service.stopPlugin(manifest.id); await f.service.whenIdle();
  expect(f.run).toHaveBeenCalledTimes(1); expect(f.call.mock.calls.filter(c => c[1] === "channel.send")).toHaveLength(0);
  expect(f.recordRun).toHaveBeenCalledTimes(20);
});
