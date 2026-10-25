import { randomUUID } from "node:crypto";
import type { StorageContext } from "../storage/storage-context";
import { SimulationJournal } from "./journal";
import { ACTION_TYPES, DEVICE_IDS, SIMULATION_LIMITS, applyAction, createFixtures, exactKeys, intentDigest, isDeviceId, isRecord, normalizeAction, validOwner, validateReceipt,
  type Action, type DeviceId, type DeviceSnapshot, type Intent, type JournalState, type Operation, type OperationReason, type OperationStatus, type Receipt, type SessionGrant } from "./contracts";

export interface SimulationSession { readonly simulation: true }
export interface Preview { simulation: true; id: string; owner: string; deviceId: DeviceId; action: Action; before: DeviceSnapshot; expiresAt: number; digest: string; epoch: string }
export interface OperationView { simulation: true; id: string; owner: string; deviceId: DeviceId; action: Action; status: OperationStatus; reason?: OperationReason; effectState: "not_applied" | "unknown" | "applied"; retryable: false }
export interface McpDevicePort { execute(id: string, signal?: AbortSignal): Promise<unknown>; receipt(id: string, signal?: AbortSignal): Promise<unknown> }
const terminal = (status: OperationStatus) => ["applied", "rejected", "cancelled"].includes(status);
function view(operation: Operation): OperationView {
  return structuredClone({ simulation: true, id: operation.id, owner: operation.intent.owner, deviceId: operation.intent.deviceId,
    action: operation.intent.action, status: operation.status, ...(operation.reason ? { reason: operation.reason } : {}),
    effectState: operation.status === "applied" ? "applied" : ["approved", "rejected", "cancelled"].includes(operation.status) ? "not_applied" : "unknown", retryable: false });
}
export class DeviceSimulation {
  private readonly journal: SimulationJournal;
  private state: JournalState;
  private readonly epoch = randomUUID();
  private readonly sessions = new WeakMap<SimulationSession, { grant: SessionGrant; active: boolean }>();
  private readonly previews = new Map<string, { session: SimulationSession; intent: Intent }>();
  private readonly approvals = new Map<string, SimulationSession>();
  private readonly now: () => number;
  private readonly deferred: ReadonlySet<DeviceId>;
  private closed = false;

