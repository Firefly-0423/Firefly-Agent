import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const fixture = vi.hoisted(() => ({ directory: "", test: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.directory, getAppPath: () => fixture.directory }, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock("../env", () => ({ isDev: false }));
vi.mock("../orchestrator/vendors/test-connection", () => ({ testVendorConnection: fixture.test }));
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  fixture.test.mockReset().mockResolvedValue({ ok: true, latency: 3, sample: "fixture answer" });
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-connection-"));
});
afterEach(() => { dispose?.(); dispose = undefined; fs.rmSync(fixture.directory, { recursive: true, force: true }); });
const config = { provider: "fixture", baseUrl: "https://fixture.invalid/v1", model: "fixture-model", apiKey: "fixture-secret", explicitTransport: "openai" as const, reasoning: { mode: "off" as const } };
function deferred() { let resolve!: (value: { ok: boolean; latency: number; error?: string }) => void; let reject!: (error: Error) => void; const promise = new Promise<{ ok: boolean; latency: number; error?: string }>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function setup(profiles = [{ id: "p1", ...config }]) {
  const model = await import("./model-settings");
  model.saveModelSettings({ modelProfiles: profiles, defaultModelProfileId: "p1" });
  const windows = await import("../windows/window-state");
  const mainFrame = { url: pathToFileURL(path.join(fixture.directory, "dist", "renderer", "settings", "index.html")).href + "#api" };
  const contents = { mainFrame, send: vi.fn(), isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  windows.setSettingsWindow(window as never);
  const handlers = new Map<string, (...args: any[]) => any>();
  const events = new Map<string, (...args: any[]) => any>();
  const createSidebarWindow = vi.fn();
  const { registerSettingsIpc } = await import("./settings-ipc");
  dispose = registerSettingsIpc({
    ipc: { handle: (channel: string, callback: (...args: any[]) => any) => handlers.set(channel, callback), on: (channel: string, callback: (...args: any[]) => any) => events.set(channel, callback) },
    getModelSettings: model.loadModelSettings, saveModelSettings: model.saveModelSettings,
    windowManager: { createSidebarWindow },
  } as never) as unknown as (() => void) | undefined;
  const trusted = { sender: contents, senderFrame: mainFrame };
  return { model, contents, window, trusted, handlers, events, createSidebarWindow,
    snapshot: () => handlers.get("model-connection:get")?.(trusted),
    test: (input: unknown = config, event: unknown = trusted) => Promise.resolve().then(() => handlers.get(IPC.SETTINGS_TEST_CONNECTION)!(event, input)),
  };
}
it("saved credentials remain unverified and reads never send a request", async () => {
  const h = await setup();
  expect(h.model.getPublicModelConfig().connected).toBe(false);
  expect(h.snapshot()).toMatchObject({ defaultProfileId: "p1", profiles: [{ profileId: "p1", state: "unverified" }] });
  expect(fixture.test).not.toHaveBeenCalled();
});
it("explicit trusted testing publishes checking then a redacted verified snapshot", async () => {
  const pending = deferred(); fixture.test.mockReturnValue(pending.promise);
  const h = await setup(); const request = h.test(); await Promise.resolve();
  expect(h.snapshot().profiles[0].state).toBe("checking");
  pending.resolve({ ok: true, latency: 3 }); await request;
  expect(h.snapshot().profiles[0]).toMatchObject({ state: "connected", checkedAt: expect.any(Number) });
  expect(h.model.getPublicModelConfig().connected).toBe(true);
  expect(h.contents.send.mock.calls.some(([channel]) => channel === "model-connection:changed")).toBe(true);
  expect(JSON.stringify(h.snapshot())).not.toMatch(/fixture-secret|fixture.invalid|apiKey|baseUrl|sample|fingerprint/);
  const returned = h.snapshot(); returned.profiles[0].state = "failed";
  expect(h.snapshot().profiles[0].state).toBe("connected");
});
it.each(["sender", "subframe", "url", "destroyed"])("rejects an untrusted %s before network", async (kind) => {
  const h = await setup(); let event: any = h.trusted;
  if (kind === "sender") event = { ...event, sender: {} };
  if (kind === "subframe") event = { ...event, senderFrame: { url: h.trusted.senderFrame.url } };
  if (kind === "url") h.trusted.senderFrame.url = "https://fixture.invalid/";
  if (kind === "destroyed") h.window.isDestroyed = () => true;
  await expect(h.test(config, event)).rejects.toThrow("MODEL_CONNECTION_FORBIDDEN");
  expect(fixture.test).not.toHaveBeenCalled();
});
it.each([null, {}, { ...config, explicitTransport: "wrong" }, { ...config, reasoning: { mode: "wrong" } }])("rejects malformed request %# before network", async (input) => {
  const h = await setup(); await expect(h.test(input)).rejects.toThrow("MODEL_CONNECTION_INVALID_CONFIG");
  expect(fixture.test).not.toHaveBeenCalled();
});
it.each(["provider", "baseUrl", "model", "apiKey", "explicitTransport", "reasoning"])("invalidates a successful result on saved %s edit", async (field) => {
  const h = await setup(); await h.test(); const revision = h.snapshot().profiles[0].revision;
  const change = field === "reasoning" ? { mode: "on", effort: "high" } : field === "explicitTransport" ? "responses" : "changed-fixture";
  h.model.saveModelSettings({ modelProfiles: [{ id: "p1", ...config, [field]: change }] } as never);
  expect(h.snapshot().profiles[0]).toMatchObject({ state: "unverified", revision: expect.any(Number) });
  expect(h.snapshot().profiles[0].revision).toBeGreaterThan(revision);
  expect(h.model.getPublicModelConfig().connected).toBe(false);
});
it("does not revive an old result after config ABA or delete/recreate", async () => {
  for (const remove of [false, true]) {
    const h = await setup(); const pending = deferred(); fixture.test.mockReturnValueOnce(pending.promise);
    const request = h.test(); await Promise.resolve(); const revision = h.snapshot().profiles[0].revision;
    h.model.saveModelSettings({ modelProfiles: remove ? [] : [{ id: "p1", ...config, apiKey: "fixture-second" }] });
    h.model.saveModelSettings({ modelProfiles: [{ id: "p1", ...config }] });
    pending.resolve({ ok: true, latency: 4 }); await request;
    expect(h.snapshot().profiles[0].state).toBe("unverified");
    expect(h.snapshot().profiles[0].revision).toBeGreaterThan(revision);
    dispose?.();
  }
});
it("last started request wins even when older success finishes last", async () => {
  const h = await setup(); const older = deferred(); const newer = deferred(); fixture.test.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const a = h.test(); const b = h.test(); await Promise.resolve();
  newer.resolve({ ok: false, latency: 2, error: "fixture-secret https://fixture.invalid private response" }); await b;
  older.resolve({ ok: true, latency: 5 }); await a;
  expect(h.snapshot().profiles[0]).toMatchObject({ state: "failed", reason: "test_failed" });
  expect(JSON.stringify(h.contents.send.mock.calls)).not.toMatch(/fixture-secret|fixture.invalid|private response/);
});
it("drafts saved after test start cannot be retroactively verified", async () => {
  const h = await setup(); const pending = deferred(); fixture.test.mockReturnValueOnce(pending.promise);
  const draft = { ...config, model: "draft" }; const request = h.test(draft); await Promise.resolve();
  h.model.saveModelSettings({ modelProfiles: [{ id: "p1", ...draft }] });
  pending.resolve({ ok: true, latency: 2 }); await request;
  expect(h.snapshot().profiles[0].state).toBe("unverified");
});
it("ambiguous saved credentials do not verify either profile", async () => {
  const h = await setup([{ id: "p1", ...config }, { id: "p2", ...config }]); await h.test();
  expect(h.snapshot().profiles.map((p: any) => p.state)).toEqual(["unverified", "unverified"]);
});
it("changing default preserves per-profile results and uses effective fallback", async () => {
  const h = await setup([{ id: "p1", ...config }, { id: "p2", ...config, model: "other" }]); await h.test();
  h.model.saveModelSettings({ defaultModelProfileId: "p2" }); expect(h.model.getPublicModelConfig().connected).toBe(false);
  h.model.saveModelSettings({ defaultModelProfileId: "missing" }); expect(h.snapshot().defaultProfileId).toBe("p1");
  expect(h.model.getPublicModelConfig().connected).toBe(true); expect(fixture.test).toHaveBeenCalledTimes(1);
});
it("redacts private exceptions and resets verification on process restart", async () => {
  const h = await setup(); fixture.test.mockRejectedValueOnce(new Error("fixture-secret https://fixture.invalid private response"));
  expect(await h.test()).toEqual({ ok: false, latency: expect.any(Number), error: "MODEL_CONNECTION_TEST_ERROR" });
  expect(h.snapshot().profiles[0]).toMatchObject({ state: "failed", reason: "test_error" });
  expect(JSON.stringify(h.snapshot())).not.toMatch(/fixture-secret|fixture.invalid|private response/);
  dispose?.(); vi.resetModules(); const fresh = await import("./model-settings");
  expect(fresh.getPublicModelConfig().connected).toBe(false);
});
it("takes an independent normalized snapshot before awaiting the adapter", async () => {
  const h = await setup(); const pending = deferred(); fixture.test.mockReturnValueOnce(pending.promise);
  const input = { ...config, model: " fixture-model ", reasoning: { mode: "off" } }; const request = h.test(input); await Promise.resolve();
  input.model = "mutated"; input.reasoning.mode = "on";
  expect(fixture.test.mock.calls[0][0]).toMatchObject({ model: "fixture-model", reasoning: { mode: "off" } });
  pending.resolve({ ok: true, latency: 1 }); await request; expect(h.snapshot().profiles[0].state).toBe("connected");
});
it("ignores preview invalidation, preserves names, and does not broadcast after disposal", async () => {
  const h = await setup(); await h.test(); const revision = h.snapshot().profiles[0].revision;
  h.model.getPublicModelConfig(h.model.normalizeModelSettings({ modelProfiles: [{ id: "p1", ...config, apiKey: "draft-key" }] }));
  expect(h.snapshot().profiles[0].state).toBe("connected");
  h.model.saveModelSettings({ modelProfiles: [{ id: "p1", ...config, displayName: "new name" }] });
  expect(h.snapshot().profiles[0].revision).toBe(revision);
  dispose?.(); h.contents.send.mockClear(); h.model.saveModelSettings({ modelProfiles: [] });
  expect(h.contents.send).not.toHaveBeenCalled();
});
it("accepts reordered reasoning fields and copies a normalized preference", async () => {
  const saved = { ...config, reasoning: { mode: "on" as const, effort: "high" as const } };
  const h = await setup([{ id: "p1", ...saved }] as never);
  await h.test({ ...saved, reasoning: { effort: "high", mode: "on" } });
  expect(h.snapshot().profiles[0].state).toBe("connected");
});
it("failed settings writes cannot invalidate verified state", async () => {
  const h = await setup(); await h.test(); const before = h.snapshot();
  const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("synthetic write failure"); });
  try { expect(() => h.model.saveModelSettings({ modelProfiles: [] })).toThrow("synthetic write failure"); } finally { write.mockRestore(); }
  expect(h.snapshot()).toEqual(before);
});
it("duplicate saved IDs cannot be promoted by one matching configuration", async () => {
  const h = await setup([{ id: "p1", ...config }, { id: "p1", ...config, model: "other" }]); await h.test();
  expect(h.snapshot().profiles.every((p: any) => p.state === "unverified")).toBe(true);
});
it("older failures leave the newer in-flight request checking", async () => {
  const h = await setup(); const older = deferred(); const newer = deferred(); fixture.test.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const a = h.test(); const b = h.test(); await Promise.resolve();
  older.reject(new Error("fixture-secret")); await a;
  expect(h.snapshot().profiles[0].state).toBe("checking");
  newer.resolve({ ok: true, latency: 1 }); await b; expect(h.snapshot().profiles[0].state).toBe("connected");
});
it("verifies the existing local endpoint auth sentinel through the explicit test", async () => {
  const local = { ...config, baseUrl: "http://127.0.0.1:12345/v1", apiKey: "__FIREFLY_LOCAL_NO_AUTH__" };
  const h = await setup([{ id: "p1", ...local }]);
  expect(await h.test(local)).toMatchObject({ ok: true });
  expect(h.snapshot().profiles[0].state).toBe("connected");
  expect(h.model.getPublicModelConfig().connected).toBe(true);
});