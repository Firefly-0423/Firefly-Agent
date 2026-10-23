import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageContext } from "../storage-context";
import { resolveRuntimeProfile, within } from "../runtime-profile";
import { SimulationJournal } from "./journal";
import { createFixtures, type JournalState } from "./contracts";

const roots: string[] = [];
const journals: SimulationJournal[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-device-journal-")); roots.push(root);
  const isolated = path.join(root, "isolated"); fs.mkdirSync(isolated);
  const context = createStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", `--firefly-isolation-root=${isolated}`], env: {}, isPackaged: false, productionAppData: path.join(root, "production") }));
  const directory = path.join(context.stateRoot, "device-simulation");
  const file = path.join(directory, "journal.json");
  const state: JournalState = { version: 1, simulation: true, providerId: "11111111-1111-4111-8111-111111111111", fixtures: createFixtures(), operations: [] };
  return { root, isolated, context, directory, file, state };
}
function open(context: ReturnType<typeof createStorageContext>) { const journal = new SimulationJournal(context); journals.push(journal); return journal; }
afterEach(() => {
  for (const journal of journals.splice(0)) { try { journal.close(); } catch { /* hostile fixture lease is intentionally retained */ } }
  for (const root of roots.splice(0)) {
    if (!within(os.tmpdir(), root) || !path.basename(root).startsWith("firefly-device-journal-")) throw new Error("unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("simulation journal ownership", () => {
  it.each(["production", "development"] as const)("refuses %s before creating a simulator directory", (kind) => {
    const setupState = setup();
    const altered = { ...setupState.context, profile: { ...setupState.context.profile, kind } };
    expect(() => open(altered)).toThrow("E_SIM_PROFILE");
    expect(fs.existsSync(setupState.directory)).toBe(false);
  });

  it("requires an isolation root before writes", () => {
    const { context, directory } = setup();
    expect(() => open({ ...context, profile: { ...context.profile, isolationRoot: undefined } })).toThrow("E_SIM_PROFILE");
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("writes fixed paths, valid backup and reloads only after lease release", () => {
    const { context, file, state } = setup();
    const first = open(context);
    expect(first.read(state)).toEqual(state);
    expect(fs.existsSync(file)).toBe(false);
    first.write(state);
    expect(() => open(context)).toThrow("E_SIM_BUSY");
    const next = { ...state, fixtures: { ...state.fixtures, light: { ...state.fixtures.light, revision: 1, power: true } } };
    first.write(next);
    expect(JSON.parse(fs.readFileSync(file + ".bak", "utf8"))).toEqual(state);
    first.close();
    expect(open(context).read(state)).toEqual(next);
  });

  it("preserves corrupt existing bytes and releases failed-open ownership", () => {
    const { context, directory, file, state } = setup();
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, "not-json");
    const journal = open(context);
    expect(() => journal.read(state)).toThrow("E_SIM_JOURNAL_INVALID");
    expect(() => journal.write(state)).toThrow("E_SIM_JOURNAL_INVALID");
    expect(fs.readFileSync(file, "utf8")).toBe("not-json");
  });

  it.each(["read", "write"] as const)("refuses %s after a materialized journal disappears without recreating it", action => {
    const { context, file, state } = setup(); const journal = open(context);
    journal.write(state); const original = fs.readFileSync(file); fs.renameSync(file, file + ".moved");
    expect(() => journal[action](state)).toThrow("E_SIM_JOURNAL_INVALID");
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(file + ".moved")).toEqual(original);
  });

  it("refuses a missing primary with a remaining backup after reopening", () => {
    const { context, file, state } = setup(); const first = open(context);
    first.write(state); first.write(state); first.close();
    const backup = fs.readFileSync(file + ".bak"); fs.renameSync(file, file + ".moved");
    expect(() => open(context).read(state)).toThrow("E_SIM_JOURNAL_INVALID");
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(file + ".bak")).toEqual(backup);
  });

  it("rejects oversized data and does not overwrite it", () => {
    const { context, directory, file, state } = setup();
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, " ".repeat(1_048_577));
    const journal = open(context);
    expect(() => journal.read(state)).toThrow("E_SIM_JOURNAL_INVALID");
    expect(() => journal.write(state)).toThrow("E_SIM_JOURNAL_INVALID");
    expect(fs.statSync(file).size).toBe(1_048_577);
  });

  it("rejects a directory junction escaping the isolated profile", () => {
    const { context, directory, root } = setup();
    const outside = path.join(root, "outside"); fs.mkdirSync(outside);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
    expect(() => open(context)).toThrow("E_SIM_PATH");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects a hardlinked journal and backup before replacing shared bytes", () => {
    for (const suffix of ["", ".bak"]) {
      const { context, directory, file, state, root } = setup();
      fs.mkdirSync(directory, { recursive: true });
      const outside = path.join(root, "shared.json"); fs.writeFileSync(outside, JSON.stringify(state));
      fs.linkSync(outside, file + suffix);
      expect(() => open(context)).toThrow("E_SIM_PATH");
      expect(JSON.parse(fs.readFileSync(outside, "utf8"))).toEqual(state);
    }
  });

  it("refuses a pre-existing lease without deleting or adopting it", () => {
    const { context, directory } = setup();
    fs.mkdirSync(directory, { recursive: true });
    const lease = path.join(directory, "session.lock"); fs.writeFileSync(lease, "stale-or-foreign");
    expect(() => open(context)).toThrow("E_SIM_BUSY");
    expect(fs.readFileSync(lease, "utf8")).toBe("stale-or-foreign");
  });
});
