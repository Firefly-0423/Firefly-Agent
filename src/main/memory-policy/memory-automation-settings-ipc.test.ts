import { expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as automation from "./memory-automation-settings-ipc";
import { IPC } from "../../shared/ipc-channels";

function fixture() {
  const frame = {}, sender = { mainFrame: frame, isDestroyed: () => false }, win = { webContents: sender, isDestroyed: () => false }, event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const state = { available: true, config: { revision: 0, language: false, responseStyle: false }, budget: { day: 0, requests: 0, units: 0, closed: false }, counts: { unsent: 0, "result-unknown": 0, "result-saved": 0, applied: 0, blocked: 0 } };
  const host = { state: vi.fn(async (_event: unknown) => structuredClone(state)), configure: vi.fn(async (_event: unknown, input: any) => { state.config = { revision: input.expectedRevision + 1, language: input.language, responseStyle: input.responseStyle }; return structuredClone(state); }) };
  expect(typeof automation.createMemoryAutomationSettingsIpc).toBe("function");
  const api = automation.createMemoryAutomationSettingsIpc({ getSettingsWindow: () => win, host }); return { event, win, state, host, api };
}
const input = { expectedRevision: 0, language: true, responseStyle: false };
it("defaults off and forwards only exact CAS switches from the authorized settings main frame", async () => {
  const f = fixture(); expect(await f.api.state(f.event)).toEqual(f.state); expect(await f.api.configure(f.event, input)).toMatchObject({ status: "updated", state: { config: { revision: 1, language: true, responseStyle: false } } }); expect(f.host.configure).toHaveBeenCalledWith(f.event, input);
});
it("rejects stale switches and forged authorization fields before any configuration write", async () => {
  const f = fixture(); expect(await f.api.configure(f.event, { ...input, expectedRevision: 2 })).toEqual({ status: "rejected", reason: "MEMORY_REVISION_CONFLICT" });
  for (const bad of [{ ...input, actorKey: "forged" }, { ...input, scope: "global" }, { ...input, confidence: 1 }, { ...input, sourceRef: {} }, { ...input, expectedRevision: -1 }, { ...input, language: 1 }, Object.defineProperty({ ...input }, "responseStyle", { enumerable: true, get() { throw Error("must not execute"); } })]) expect(await f.api.configure(f.event, bad)).toEqual({ status: "rejected", reason: "MEMORY_INPUT_INVALID" });
  expect(f.host.configure).not.toHaveBeenCalled();
});
it("rejects foreign/revoked frames and rechecks after waiting for host state", async () => {
  const f = fixture(); for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }, { ...f.event, senderFrame: null }]) { await expect(f.api.state(event as any)).rejects.toThrow("MEMORY_SETTINGS_FORBIDDEN"); expect(await f.api.configure(event as any, input)).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FORBIDDEN" }); }
  let release!: () => void; f.host.state.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.state; });
  const queued = f.api.configure(f.event, input); await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.win.webContents.mainFrame = {}; release();
  expect(await queued).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FORBIDDEN" }); expect(f.host.configure).not.toHaveBeenCalled();
});
it("strips private host metadata, fails closed on corrupt state and hides raw errors", async () => {
  const f = fixture(); f.host.state.mockResolvedValue({ ...f.state, privatePath: "/private", actor: "secret" } as any);
  expect(JSON.stringify(await f.api.state(f.event))).not.toMatch(/private|secret|actor/);
  f.host.state.mockResolvedValue({ ...f.state, config: { ...f.state.config, language: "yes" } } as any); expect(await f.api.state(f.event)).toMatchObject({ available: false });
  f.host.configure.mockRejectedValue(Error("PRIVATE_PROVIDER_KEY")); f.host.state.mockResolvedValue(f.state);
  expect(await f.api.configure(f.event, input)).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FAILED" });
});
it("registers only the two separate automation channels", () => {
  const f = fixture(), handlers = new Map<string, unknown>(); automation.registerMemoryAutomationSettingsIpc({ getSettingsWindow: () => f.win, host: f.host, ipc: { handle: (name: string, handler: unknown) => handlers.set(name, handler) } });
  expect([...handlers.keys()]).toEqual(["memory-automation:state", "memory-automation:configure"]); expect(IPC.MEMORY_AUTOMATION_STATE).toBe("memory-automation:state");
});
