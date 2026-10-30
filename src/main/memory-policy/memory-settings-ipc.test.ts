import { describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { MemoryPanelState } from "../../shared/memory-panel-contracts";
import { createMemorySettingsIpc, registerMemorySettingsIpc, type MemorySettingsHost } from "./memory-settings-ipc";
import { IPC } from "../../shared/ipc-channels";

function fixture() {
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const state: MemoryPanelState = {
    facts: [], candidates: [{ reviewState: "ready", contentHash: "a".repeat(64), candidateId: "candidate-1", revision: 1, attribute: "preference", value: "tea", reason: "review", assertion: "我喜欢茶", sourceRef: { sourceId: "source-1", revision: 1 } }],
    coverage: { status: "not-measured", population: null, present: null, missing: null, unknownDenied: null, exactRatio: null, lowerRatio: null, upperRatio: null, reasons: {}, evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: null, ratio: null } },
    backendStatus: { available: true },
  };
  const actions: unknown[] = [];
  const host: MemorySettingsHost = {
    getState: async () => structuredClone(state),
    applyAction: async (_event, action) => { actions.push(action); state.candidates = []; return { status: "active", factId: "fact-1", factRevision: 1 }; },
    auditSource: async (_event, id) => ({ factId: id, revision: 1, status: "eligible", reason: "valid-support", sources: [] }),
  };
  const api = createMemorySettingsIpc({ getSettingsWindow: () => win, host });
  return { event, state, actions, host, api, win };
}
const confirm = { contentHash: "a".repeat(64), kind: "confirm", id: "candidate-1", expectedRevision: 1 };

const preload = vi.hoisted(() => ({ exposed: new Map<string, any>(), invoke: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => preload.exposed.set(name, value) },
  ipcRenderer: { invoke: preload.invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn(), off: vi.fn() }, webUtils: {} }));


