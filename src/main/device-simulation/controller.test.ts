import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageContext, type StorageContext } from "../storage-context";
import { resolveRuntimeProfile, within } from "../runtime-profile";
import { DeviceSimulation, type McpDevicePort, type SimulationSession } from "./controller";
import type { DeviceId, Receipt, SessionGrant } from "./contracts";

const roots: string[] = [];
const simulations: DeviceSimulation[] = [];
const grant: SessionGrant = { owner: "demo-owner", read: ["light", "ac", "curtain"], actions: { light: ["power", "brightness"], ac: ["power", "mode", "setpoint"], curtain: ["position"] } };
function reopen(context: StorageContext, options: ConstructorParameters<typeof DeviceSimulation>[1] = {}) {
  const simulation = new DeviceSimulation(context, options); simulations.push(simulation); return simulation;
}
function setup(deferredDeviceIds: readonly DeviceId[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-device-controller-")); roots.push(root);
  const isolated = path.join(root, "isolated"); fs.mkdirSync(isolated);
  const context = createStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", `--firefly-isolation-root=${isolated}`], env: {}, isPackaged: false, productionAppData: path.join(root, "production") }));
  let now = 1000;
  const simulation = reopen(context, { now: () => now, deferredDeviceIds });
  const session = simulation.openSession(grant);
  return { simulation, session, context, file: path.join(context.stateRoot, "device-simulation", "journal.json"), advance: (ms: number) => { now += ms; } };
}
function portFor(simulation: DeviceSimulation, session: SimulationSession): McpDevicePort & { execute: ReturnType<typeof vi.fn>; receipt: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(async id => simulation.handleMcp(session, "execute", { operationId: id })), receipt: vi.fn(async id => simulation.handleMcp(session, "receipt", { operationId: id })) };
}
function approve(simulation: DeviceSimulation, session: SimulationSession, deviceId: DeviceId = "light", action: unknown = { type: "power", on: true }) {
  return simulation.confirm(session, simulation.preview(session, deviceId, action).id);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const simulation of simulations.splice(0)) simulation.close();
  for (const root of roots.splice(0)) {
    if (!within(os.tmpdir(), root) || !path.basename(root).startsWith("firefly-device-controller-")) throw new Error("unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("simulated exact device authority", () => {
  it("denies absent read/action grants and forged or foreign opaque sessions", () => {
    const { simulation, session } = setup();
    const denied = simulation.openSession({ owner: "no-grants", read: [] });
    expect(() => simulation.read(denied, "light")).toThrow("E_SIM_DENIED");
    expect(() => simulation.preview(denied, "light", { type: "power", on: true })).toThrow("E_SIM_DENIED");
    expect(() => simulation.read({ simulation: true } as SimulationSession, "light")).toThrow("E_SIM_DENIED");
    expect(() => setup().simulation.read(session, "light")).toThrow("E_SIM_DENIED");
    expect(() => simulation.openSession({ owner: "../private", read: ["light"] })).toThrow("E_SIM_GRANT");
    expect(() => simulation.openSession({ owner: "demo", read: ["light"], actions: { light: ["mode"] } })).toThrow("E_SIM_GRANT");
  });

  it("copies trusted grants and enforces device/action-specific limits", () => {
    const { simulation } = setup();
    const source: { owner: string; read: DeviceId[]; actions: { light: ("power" | "brightness")[] } } = { owner: "reader", read: ["light"], actions: { light: ["power"] } };
    const session = simulation.openSession(source);
    source.read.push("ac"); source.actions.light.push("brightness");
    expect(() => simulation.read(session, "ac")).toThrow("E_SIM_DENIED");
    expect(() => simulation.preview(session, "light", { type: "brightness", value: 50 })).toThrow("E_SIM_DENIED");
    expect(simulation.preview(session, "light", { type: "power", on: true }).simulation).toBe(true);
  });

  it("reads/previews without journal/effect writes; serialized output cannot alter confirmation", () => {
    const { simulation, session, file } = setup();
    const before = simulation.read(session, "light"); before.revision = 99;
    const preview = simulation.preview(session, "light", { type: "power", on: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(simulation.read(session, "light")).toMatchObject({ revision: 0, power: false });
    if (preview.action.type === "power") preview.action.on = false;
    preview.before.revision = 42;
    const operation = simulation.confirm(session, preview.id);
    expect(operation).toMatchObject({ simulation: true, status: "approved", action: { type: "power", on: true }, effectState: "not_applied", retryable: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).operations[0].intent.before.revision).toBe(0);
    expect(() => simulation.confirm(session, preview.id)).toThrow("E_SIM_PREVIEW");
    expect(() => simulation.confirm(session, JSON.stringify(preview))).toThrow("E_SIM_PREVIEW");
  });

  it("rejects expired previews and stale revisions without consuming another owner's preview", async () => {
    const { simulation, session, advance } = setup();
    const preview = simulation.preview(session, "light", { type: "power", on: true });
    const other = simulation.openSession({ ...grant, owner: "other-owner" });
    expect(() => simulation.confirm(other, preview.id)).toThrow("E_SIM_DENIED");
    advance(30_000);
    expect(() => simulation.confirm(session, preview.id)).toThrow("E_SIM_EXPIRED");
    const stale = simulation.preview(session, "light", { type: "brightness", value: 60 });
    await simulation.dispatch(session, approve(simulation, session).id, portFor(simulation, session));
    expect(() => simulation.confirm(session, stale.id)).toThrow("E_SIM_STALE");
  });

  it("revalidates revocation and exact approval before dispatch and in raw MCP handlers", async () => {
    const { simulation, session } = setup();
    const operation = approve(simulation, session); const port = portFor(simulation, session);
    const other = simulation.openSession({ ...grant, owner: "other-owner" });
    await expect(simulation.dispatch(other, operation.id, port)).rejects.toThrow("E_SIM_DENIED");
    expect(() => simulation.handleMcp(session, "execute", { operationId: operation.id })).toThrow("E_SIM_NOT_DISPATCHED");
    expect(() => simulation.handleMcp(session, "execute", { operationId: operation.id, approved: true })).toThrow("E_SIM_ARGS");
    expect(() => simulation.handleMcp(session, "confirm", { previewId: "anything" })).toThrow("E_SIM_TOOL");
    simulation.revokeSession(session);
    await expect(simulation.dispatch(session, operation.id, port)).rejects.toThrow("E_SIM_DENIED");
    expect(() => simulation.handleMcp(session, "read", { deviceId: "light" })).toThrow("E_SIM_DENIED");
    expect(port.execute).not.toHaveBeenCalled();
  });

  it("persists dispatching before send and deduplicates an already applied operation", async () => {
    const { simulation, session, file } = setup(); const operation = approve(simulation, session);
    const port = portFor(simulation, session);
    port.execute.mockImplementation(async id => {
      expect(JSON.parse(fs.readFileSync(file, "utf8")).operations[0]).toMatchObject({ status: "dispatching" });
      return simulation.handleMcp(session, "execute", { operationId: id });
    });
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "applied", effectState: "applied" });
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "applied" });
    simulation.handleMcp(session, "execute", { operationId: operation.id });
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(simulation.read(session, "light")).toMatchObject({ revision: 1, power: true });
  });

  it("does not send twice when the same command is concurrently dispatched", async () => {
    const { simulation, session } = setup(); const operation = approve(simulation, session);
    let release!: (receipt: unknown) => void;
    const port = portFor(simulation, session);
    port.execute.mockImplementation(id => new Promise(resolve => { release = () => resolve(simulation.handleMcp(session, "execute", { operationId: id })); }));
    const pending = simulation.dispatch(session, operation.id, port);
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "dispatching", effectState: "unknown" });
    expect(port.execute).toHaveBeenCalledTimes(1); release(undefined);
    expect(await pending).toMatchObject({ status: "applied" });
  });

  it("does not call the provider when durable dispatch publication fails", async () => {
    const { simulation, session, file } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    const bytes = fs.readFileSync(file, "utf8"); const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => { if (String(target) === file) throw new Error("synthetic rename fault"); return rename(source, target); });
    await expect(simulation.dispatch(session, operation.id, port)).rejects.toThrow("E_SIM_STORAGE");
    expect(port.execute).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(simulation.read(session, "light")).toMatchObject({ revision: 0, power: false });
  });

  it("records accepted as pending until a correlated completion receipt is reconciled", async () => {
    const { simulation, session } = setup(["ac"]); const operation = approve(simulation, session, "ac", { type: "setpoint", celsius: 20 }); const port = portFor(simulation, session);
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "accepted", effectState: "unknown" });
    expect(simulation.read(session, "ac")).toMatchObject({ revision: 0, setpointC: 24, roomTemperatureC: 26 });
    simulation.completeFixture(operation.id);
    simulation.completeFixture(operation.id);
    expect(simulation.read(session, "ac")).toMatchObject({ revision: 1, setpointC: 20, roomTemperatureC: 26 });
    expect(await simulation.reconcile(session, operation.id, port)).toMatchObject({ status: "applied" });
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(simulation.pending(session)).toEqual([]);
  });

  it.each(["applied", "rejected"] as const)("preserves verified %s when the original accepted execution reply arrives late", async terminalPhase => {
    const { simulation, session, file } = setup(["light"]); const operation = approve(simulation, session); const port = portFor(simulation, session);
    let release!: () => void;
    const delayed = { ...port, execute: (id: string) => {
      const accepted = simulation.handleMcp(session, "execute", { operationId: id });
      return new Promise(resolve => { release = () => resolve(accepted); });
    } };
    const inFlight = simulation.dispatch(session, operation.id, delayed);
    if (terminalPhase === "rejected") {
      const other = approve(simulation, session, "light", { type: "brightness", value: 75 });
      await simulation.dispatch(session, other.id, port); simulation.completeFixture(other.id);
    }
    simulation.completeFixture(operation.id);
    expect(await simulation.reconcile(session, operation.id, port)).toMatchObject({ status: terminalPhase });
    const beforeLate = fs.readFileSync(file, "utf8"); release();
    expect(await inFlight).toMatchObject({ status: terminalPhase });
    expect(fs.readFileSync(file, "utf8")).toBe(beforeLate);
    const stored = JSON.parse(beforeLate).operations.find((op: { id: string }) => op.id === operation.id);
    expect(stored.verifiedReceipt.phase).toBe(terminalPhase);
    expect(simulation.pending(session).some(op => op.id === operation.id)).toBe(false);
  });

  it.each(["journal", "lease"] as const)("does not query receipts after runtime %s integrity or ownership loss", async target => {
    const { simulation, session, file } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    port.execute.mockRejectedValue(new Error("synthetic disconnect"));
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown" });
    const damaged = target === "journal" ? file : path.join(path.dirname(file), "session.lock");
    const before = fs.readFileSync(damaged); const hostile = target === "journal" ? "not-json" : "foreign-owner";
    fs.writeFileSync(damaged, hostile);
    try {
      expect(await simulation.reconcile(session, operation.id, port)).toMatchObject({ status: "unknown", effectState: "unknown" });
      expect(port.receipt).not.toHaveBeenCalled();
      expect(fs.readFileSync(damaged, "utf8")).toBe(hostile);
      expect(() => simulation.handleMcp(session, "receipt", { operationId: operation.id })).toThrow(target === "journal" ? "E_SIM_JOURNAL_INVALID" : "E_SIM_BUSY");
    } finally { fs.writeFileSync(damaged, before); }
  });

  it("recovers a lost acknowledgement with receipt-only reconciliation after reconstruction", async () => {
    const { simulation, session, context } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    port.execute.mockImplementation(async id => { simulation.handleMcp(session, "execute", { operationId: id }); throw new Error("ack lost"); });
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown", retryable: false, effectState: "unknown" });
    expect(simulation.read(session, "light")).toMatchObject({ revision: 1, power: true });
    simulation.close();
    const next = reopen(context); const nextSession = next.openSession(grant); const nextPort = portFor(next, nextSession);
    expect(next.pending(nextSession)).toHaveLength(1);
    expect(await next.reconcile(nextSession, operation.id, nextPort)).toMatchObject({ status: "applied" });
    expect(nextPort.execute).not.toHaveBeenCalled(); expect(nextPort.receipt).toHaveBeenCalledTimes(1);
  });

  it("does not query or recreate a durable journal removed after acceptance", async () => {
    const { simulation, session, file } = setup(["light"]); const operation = approve(simulation, session); const port = portFor(simulation, session);
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "accepted", effectState: "unknown" });
    const original = fs.readFileSync(file); fs.renameSync(file, file + ".moved");
    try {
      expect(await simulation.reconcile(session, operation.id, port)).toMatchObject({ status: "unknown", effectState: "unknown", retryable: false });
      expect(port.receipt).not.toHaveBeenCalled();
      expect(simulation.pending(session).find(op => op.id === operation.id)).toMatchObject({ status: "accepted" });
      expect(fs.existsSync(file)).toBe(false); expect(fs.readFileSync(file + ".moved")).toEqual(original);
      expect(() => simulation.handleMcp(session, "receipt", { operationId: operation.id })).toThrow("E_SIM_JOURNAL_INVALID");
    } finally { fs.copyFileSync(file + ".moved", file); }
  });

  it("cannot upgrade the provider's accepted receipt to applied without its durable completion", async () => {
    const { simulation, session, file } = setup(["light"]); const operation = approve(simulation, session); const port = portFor(simulation, session);
    port.execute.mockImplementation(async id => {
      const accepted = simulation.handleMcp(session, "execute", { operationId: id }) as Receipt;
      return { ...accepted, phase: "applied", state: { ...accepted.state, power: true, revision: 1 } };
    });
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown", reason: "E_SIM_RECEIPT_INVALID" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).operations[0].providerReceipt.phase).toBe("accepted");
    expect(simulation.read(session, "light")).toMatchObject({ revision: 0, power: false });
  });

  it("does not infer no effect from an absent receipt or replay an unknown command", async () => {
    const { simulation, session, context } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    port.execute.mockRejectedValue(new Error("connection gone before known receipt"));
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown" });
    simulation.close(); const next = reopen(context); const nextSession = next.openSession(grant); const nextPort = portFor(next, nextSession);
    expect(await next.dispatch(nextSession, operation.id, nextPort)).toMatchObject({ status: "unknown" });
    expect(await next.reconcile(nextSession, operation.id, nextPort)).toMatchObject({ status: "unknown" });
    expect(nextPort.execute).not.toHaveBeenCalled();
    expect(next.read(nextSession, "light")).toMatchObject({ revision: 0, power: false });
  });

  it.each([null, undefined, "opaque transport failure"])("retains unknown when a port rejects with a non-Error value %j", async failure => {
    const { simulation, session } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    port.execute.mockRejectedValue(failure);
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown", effectState: "unknown", retryable: false });
    port.receipt.mockRejectedValue(failure);
    expect(await simulation.reconcile(session, operation.id, port)).toMatchObject({ status: "unknown", effectState: "unknown" });
    expect(port.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "providerId", "epoch", "operationId", "intentDigest", "deviceId", "action", "state", "phase", "extra"])("rejects a contradictory %s receipt without replay", async field => {
    const { simulation, session } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    port.execute.mockImplementation(async id => {
      const receipt = simulation.handleMcp(session, "execute", { operationId: id }) as Receipt;
      return { ...receipt, [field]: field === "state" ? { ...receipt.state, revision: 99 } : "tampered" };
    });
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown", reason: "E_SIM_RECEIPT_INVALID", effectState: "unknown" });
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(simulation.read(session, "light")).toMatchObject({ revision: 1 });
  });

  it("distinguishes cancellation before dispatch from cancellation after an effect", async () => {
    const first = setup(); const operation = approve(first.simulation, first.session); const before = new AbortController(); before.abort(); const port = portFor(first.simulation, first.session);
    expect(await first.simulation.dispatch(first.session, operation.id, port, before.signal)).toMatchObject({ status: "cancelled", effectState: "not_applied" });
    expect(port.execute).not.toHaveBeenCalled();
    const second = setup(); const sent = approve(second.simulation, second.session); const after = new AbortController(); const sentPort = portFor(second.simulation, second.session);
    sentPort.execute.mockImplementation(async id => { second.simulation.handleMcp(second.session, "execute", { operationId: id }); after.abort(); throw new DOMException("cancelled", "AbortError"); });
    expect(await second.simulation.dispatch(second.session, sent.id, sentPort, after.signal)).toMatchObject({ status: "unknown", effectState: "unknown", retryable: false });
    expect(second.simulation.read(second.session, "light")).toMatchObject({ revision: 1 });
    expect(() => second.simulation.cancel(second.session, sent.id)).toThrow("E_SIM_NOT_CANCELLABLE");
  });

  it("ignores late acknowledgements after disposal while the next owner changes state", async () => {
    const { simulation, session, context, file } = setup(); const operation = approve(simulation, session); const port = portFor(simulation, session);
    let release!: () => void;
    port.execute.mockImplementation(id => { const receipt = simulation.handleMcp(session, "execute", { operationId: id }); return new Promise(resolve => { release = () => resolve(receipt); }); });
    const inFlight = simulation.dispatch(session, operation.id, port); simulation.close();
    const next = reopen(context); const nextSession = next.openSession(grant); const nextPort = portFor(next, nextSession);
    await next.dispatch(nextSession, approve(next, nextSession, "light", { type: "brightness", value: 75 }).id, nextPort);
    const bytes = fs.readFileSync(file, "utf8"); release();
    expect(await inFlight).toMatchObject({ status: "unknown", effectState: "unknown" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(next.read(nextSession, "light")).toMatchObject({ revision: 2, brightness: 75 });
    expect(await next.reconcile(nextSession, operation.id, nextPort)).toMatchObject({ status: "applied" });
  });

  it("retains unsent approvals across close but refuses their old epoch; cancellation permits bounded reuse", async () => {
    const { simulation, session, context } = setup(); const operation = approve(simulation, session); simulation.close();
    const next = reopen(context); const nextSession = next.openSession(grant); const port = portFor(next, nextSession);
    await expect(next.dispatch(nextSession, operation.id, port)).rejects.toThrow("E_SIM_STALE");
    expect(next.cancel(nextSession, operation.id)).toMatchObject({ status: "cancelled", effectState: "not_applied" });
    expect(port.execute).not.toHaveBeenCalled();
  });

  it("caps previews and refuses to evict unresolved operations", () => {
    const { simulation, session, advance, file } = setup();
    for (let i = 0; i < 32; i++) simulation.preview(session, "light", { type: "power", on: true });
    expect(() => simulation.preview(session, "light", { type: "power", on: true })).toThrow("E_SIM_LIMIT");
    advance(30_001);
    for (let i = 0; i < 128; i++) approve(simulation, session);
    const preview = simulation.preview(session, "light", { type: "power", on: false });
    expect(() => simulation.confirm(session, preview.id)).toThrow("E_SIM_LIMIT");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")); expect(stored.operations).toHaveLength(128);
    simulation.cancel(session, stored.operations[0].id);
    expect(simulation.confirm(session, preview.id).status).toBe("approved");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).operations).toHaveLength(128);
  });
});
