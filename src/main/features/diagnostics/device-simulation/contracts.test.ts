import { describe, expect, it } from "vitest";
import { applyAction, createFixtures, intentDigest, normalizeAction, validateReceipt, validJournal, type Intent, type Operation } from "./contracts";

const epoch = "11111111-1111-4111-8111-111111111111";
export function operation(): Operation {
  const body = { simulation: true as const, providerId: epoch, owner: "test-owner", epoch,
    deviceId: "light" as const, action: { type: "power" as const, on: true },
    before: createFixtures().light, createdAt: 1000, expiresAt: 31000 };
  const intent: Intent = { ...body, digest: intentDigest(body) };
  return { simulation: true, id: "22222222-2222-4222-8222-222222222222", intent, status: "dispatching" };
}

describe("simulated device contracts", () => {
  it("has three detached fixtures with explicit AC and curtain semantics", () => {
    const fixtures = createFixtures();
    expect(fixtures.light).toEqual({ simulation: true, id: "light", revision: 0, power: false, brightness: 50 });
    expect(fixtures.ac).toEqual({ simulation: true, id: "ac", revision: 0, power: false, mode: "cool", setpointC: 24, roomTemperatureC: 26 });
    expect(fixtures.curtain).toEqual({ simulation: true, id: "curtain", revision: 0, position: 0, orientation: "0=closed;100=open" });
    fixtures.light.revision = 99;
    expect(createFixtures().light.revision).toBe(0);
  });

  it.each([
    ["light", { type: "power", on: true }], ["light", { type: "brightness", value: 0 }],
    ["light", { type: "brightness", value: 100 }], ["ac", { type: "power", on: false }],
    ["ac", { type: "mode", value: "fan" }], ["ac", { type: "setpoint", celsius: 16 }],
    ["ac", { type: "setpoint", celsius: 30 }], ["ac", { type: "setpoint", celsius: 22.5 }],
    ["curtain", { type: "position", percent: 0 }], ["curtain", { type: "position", percent: 100 }],
  ])("accepts the exact allowed %s action %j", (id, value) => {
    expect(normalizeAction(id, value)).toEqual(value);
    expect(normalizeAction(id, value)).not.toBe(value);
  });

  it.each([
    ["unknown", { type: "power", on: true }], ["light", { type: "power", on: "true" }],
    ["light", { type: "brightness", value: 1.5 }], ["light", { type: "brightness", value: 101 }],
    ["light", { type: "brightness", value: -1 }], ["ac", { type: "setpoint", celsius: 22.1 }],
    ["ac", { type: "setpoint", celsius: 31 }], ["ac", { type: "setpoint", celsius: NaN }],
    ["ac", { type: "setpoint", celsius: Infinity }], ["ac", { type: "mode", value: "turbo" }],
    ["curtain", { type: "position", percent: "40" }], ["curtain", { type: "position", percent: 101 }],
    ["light", { type: "position", percent: 20 }], ["light", { type: "power", on: true, approved: true }],
    ["ac", null], ["ac", []],
  ])("rejects invalid %s action %j", (id, value) => expect(() => normalizeAction(id, value)).toThrow("E_SIM_ACTION"));

  it("changes AC target without claiming current room temperature changed", () => {
    const before = createFixtures().ac;
    expect(applyAction(before, { type: "setpoint", celsius: 20 })).toMatchObject({ revision: 1, setpointC: 20, roomTemperatureC: 26 });
    expect(before).toMatchObject({ revision: 0, setpointC: 24 });
  });

  it("binds closed receipts to the exact intent and applied state", () => {
    const op = operation();
    const receipt = { simulation: true, providerId: epoch, owner: "test-owner", epoch, operationId: op.id,
      intentDigest: op.intent.digest, deviceId: "light", action: op.intent.action, phase: "applied",
      state: applyAction(op.intent.before, op.intent.action) };
    expect(validateReceipt(receipt, op)).toEqual(receipt);
    for (const patch of [{ owner: "other" }, { epoch: "33333333-3333-4333-8333-333333333333" },
      { providerId: "33333333-3333-4333-8333-333333333333" }, { operationId: epoch },
      { deviceId: "ac" }, { intentDigest: "0".repeat(64) }, { action: { type: "power", on: false } },
      { state: op.intent.before }, { approved: true }, { simulation: false }]) {
      expect(() => validateReceipt({ ...receipt, ...patch }, op)).toThrow("E_SIM_RECEIPT_INVALID");
    }
    expect(() => validateReceipt(null, op)).toThrow("E_SIM_RECEIPT_INVALID");
    expect(() => validateReceipt({ ...receipt, phase: "accepted" }, op)).toThrow("E_SIM_RECEIPT_INVALID");
    expect(validateReceipt({ ...receipt, phase: "accepted", state: op.intent.before }, op).phase).toBe("accepted");
  });

  it("rejects changed intent digests, duplicate operations and unknown journal fields", () => {
    const op = operation();
    const state = { version: 1, simulation: true, providerId: epoch, fixtures: createFixtures(), operations: [op] };
    expect(validJournal(state)).toBe(true);
    expect(validJournal({ ...state, operations: [op, op] })).toBe(false);
    expect(validJournal({ ...state, credentials: "forbidden" })).toBe(false);
    expect(validJournal({ ...state, operations: [{ ...op, intent: { ...op.intent, owner: "changed" } }] })).toBe(false);
    expect(validJournal({ ...state, fixtures: { ...state.fixtures, camera: {} } })).toBe(false);
  });

  it("rejects verified application that contradicts its own provider journal", () => {
    const op = operation();
    const accepted = { simulation: true as const, providerId: epoch, owner: op.intent.owner, epoch,
      operationId: op.id, intentDigest: op.intent.digest, deviceId: "light" as const, action: op.intent.action,
      phase: "accepted" as const, state: op.intent.before };
    const applied = { ...accepted, phase: "applied" as const, state: applyAction(op.intent.before, op.intent.action) };
    expect(validJournal({ version: 1, simulation: true, providerId: epoch, fixtures: createFixtures(),
      operations: [{ ...op, status: "applied", providerReceipt: accepted, verifiedReceipt: applied }] })).toBe(false);
  });
});