describe("settings memory IPC trust boundary", () => {
  it.each(["", " \n\t", "safe-looking text"])("refuses unresolved or blank candidates before forwarding: %j", async assertion => {
    const f = fixture();
    Object.assign(f.state.candidates[0], { assertion, reviewState: assertion.trim() ? "reference-only" : "ready", contentHash: "a".repeat(64) });
    expect(await f.api.applyMemoryPanelAction(f.event, { ...confirm, contentHash: "a".repeat(64) })).toEqual({ status: "rejected", reason: "MEMORY_POLICY_UNRESOLVED" });
    expect(f.actions).toEqual([]);
  });
  it.each(["", " \n\t", "safe-looking text"])("leaves candidates with nothing to confirm out of the panel: %j", async assertion => {
    const f = fixture(), empty = { ...f.state.candidates[0], candidateId: "candidate-empty", assertion, reviewState: assertion.trim() ? "reference-only" as const : "ready" as const };
    f.state.candidates.push(empty);
    expect((await f.api.getMemoryPanelState(f.event)).candidates.map(item => item.candidateId)).toEqual(["candidate-1"]);
  });
  it("requires the hash displayed to the user even when a candidate revision is current", async () => {
    const f = fixture(); Object.assign(f.state.candidates[0], { reviewState: "ready", contentHash: "a".repeat(64) });
    expect(await f.api.applyMemoryPanelAction(f.event, { ...confirm, contentHash: undefined })).toEqual({ status: "rejected", reason: "MEMORY_CONFIRMATION_STALE" });
    expect(f.actions).toEqual([]);
  });
  it("preserves a candidate content hash through the DTO and checks it before forwarding confirmation", async () => {
    const f = fixture(), contentHash = "a".repeat(64);
    f.state.candidates[0].contentHash = contentHash;
    expect((await f.api.getMemoryPanelState(f.event)).candidates[0].contentHash).toBe(contentHash);
    expect(await f.api.applyMemoryPanelAction(f.event, { ...confirm, contentHash: "b".repeat(64) })).toEqual({ status: "rejected", reason: "MEMORY_CONFIRMATION_STALE" });
    expect(f.actions).toEqual([]);
    expect(await f.api.applyMemoryPanelAction(f.event, { ...confirm, contentHash })).toMatchObject({ status: "active" });
    expect(f.actions).toEqual([{ ...confirm, contentHash }]);
  });
  it("accepts the exact settings main frame and returns current state", async () => {
    const f = fixture();
    expect(await f.api.getMemoryPanelState(f.event)).toEqual(f.state);
    expect(await f.api.applyMemoryPanelAction(f.event, confirm)).toEqual({ status: "active", factId: "fact-1", factRevision: 1 });
    expect((await f.api.getMemoryPanelState(f.event)).candidates).toEqual([]);
  });
  it("keeps the scope and project name of facts and candidates, and never lets an internal project key through", async () => {
    const f = fixture();
    const source = { sourceId: "source-1", revision: 1 };
    f.state.facts = [{ factId: "fact-1", revision: 1, subjectKey: "k", assertion: "我默认用 bash", assertionKind: "user-statement", time: { validFrom: 1, validTo: null, referenceTime: 1 }, sourceRef: source,
      recordedAt: 1, acceptedAt: 1, supersededAt: null, activationReason: "explicitUserConfirmed", policyVersion: "t", provenance: { candidateId: null, evidenceId: null, activationSourceRef: source },
      scope: "project", projectName: "alpha", projectKey: "project-deadbeef" } as any];
    f.state.candidates = [{ ...f.state.candidates[0], scope: "project", projectName: "beta", projectKey: "project-cafe" } as any];
    const out = await f.api.getMemoryPanelState(f.event);
    expect(out.facts[0]).toMatchObject({ scope: "project", projectName: "alpha" });
    expect(out.candidates[0]).toMatchObject({ scope: "project", projectName: "beta" });
    expect(JSON.stringify(out)).not.toContain("project-deadbeef"); expect(JSON.stringify(out)).not.toContain("project-cafe");
    f.state.facts = [{ ...f.state.facts[0], scope: "somewhere", projectName: 42 } as any];
    expect(Object.keys((await f.api.getMemoryPanelState(f.event)).facts[0])).not.toEqual(expect.arrayContaining(["scope", "projectName"]));
  });
  it("passes a fact's category and the source conversation title, but never the typed record", async () => {
    const f = fixture();
    const source = { sourceId: "source-1", revision: 1 };
    f.state.facts = [{ factId: "fact-1", revision: 1, subjectKey: "k", assertion: "请用中文回复", assertionKind: "user-statement", time: { validFrom: 1, validTo: null, referenceTime: 1 }, sourceRef: source,
      recordedAt: 1, acceptedAt: 1, supersededAt: null, activationReason: "policyAccepted", policyVersion: "t", provenance: { candidateId: null, evidenceId: null, activationSourceRef: source },
      typed: { legacyAttribute: "language", entityKey: "entity-secret", slotKey: "slot-secret" }, sourceTitle: "周末计划".repeat(60) } as any];
    f.state.candidates = [{ ...f.state.candidates[0], sourceTitle: "聊聊茶" }];
    const out = await f.api.getMemoryPanelState(f.event);
    expect(out.facts[0]).toMatchObject({ attribute: "language" }); expect(out.facts[0].sourceTitle).toHaveLength(200);
    expect(out.candidates[0]).toMatchObject({ sourceTitle: "聊聊茶" });
    expect(JSON.stringify(out)).not.toContain("entity-secret"); expect(out.facts[0]).not.toHaveProperty("typed");
    f.state.facts = [{ ...f.state.facts[0], typed: undefined, sourceTitle: 7 } as any];
    expect(Object.keys((await f.api.getMemoryPanelState(f.event)).facts[0])).not.toEqual(expect.arrayContaining(["attribute", "sourceTitle"]));
  });
  it("stale_revision_or_foreign_window_rejected", async () => {
    const f = fixture();
    expect(await f.api.applyMemoryPanelAction(f.event, { ...confirm, expectedRevision: 2 })).toEqual({ status: "rejected", reason: "MEMORY_REVISION_CONFLICT" });
    for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }, { ...f.event, senderFrame: null }]) {
      await expect(f.api.getMemoryPanelState(event as IpcMainInvokeEvent)).rejects.toThrow("MEMORY_SETTINGS_FORBIDDEN");
      expect(await f.api.applyMemoryPanelAction(event as IpcMainInvokeEvent, confirm)).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FORBIDDEN" });
      await expect(f.api.auditMemoryPanelSource(event as IpcMainInvokeEvent, "fact-1")).rejects.toThrow("MEMORY_SETTINGS_FORBIDDEN");
    }
    expect(f.actions).toEqual([]);
  });
  it("rejects destroyed windows and rechecks a queued sender", async () => {
    const f = fixture();
    f.win.webContents.isDestroyed = () => true;
    expect(await f.api.applyMemoryPanelAction(f.event, confirm)).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FORBIDDEN" });
    f.win.webContents.isDestroyed = () => false;
    f.win.isDestroyed = () => true;
    await expect(f.api.getMemoryPanelState(f.event)).rejects.toThrow("MEMORY_SETTINGS_FORBIDDEN");
  });
  it("rejects actor/source injection and invalid IDs, revisions, text, and accessors", async () => {
    const f = fixture();
    const hostile = [
      { ...confirm, actor: {} }, { ...confirm, sourceRef: { sourceId: "forged" } },
      { ...confirm, id: "../path" }, { ...confirm, expectedRevision: 0 }, { ...confirm, expectedRevision: 1.5 },
      { ...confirm, kind: "remember" }, { ...confirm, kind: "correct" }, { ...confirm, kind: "correct", text: " " },
      { ...confirm, text: "x".repeat(65537) }, { ...confirm, kind: "forget", text: "unrequested" },
      Object.defineProperty({ ...confirm }, "text", { enumerable: true, get: () => { throw new Error("must not invoke"); } }),
    ];
    for (const action of hostile) expect(await f.api.applyMemoryPanelAction(f.event, action)).toEqual({ status: "rejected", reason: "MEMORY_INPUT_INVALID" });
    expect(f.actions).toEqual([]);
  });
  it("double_submit_has_one_effect and different writes are serialized", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    const original = f.host.applyAction;
    f.host.applyAction = async (event, action) => { writes += 1; await gate; return original(event, action); };
    const first = f.api.applyMemoryPanelAction(f.event, confirm);
    const duplicate = f.api.applyMemoryPanelAction(f.event, { ...confirm });
    const competing = f.api.applyMemoryPanelAction(f.event, { ...confirm, contentHash: undefined, kind: "reject" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(1);
    release();
    expect(await first).toEqual(await duplicate);
    expect(await competing).toEqual({ status: "rejected", reason: "MEMORY_CANDIDATE_NOT_FOUND" });
    expect(f.actions).toHaveLength(1);
  });
  it("only forwards canonical action fields to the Main-owned host", async () => {
    const f = fixture();
    await f.api.applyMemoryPanelAction(f.event, { ...confirm, text: "我确认喜欢茶" });
    expect(f.actions).toEqual([{ ...confirm, text: "我确认喜欢茶" }]);
  });
  it("returns unavailable rather than empty-history success without a backend", async () => {
    const f = fixture();
    const api = createMemorySettingsIpc({ getSettingsWindow: () => f.win, host: null });
    expect((await api.getMemoryPanelState(f.event)).backendStatus).toEqual({ available: false, reason: "MEMORY_BACKEND_UNAVAILABLE" });
    expect(await api.applyMemoryPanelAction(f.event, confirm)).toEqual({ status: "rejected", reason: "MEMORY_BACKEND_UNAVAILABLE" });
  });
  it("sanitizes errors and strips internal state and provenance fields", async () => {
    const f = fixture();
    f.host.applyAction = async () => { throw new Error("/private/profile secret-token"); };
    expect(await f.api.applyMemoryPanelAction(f.event, confirm)).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FAILED" });
    f.host.getState = async () => ({ ...f.state, privatePath: "/private", actor: {}, backendStatus: { available: true, secret: "token" } });
    const serialized = JSON.stringify(await f.api.getMemoryPanelState(f.event));
    expect(serialized).not.toMatch(/private|actor|secret|token/);
    f.host.auditSource = async () => ({ factId: "fact-1", revision: 1, status: "eligible", reason: "valid-support", sources: [{ sourceId: "source-1", revision: 1, kind: "automatic", validity: "valid", occurredAt: 42, proof: { nonce: "private-token" } }] });
    expect(JSON.stringify(await f.api.auditMemoryPanelSource(f.event, "fact-1"))).not.toContain("private-token");
    f.host.auditSource = async () => { throw new Error("/private/source secret-token"); };
    await expect(f.api.auditMemoryPanelSource(f.event, "fact-1")).rejects.toThrow(/^MEMORY_SETTINGS_FAILED$/);
  });
  it("registers only typed channels with the verified handlers", async () => {
    const f = fixture();
    const channels = new Map<string, (...args: any[]) => unknown>();
    registerMemorySettingsIpc({ host: f.host, getSettingsWindow: () => f.win, ipc: { handle: (name, handler) => { channels.set(name, handler); } } });
    expect([...channels.keys()]).toEqual([IPC.MEMORY_PANEL_GET_STATE, IPC.MEMORY_PANEL_APPLY_ACTION, IPC.MEMORY_PANEL_AUDIT_SOURCE]);
    expect(await channels.get(IPC.MEMORY_PANEL_GET_STATE)!(f.event)).toEqual(f.state);
  });
  it("forwards the exact original event to the Main host and rechecks after action completion", async () => {
    const f = fixture();
    const seen: unknown[] = [];
    const read = f.host.getState; const audit = f.host.auditSource;
    f.host.getState = async (event) => { seen.push(event); return read(event); };
    f.host.auditSource = async (event, id) => { seen.push(event); return audit(event, id); };
    await f.api.getMemoryPanelState(f.event); await f.api.auditMemoryPanelSource(f.event, "fact-1");
    f.host.applyAction = async (event) => { seen.push(event); f.win.isDestroyed = () => true; return { status: "active", factId: "private-result" }; };
    expect(await f.api.applyMemoryPanelAction(f.event, confirm)).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FORBIDDEN" });
    expect(seen).toHaveLength(4); expect(seen.every((event) => event === f.event)).toBe(true);
  });
  it("does not execute a queued action after the actual settings window changes", async () => {
    const f = fixture();
    let release!: () => void;
    f.host.getState = async () => { await new Promise<void>((resolve) => { release = resolve; }); return f.state; };
    const result = f.api.applyMemoryPanelAction(f.event, confirm);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.win.webContents.mainFrame = {};
    release();
    expect(await result).toEqual({ status: "rejected", reason: "MEMORY_SETTINGS_FORBIDDEN" });
    expect(f.actions).toEqual([]);
  });
  it("preload exposes only the revisioned DTO methods, without source or actor constructors", async () => {
    await import("../../preload/index");
    const api = preload.exposed.get("memoryPanel");
    preload.invoke.mockClear(); preload.invoke.mockResolvedValue({});
    await api.getState(); await api.applyAction(confirm); await api.auditSource("fact-1");
    expect(preload.invoke.mock.calls).toEqual([[IPC.MEMORY_PANEL_GET_STATE], [IPC.MEMORY_PANEL_APPLY_ACTION, confirm], [IPC.MEMORY_PANEL_AUDIT_SOURCE, "fact-1"]]);
    expect(api.bindActor).toBeUndefined(); expect(api.event).toBeUndefined(); expect(api.source).toBeUndefined();
  });

  it("preserves public dependency reason codes while hiding raw backend failures", async () => {
    const f = fixture();
    for (const reason of ["MEMORY_KEY_PROTECTION_UNAVAILABLE", "MEMORY_HISTORY_NATIVE_UNAVAILABLE", "MEMORY_WORKER_FAILED", "MEMORY_STORAGE_INVALID"]) {
      f.host.getState = async () => { throw new Error(reason); };
      expect((await f.api.getMemoryPanelState(f.event)).backendStatus).toEqual({ available: false, reason });
    }
    f.host.getState = async () => { throw new Error("/private/database secret-value"); };
    expect((await f.api.getMemoryPanelState(f.event)).backendStatus).toEqual({ available: false, reason: "MEMORY_SETTINGS_FAILED" });
  });

});

it('preserves bounded candidate time across the settings IPC whitelist', async () => {
 const f=fixture(),time={validFrom:1,validTo:2,referenceTime:3};
 f.state.candidates[0].time=time;
 expect((await f.api.getMemoryPanelState(f.event)).candidates[0].time).toEqual(time);
});
