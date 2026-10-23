import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export type DeviceId = "light" | "ac" | "curtain";
export type Action = { type: "power"; on: boolean } | { type: "brightness"; value: number }
  | { type: "mode"; value: "cool" | "heat" | "fan" } | { type: "setpoint"; celsius: number }
  | { type: "position"; percent: number };
type SnapshotBase = { simulation: true; revision: number };
export type DeviceSnapshot = SnapshotBase & (
  { id: "light"; power: boolean; brightness: number }
  | { id: "ac"; power: boolean; mode: "cool" | "heat" | "fan"; setpointC: number; roomTemperatureC: number }
  | { id: "curtain"; position: number; orientation: "0=closed;100=open" });
export type Fixtures = { [K in DeviceId]: Extract<DeviceSnapshot, { id: K }> };
export interface Intent {
  simulation: true; providerId: string; owner: string; epoch: string; deviceId: DeviceId;
  action: Action; before: DeviceSnapshot; createdAt: number; expiresAt: number; digest: string;
}
export interface Receipt {
  simulation: true; providerId: string; owner: string; epoch: string; operationId: string;
  intentDigest: string; deviceId: DeviceId; action: Action; phase: "accepted" | "applied" | "rejected"; state: DeviceSnapshot;
}
export type OperationStatus = "approved" | "dispatching" | "accepted" | "applied" | "unknown" | "rejected" | "cancelled";
export type OperationReason = "E_SIM_COMMAND_UNKNOWN" | "E_SIM_RECEIPT_INVALID" | "E_SIM_REJECTED" | "E_SIM_CANCELLED" | "E_SIM_RESTARTED";
export interface Operation {
  simulation: true; id: string; intent: Intent; status: OperationStatus; reason?: OperationReason;
  providerReceipt?: Receipt; verifiedReceipt?: Receipt;
}
export interface JournalState { version: 1; simulation: true; providerId: string; fixtures: Fixtures; operations: Operation[] }
export interface SessionGrant { owner: string; read: readonly DeviceId[]; actions?: Partial<Record<DeviceId, readonly Action["type"][]>> }