  constructor(context: StorageContext, options: { now?: () => number; deferredDeviceIds?: readonly DeviceId[] } = {}) {
    if ((options.now !== undefined && typeof options.now !== "function") || (options.deferredDeviceIds !== undefined && (!Array.isArray(options.deferredDeviceIds) || !options.deferredDeviceIds.every(isDeviceId)))) throw new Error("E_SIM_OPTIONS");
    this.now = options.now ?? Date.now;
    this.deferred = new Set(options.deferredDeviceIds);
    this.journal = new SimulationJournal(context);
    try {
      this.state = this.journal.read({ version: 1, simulation: true, providerId: randomUUID(), fixtures: createFixtures(), operations: [] });
      if (this.state.operations.some(op => op.status === "dispatching")) this.save(next => {
        for (const op of next.operations) if (op.status === "dispatching") { op.status = "unknown"; op.reason = "E_SIM_RESTARTED"; }
      });
    } catch (error) { try { this.journal.close(); } catch { /* fail closed if ownership changed */ } throw error; }
  }
  private assertOpen(): void { if (this.closed) throw new Error("E_SIM_CLOSED"); }
  private time(): number {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0 || time + SIMULATION_LIMITS.previewTtlMs >= Number.MAX_SAFE_INTEGER) throw new Error("E_SIM_CLOCK");
    return time;
  }
  private save(change: (next: JournalState) => void): void {
    this.assertOpen(); const next = structuredClone(this.state); change(next);
    this.journal.write(next); this.state = next;
  }
  private session(session: SimulationSession): SessionGrant {
    this.assertOpen(); const owned = this.sessions.get(session);
    if (!owned?.active) throw new Error("E_SIM_DENIED"); return owned.grant;
  }
  private authorize(session: SimulationSession, deviceId: DeviceId, action?: Action): SessionGrant {
    const grant = this.session(session);
    if (!isDeviceId(deviceId) || !grant.read.includes(deviceId) || (action && !grant.actions?.[deviceId]?.includes(action.type))) throw new Error("E_SIM_DENIED");
    return grant;
  }
  private operation(id: string): Operation {
    const operation = this.state.operations.find(op => op.id === id);
    if (!operation) throw new Error("E_SIM_OPERATION"); return operation;
  }
  private ownedOperation(session: SimulationSession, id: string, action = false): Operation {
    const op = this.operation(id); const grant = this.authorize(session, op.intent.deviceId, action ? op.intent.action : undefined);
    if (op.intent.owner !== grant.owner) throw new Error("E_SIM_DENIED"); return op;
  }
  /** Read-only checkpoint; validate durable health/ownership without reloading cached state. */
  assertReady(session: SimulationSession): void {
    this.session(session); this.journal.read(this.state);
  }
  openSession(grant: SessionGrant): SimulationSession {
    this.assertOpen();
    if (!isRecord(grant) || !exactKeys(grant, ["owner", "read"], ["actions"]) || !validOwner(grant.owner)
      || !Array.isArray(grant.read) || !grant.read.every(isDeviceId) || new Set(grant.read).size !== grant.read.length) throw new Error("E_SIM_GRANT");
    if (grant.actions !== undefined && (!isRecord(grant.actions) || !exactKeys(grant.actions, [], DEVICE_IDS)
      || !Object.entries(grant.actions).every(([id, actions]) => isDeviceId(id) && grant.read.includes(id) && Array.isArray(actions) && actions.every(action => ACTION_TYPES[id].includes(action))))) throw new Error("E_SIM_GRANT");
    const session = Object.freeze({ simulation: true as const }); this.sessions.set(session, { grant: structuredClone(grant), active: true }); return session;
  }
  revokeSession(session: SimulationSession): void {
    this.session(session); this.sessions.get(session)!.active = false;
    for (const [id, preview] of this.previews) if (preview.session === session) this.previews.delete(id);
  }
  read(session: SimulationSession, deviceId: DeviceId): DeviceSnapshot {
    this.authorize(session, deviceId); return structuredClone(this.state.fixtures[deviceId]);
  }
  preview(session: SimulationSession, deviceId: DeviceId, action: unknown): Preview {
    const normalized = normalizeAction(deviceId, action); const grant = this.authorize(session, deviceId, normalized); const time = this.time();
    for (const [id, existing] of this.previews) if (existing.intent.expiresAt <= time) this.previews.delete(id);
    if (this.previews.size >= SIMULATION_LIMITS.previews) throw new Error("E_SIM_LIMIT");
    const body = { simulation: true as const, providerId: this.state.providerId, owner: grant.owner, epoch: this.epoch, deviceId, action: normalized,
      before: structuredClone(this.state.fixtures[deviceId]), createdAt: time, expiresAt: time + SIMULATION_LIMITS.previewTtlMs };
    const intent: Intent = { ...body, digest: intentDigest(body) }; const id = randomUUID(); this.previews.set(id, { session, intent });
    return structuredClone({ simulation: true, id, owner: grant.owner, deviceId, action: normalized, before: intent.before, expiresAt: intent.expiresAt, digest: intent.digest, epoch: intent.epoch });
  }
  confirm(session: SimulationSession, id: string): OperationView {
    this.session(session); const preview = this.previews.get(id); if (!preview) throw new Error("E_SIM_PREVIEW");
    if (preview.session !== session) throw new Error("E_SIM_DENIED");
    const { intent } = preview; this.authorize(session, intent.deviceId, intent.action);
    if (intent.expiresAt <= this.time()) throw new Error("E_SIM_EXPIRED");
    if (this.state.fixtures[intent.deviceId].revision !== intent.before.revision) throw new Error("E_SIM_STALE");
    const operation: Operation = { simulation: true, id: randomUUID(), intent: structuredClone(intent), status: "approved" };
    let removed: string | undefined;
    this.save(next => {
      if (next.operations.length >= SIMULATION_LIMITS.operations) {
        const index = next.operations.findIndex(op => terminal(op.status));
        if (index < 0) throw new Error("E_SIM_LIMIT"); removed = next.operations.splice(index, 1)[0].id;
      }
      next.operations.push(operation);
    });
    if (removed) this.approvals.delete(removed); this.approvals.set(operation.id, session); this.previews.delete(id); return view(operation);
  }
  async dispatch(session: SimulationSession, id: string, port: McpDevicePort, signal?: AbortSignal): Promise<OperationView> {
    const op = this.ownedOperation(session, id);
    if (op.status !== "approved") return view(op); // Reads of pending/terminal state must never resend.
    this.authorize(session, op.intent.deviceId, op.intent.action);
    if (op.intent.epoch !== this.epoch) throw new Error("E_SIM_STALE");
    if (this.approvals.get(id) !== session) throw new Error("E_SIM_DENIED");
    if (op.intent.expiresAt <= this.time()) throw new Error("E_SIM_EXPIRED");
    if (this.state.fixtures[op.intent.deviceId].revision !== op.intent.before.revision) throw new Error("E_SIM_STALE");
    if (signal?.aborted) return this.cancel(session, id);
    this.save(next => { next.operations.find(item => item.id === id)!.status = "dispatching"; });
    try {
      const result = await port.execute(id, signal);
      if (this.closed) return view({ ...op, status: "unknown", reason: "E_SIM_COMMAND_UNKNOWN" });
      this.ownedOperation(session, id, true);
      if (signal?.aborted) throw new Error("E_SIM_COMMAND_UNKNOWN");
      return this.acceptReceipt(id, result);
    } catch (error) { return this.unknown(id, op, error instanceof Error && error.message === "E_SIM_RECEIPT_INVALID" ? "E_SIM_RECEIPT_INVALID" : "E_SIM_COMMAND_UNKNOWN"); }
  }
  private acceptReceipt(id: string, value: unknown): OperationView {
    const current = this.operation(id);
    if (terminal(current.status)) return view(current);
    if (!current.providerReceipt) throw new Error("E_SIM_RECEIPT_INVALID");
    const receipt = validateReceipt(value, current);
    this.save(next => {
      const op = next.operations.find(item => item.id === id)!; op.verifiedReceipt = receipt; op.status = receipt.phase;
      if (receipt.phase === "rejected") op.reason = "E_SIM_REJECTED"; else delete op.reason;
    });
    return view(this.operation(id));
  }
  private unknown(id: string, previous: Operation, reason: OperationReason): OperationView {
    if (this.closed) return view({ ...previous, status: "unknown", reason });
    try {
      this.save(next => { const op = next.operations.find(item => item.id === id)!; if (!terminal(op.status)) { op.status = "unknown"; op.reason = reason; } });
      return view(this.operation(id));
    } catch { return view({ ...previous, status: "unknown", reason }); } // Durable dispatching still prevents replay when storage is unavailable.
  }
  async reconcile(session: SimulationSession, id: string, port: McpDevicePort, signal?: AbortSignal): Promise<OperationView> {
    const op = this.ownedOperation(session, id);
    if (op.status === "approved" || terminal(op.status)) return view(op);
    try {
      this.assertReady(session);
      const result = await port.receipt(id, signal);
      if (this.closed) return view({ ...op, status: "unknown", reason: "E_SIM_COMMAND_UNKNOWN" });
      const current = this.ownedOperation(session, id);
      if (terminal(current.status)) return view(current);
      if (signal?.aborted) throw new Error("E_SIM_COMMAND_UNKNOWN");
      if (result === null) return current.status === "accepted" ? view(current) : this.unknown(id, current, "E_SIM_COMMAND_UNKNOWN");
      return this.acceptReceipt(id, result);
    } catch (error) { return this.unknown(id, op, error instanceof Error && error.message === "E_SIM_RECEIPT_INVALID" ? "E_SIM_RECEIPT_INVALID" : "E_SIM_COMMAND_UNKNOWN"); }
  }
  pending(session: SimulationSession): OperationView[] {
    const grant = this.session(session);
    return this.state.operations.filter(op => op.intent.owner === grant.owner && grant.read.includes(op.intent.deviceId) && !terminal(op.status)).map(view);
  }
  cancel(session: SimulationSession, id: string): OperationView {
    const op = this.ownedOperation(session, id); if (op.status !== "approved") throw new Error("E_SIM_NOT_CANCELLABLE");
    this.save(next => { const current = next.operations.find(item => item.id === id)!; current.status = "cancelled"; current.reason = "E_SIM_CANCELLED"; });
    return view(this.operation(id));
  }
  private receipt(op: Operation, phase: Receipt["phase"]): Receipt {
    const { intent } = op;
    return { simulation: true, providerId: intent.providerId, owner: intent.owner, epoch: intent.epoch, operationId: op.id, intentDigest: intent.digest,
      deviceId: intent.deviceId, action: structuredClone(intent.action), phase, state: phase === "applied" ? applyAction(intent.before, intent.action) : structuredClone(intent.before) };
  }
  handleMcp(session: SimulationSession, name: string, args: unknown): unknown {
    this.assertReady(session);
    if (!["read", "preview", "execute", "receipt"].includes(name)) throw new Error("E_SIM_TOOL");
    if (!isRecord(args)) throw new Error("E_SIM_ARGS");
    if (name === "read" || name === "preview") {
      if (!exactKeys(args, name === "read" ? ["deviceId"] : ["deviceId", "action"]) || !isDeviceId(args.deviceId)) throw new Error("E_SIM_ARGS");
      return name === "read" ? this.read(session, args.deviceId) : this.preview(session, args.deviceId, args.action);
    }
    if (!exactKeys(args, ["operationId"]) || typeof args.operationId !== "string") throw new Error("E_SIM_ARGS");
    const op = this.ownedOperation(session, args.operationId, name === "execute");
    if (name === "receipt") return structuredClone(op.providerReceipt ?? null);
    if (op.providerReceipt) return structuredClone(op.providerReceipt); // Duplicate receipt retrieval never repeats an effect.
    if (op.status !== "dispatching" || this.approvals.get(op.id) !== session) throw new Error("E_SIM_NOT_DISPATCHED");
    if (op.intent.epoch !== this.epoch) throw new Error("E_SIM_STALE");
    const phase = op.intent.expiresAt <= this.time() || this.state.fixtures[op.intent.deviceId].revision !== op.intent.before.revision
      ? "rejected" : this.deferred.has(op.intent.deviceId) ? "accepted" : "applied";
    const receipt = this.receipt(op, phase);
    this.save(next => {
      next.operations.find(item => item.id === op.id)!.providerReceipt = receipt;
      if (phase === "applied") next.fixtures = { ...next.fixtures, [op.intent.deviceId]: receipt.state };
    });
    return structuredClone(receipt);
  }
  completeFixture(id: string): void {
    this.assertOpen(); const op = this.operation(id); if (op.providerReceipt?.phase !== "accepted") return;
    const phase = this.state.fixtures[op.intent.deviceId].revision === op.intent.before.revision ? "applied" : "rejected";
    const receipt = this.receipt(op, phase);
    this.save(next => {
      next.operations.find(item => item.id === id)!.providerReceipt = receipt;
      if (phase === "applied") next.fixtures = { ...next.fixtures, [op.intent.deviceId]: receipt.state };
    });
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.previews.clear(); this.approvals.clear(); this.journal.close();
  }
}
