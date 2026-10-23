import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultMemoryStore } from "./memory-store-defaults";

const electron = vi.hoisted(() => ({ root: "" }));
const exporter = vi.hoisted(() => ({ notifyMemoryChanged: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => electron.root } }));
vi.mock("./obsidian-exporter", () => exporter);
// Native fs named exports are cached independently of the default object.
// Forward writes through the live syscall surface so fault injection reaches
// both the legacy writer and AtomicJsonStore, rather than just the trace sink.
vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => actual.default.writeFileSync(...args) };
});
const roots: string[] = [];
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  const parent = path.resolve("output", "pmrs-durability");
  fs.mkdirSync(parent, { recursive: true });
  electron.root = fs.mkdtempSync(path.join(parent, "fixture-"));
  roots.push(electron.root);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const file = path.join(electron.root, "memory.json");
  const previous = createDefaultMemoryStore(); previous.l0.preferredName = "previous generation";
  const current = structuredClone(previous); current.l0.preferredName = "current generation";
  const previousBytes = JSON.stringify(previous, null, 2);
  const currentBytes = JSON.stringify(current, null, 2);
  fs.writeFileSync(file, currentBytes);
  fs.writeFileSync(`${file}.bak`, previousBytes);
  const { memoryStore } = await import("./memory-store");
  expect(await memoryStore.load()).toEqual(current);
  return { file, current, previous, currentBytes, previousBytes, memoryStore };
}
async function coldStore() {
  vi.resetModules();
  return (await import("./memory-store")).memoryStore;
}

describe("production PMRS persistence durability", () => {
  it.each(["partial-primary-write", "primary-ENOSPC", "flush", "backup-ENOSPC", "backup-replace", "primary-replace"]) (
    "retains valid memory after %s and a cold load, reporting save failure",
    async failure => {
      const f = await fixture();
      const write = fs.writeFileSync.bind(fs);
      const rename = fs.renameSync.bind(fs);
      const diskError = () => Object.assign(new Error("synthetic persistence failure"), { code: failure.includes("replace") ? "EPERM" : "ENOSPC" });
      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
        if (!String(target).includes("memory.json")) return write(target, data, options);
        const backup = String(target).endsWith(".backup");
        if ((failure === "partial-primary-write" || failure === "flush") && !backup) {
          write(target, failure === "flush" ? data : '{"schemaVersion":', options);
          throw diskError();
        }
        if ((failure === "primary-ENOSPC" && !backup) || (failure === "backup-ENOSPC" && backup)) throw diskError();
        write(target, data, options);
      });
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if ((failure === "primary-replace" && to === f.file) || (failure === "backup-replace" && to === `${f.file}.bak`)) throw diskError();
        rename(from, to);
      });
      await expect(f.memoryStore.upsertL0Field("preferredName", "unsaved generation")).rejects.toThrow();
      writeSpy.mockRestore(); renameSpy.mockRestore();
      expect(fs.readFileSync(f.file, "utf8")).toBe(f.currentBytes);
      const backup = failure === "primary-replace" ? f.currentBytes : f.previousBytes;
      expect(fs.readFileSync(`${f.file}.bak`, "utf8")).toBe(backup);
      expect(await (await coldStore()).load()).toEqual(f.current);
      expect(fs.readdirSync(electron.root).sort()).toEqual(["memory.json", "memory.json.bak"]);
      expect(exporter.notifyMemoryChanged).not.toHaveBeenCalled();
    },
  );
  it("writes schema 2 unchanged, preserving exactly the prior valid generation for explicit recovery", async () => {
    const f = await fixture();
    await f.memoryStore.upsertL0Field("preferredName", "saved generation");
    expect(await (await coldStore()).load()).toEqual({ ...f.current, l0: { ...f.current.l0, preferredName: "saved generation", updatedAt: expect.any(Number) } });
    expect(fs.readFileSync(`${f.file}.bak`, "utf8")).toBe(f.currentBytes);
    const { readMemoryFile } = await import("./memory-store-io");
    expect(readMemoryFile(`${f.file}.bak`)).toEqual(f.current);
    expect(fs.readdirSync(electron.root).filter(name => name.includes(".tmp"))).toEqual([]);
  });
  it.each(['{damaged', '{"schemaVersion":1,"l0":{}}']) (
    "blocks cold-load and save on damaged/unsupported source (%s), leaving recovery data intact",
    async damaged => {
      const f = await fixture();
      await f.memoryStore.upsertL0Field("preferredName", "saved generation");
      fs.writeFileSync(f.file, damaged);
      const cold = await coldStore();
      await expect(cold.load()).rejects.toThrow("MEMORY_STORE_READ_FAILED");
      await expect(cold.save(f.current)).rejects.toThrow("MEMORY_STORE_READ_FAILED");
      expect(fs.readFileSync(f.file, "utf8")).toBe(damaged);
      expect(fs.readFileSync(`${f.file}.bak`, "utf8")).toBe(f.currentBytes);
      // Recovery is explicit, from the retained schema-2 bytes; no auto overwrite.
      const { readMemoryFile } = await import("./memory-store-io");
      expect(readMemoryFile(`${f.file}.bak`)).toEqual(f.current);
    },
  );
  it("refuses to overwrite source corruption introduced after the manager cached a valid store", async () => {
    const f = await fixture();
    fs.writeFileSync(f.file, "{externally damaged");
    await expect(f.memoryStore.upsertL0Field("preferredName", "must not overwrite")).rejects.toThrow();
    expect(fs.readFileSync(f.file, "utf8")).toBe("{externally damaged");
    expect(fs.readFileSync(`${f.file}.bak`, "utf8")).toBe(f.previousBytes);
  });
  it("does not write an invalid new store over a valid current generation", async () => {
    const f = await fixture();
    await expect(f.memoryStore.save({ ...f.current, schemaVersion: 1 })).rejects.toThrow();
    expect(await (await coldStore()).load()).toEqual(f.current);
    expect(fs.readFileSync(`${f.file}.bak`, "utf8")).toBe(f.previousBytes);
  });
});