export const SIMULATION_LIMITS = Object.freeze({ previews: 32, previewTtlMs: 30_000, operations: 128, journalBytes: 1_048_576 });
export const DEVICE_IDS: readonly DeviceId[] = ["light", "ac", "curtain"];
export const ACTION_TYPES: Readonly<Record<DeviceId, readonly Action["type"][]>> = {
  light: ["power", "brightness"], ac: ["power", "mode", "setpoint"], curtain: ["position"],
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => typeof key === "string" && (required.includes(key) || optional.includes(key)));
}
export function isDeviceId(value: unknown): value is DeviceId { return DEVICE_IDS.includes(value as DeviceId); }
export function validOwner(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;
const percent = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
const setpoint = (value: unknown): value is number => finite(value) && value >= 16 && value <= 30 && Number.isInteger(value * 2);
const mode = (value: unknown): value is "cool" | "heat" | "fan" => value === "cool" || value === "heat" || value === "fan";

export function createFixtures(): Fixtures {
  return {
    light: { simulation: true, id: "light", revision: 0, power: false, brightness: 50 },
    ac: { simulation: true, id: "ac", revision: 0, power: false, mode: "cool", setpointC: 24, roomTemperatureC: 26 },
    curtain: { simulation: true, id: "curtain", revision: 0, position: 0, orientation: "0=closed;100=open" },
  };
}
export function normalizeAction(deviceId: unknown, value: unknown): Action {
  if (!isDeviceId(deviceId) || !isRecord(value)) throw new Error("E_SIM_ACTION");
  if ((deviceId === "light" || deviceId === "ac") && value.type === "power" && exactKeys(value, ["type", "on"]) && typeof value.on === "boolean") return { type: "power", on: value.on };
  if (deviceId === "light" && value.type === "brightness" && exactKeys(value, ["type", "value"]) && percent(value.value)) return { type: "brightness", value: value.value };
  if (deviceId === "ac" && value.type === "mode" && exactKeys(value, ["type", "value"]) && mode(value.value)) return { type: "mode", value: value.value };
  if (deviceId === "ac" && value.type === "setpoint" && exactKeys(value, ["type", "celsius"]) && setpoint(value.celsius)) return { type: "setpoint", celsius: value.celsius };
  if (deviceId === "curtain" && value.type === "position" && exactKeys(value, ["type", "percent"]) && percent(value.percent)) return { type: "position", percent: value.percent };
  throw new Error("E_SIM_ACTION");
}
function validSnapshot(value: unknown): value is DeviceSnapshot {
  if (!isRecord(value) || value.simulation !== true || !revision(value.revision)) return false;
  if (value.id === "light") return exactKeys(value, ["simulation", "id", "revision", "power", "brightness"]) && typeof value.power === "boolean" && percent(value.brightness);
  if (value.id === "ac") return exactKeys(value, ["simulation", "id", "revision", "power", "mode", "setpointC", "roomTemperatureC"]) && typeof value.power === "boolean" && mode(value.mode) && setpoint(value.setpointC) && finite(value.roomTemperatureC) && value.roomTemperatureC >= -100 && value.roomTemperatureC <= 100;
  return value.id === "curtain" && exactKeys(value, ["simulation", "id", "revision", "position", "orientation"]) && percent(value.position) && value.orientation === "0=closed;100=open";
}
export function applyAction(snapshot: DeviceSnapshot, action: Action): DeviceSnapshot {
  if (!validSnapshot(snapshot)) throw new Error("E_SIM_STATE");
  const normalized = normalizeAction(snapshot.id, action);
  const next = { ...snapshot, revision: snapshot.revision + 1 };
  if (next.id === "light") {
    if (normalized.type === "power") next.power = normalized.on;
    if (normalized.type === "brightness") next.brightness = normalized.value;
  } else if (next.id === "ac") {
    if (normalized.type === "power") next.power = normalized.on;
    if (normalized.type === "mode") next.mode = normalized.value;
    if (normalized.type === "setpoint") next.setpointC = normalized.celsius;
  } else if (normalized.type === "position") next.position = normalized.percent;
  if (!validSnapshot(next)) throw new Error("E_SIM_STATE");
  return next;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  return isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
export function intentDigest(intent: Omit<Intent, "digest">): string {
  return createHash("sha256").update(JSON.stringify(stable(intent))).digest("hex");
}
function validIntent(value: unknown, providerId: string): value is Intent {
  if (!isRecord(value) || !exactKeys(value, ["simulation", "providerId", "owner", "epoch", "deviceId", "action", "before", "createdAt", "expiresAt", "digest"])) return false;
  if (value.simulation !== true || value.providerId !== providerId || !validOwner(value.owner) || !uuid(value.epoch) || !isDeviceId(value.deviceId) || !validSnapshot(value.before) || value.before.id !== value.deviceId || !revision(value.createdAt) || value.expiresAt !== value.createdAt + SIMULATION_LIMITS.previewTtlMs) return false;
  try {
    if (!isDeepStrictEqual(normalizeAction(value.deviceId, value.action), value.action)) return false;
    const { digest, ...body } = value;
    return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) && intentDigest(body as Omit<Intent, "digest">) === digest;
  } catch { return false; }
}
export function validateReceipt(value: unknown, operation: Operation): Receipt {
  const intent = operation.intent;
  if (!isRecord(value) || !exactKeys(value, ["simulation", "providerId", "owner", "epoch", "operationId", "intentDigest", "deviceId", "action", "phase", "state"])
    || value.simulation !== true || value.providerId !== intent.providerId || value.owner !== intent.owner || value.epoch !== intent.epoch
    || value.operationId !== operation.id || value.intentDigest !== intent.digest || value.deviceId !== intent.deviceId
    || !isDeepStrictEqual(value.action, intent.action) || !["accepted", "applied", "rejected"].includes(value.phase as string)) throw new Error("E_SIM_RECEIPT_INVALID");
  const expected = value.phase === "applied" ? applyAction(intent.before, intent.action) : intent.before;
  if (!isDeepStrictEqual(value.state, expected)) throw new Error("E_SIM_RECEIPT_INVALID");
  // The owned fixture's durable result is independent of the transport reply.
  // An older accepted acknowledgement may arrive after completion; a final
  // result may never claim an effect absent from that provider record.
  if (operation.providerReceipt && value.phase !== "accepted" && !isDeepStrictEqual(value, operation.providerReceipt)) throw new Error("E_SIM_RECEIPT_INVALID");
  return structuredClone(value) as unknown as Receipt;
}
export function validJournal(value: unknown): value is JournalState {
  if (!isRecord(value) || !exactKeys(value, ["version", "simulation", "providerId", "fixtures", "operations"]) || value.version !== 1 || value.simulation !== true || !uuid(value.providerId)) return false;
  if (!isRecord(value.fixtures) || !exactKeys(value.fixtures, DEVICE_IDS) || !DEVICE_IDS.every(id => validSnapshot((value.fixtures as Record<string, unknown>)[id]) && (value.fixtures as Record<string, DeviceSnapshot>)[id].id === id)) return false;
  if (!Array.isArray(value.operations) || value.operations.length > SIMULATION_LIMITS.operations) return false;
  const ids = new Set<string>();
  return value.operations.every((op: unknown) => {
    if (!isRecord(op) || !exactKeys(op, ["simulation", "id", "intent", "status"], ["reason", "providerReceipt", "verifiedReceipt"]) || op.simulation !== true || !uuid(op.id) || ids.has(op.id) || !validIntent(op.intent, value.providerId as string)) return false;
    ids.add(op.id);
    if (!["approved", "dispatching", "accepted", "applied", "unknown", "rejected", "cancelled"].includes(op.status as string)) return false;
    if (Object.hasOwn(op, "reason") && !["E_SIM_COMMAND_UNKNOWN", "E_SIM_RECEIPT_INVALID", "E_SIM_REJECTED", "E_SIM_CANCELLED", "E_SIM_RESTARTED"].includes(op.reason as string)) return false;
    try {
      for (const key of ["providerReceipt", "verifiedReceipt"] as const) if (Object.hasOwn(op, key)) validateReceipt(op[key], op as unknown as Operation);
      if (["approved", "cancelled"].includes(op.status as string) && (op.providerReceipt || op.verifiedReceipt)) return false;
      if (["accepted", "applied", "rejected"].includes(op.status as string) && (!isRecord(op.verifiedReceipt) || op.verifiedReceipt.phase !== op.status)) return false;
      if (op.verifiedReceipt && !op.providerReceipt) return false;
      return true;
    } catch { return false; }
  });
}
