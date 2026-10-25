import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonStore } from "./atomic-json-store";

const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-atomic-json-")); roots.push(root); return { root, file: path.join(root, "config.json") }; }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function store(file: string) {
  return new AtomicJsonStore<unknown>(file, (value) => !!value && typeof value === "object" && typeof (value as { value?: unknown }).value === "number");
}
describe("AtomicJsonStore", () => {
  it("rejects a value whose serialized shape differs before touching valid data", () => {
    const { file, root } = fixture(); const json = store(file); json.write({ value: 1 });
    expect(() => json.write({ value: 2, toJSON: () => ({ value: "invalid" }) })).toThrow("ATOMIC_JSON_SHAPE_INVALID");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ value: 1 });
    expect(fs.readdirSync(root)).toEqual(["config.json"]);
  });
  it("reads absent files without writing and validates incoming shapes", () => {
    const { file, root } = fixture(); const json = store(file);
    expect(json.read({ value: 0 })).toEqual({ value: 0 });
    expect(() => json.write({ value: "wrong" })).toThrow("ATOMIC_JSON_SHAPE_INVALID");
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("atomically replaces data and retains exactly one previous valid backup", () => {
    const { file, root } = fixture(); const json = store(file);
    json.write({ value: 1 }); json.write({ value: 2 }); json.write({ value: 3 });
    expect(json.read({ value: 0 })).toEqual({ value: 3 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ value: 2 });
    expect(fs.readdirSync(root).sort()).toEqual(["config.json", "config.json.bak"]);
  });
  it("preserves old valid data on temporary write failure", () => {
    const { file, root } = fixture(); const json = store(file); json.write({ value: 1 });
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("injected temp failure"); });
    expect(() => json.write({ value: 2 })).toThrow("ATOMIC_JSON_WRITE_FAILED");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ value: 1 });
    expect(fs.readdirSync(root)).toEqual(["config.json"]);
  });
  it.each(["backup-write", "backup-replace", "flush"])("preserves current data and bounded backup on %s failure", (failure) => {
    const { file, root } = fixture(); const json = store(file); json.write({ value: 1 }); json.write({ value: 2 });
    const write = fs.writeFileSync.bind(fs); const rename = fs.renameSync.bind(fs);
    if (failure === "backup-write") vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (String(target).endsWith(".backup")) throw new Error("injected backup write failure");
      write(target, data, options);
    });
    if (failure === "backup-replace") vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === `${file}.bak`) throw new Error("injected backup replace failure");
      rename(from, to);
    });
    // Node's flush invokes internal fsync, so inject its failure at the write boundary.
    if (failure === "flush") vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      expect(options).toHaveProperty("flush", true);
      write(target, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
      throw new Error("injected flush failure");
    });
    expect(() => json.write({ value: 3 })).toThrow("ATOMIC_JSON_WRITE_FAILED");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ value: 2 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ value: 1 });
    expect(fs.readdirSync(root).sort()).toEqual(["config.json", "config.json.bak"]);
  });
  it("preserves old valid data on primary replacement failure and cleans temporary files", () => {
    const { file, root } = fixture(); const json = store(file); json.write({ value: 1 });
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === file) throw new Error("injected replace failure"); rename(from, to); });
    expect(() => json.write({ value: 2 })).toThrow("ATOMIC_JSON_WRITE_FAILED");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ value: 1 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ value: 1 });
    expect(fs.readdirSync(root).sort()).toEqual(["config.json", "config.json.bak"]);
  });
  it.each(["{malformed", '{"value":"bad"}'])("refuses to overwrite malformed existing JSON or invalid shape (%s)", (original) => {
    const { file } = fixture(); fs.writeFileSync(file, original); const json = store(file);
    expect(() => json.read({ value: 0 })).toThrow("ATOMIC_JSON_EXISTING_INVALID");
    expect(() => json.write({ value: 2 })).toThrow("ATOMIC_JSON_EXISTING_INVALID");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});
