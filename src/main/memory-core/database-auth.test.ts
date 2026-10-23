import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDatabaseAuth } from "./database-auth";
import { sealPayload } from "./payload-codec";
let root: string, database: string;
const key = Buffer.alloc(32, 7);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-auth-unit-")); database = path.join(root, "nested", "memory.sqlite");
  // Unit-test publication and validation, leaving native hard-link atomicity to storage integration tests.
  vi.spyOn(fs, "linkSync").mockImplementation((source, target) => fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it("creates and reuses authentication without creating the database", () => {
  const id = ensureDatabaseAuth(database, key), bytes = fs.readFileSync(database + ".auth");
  expect(id).toMatch(/^[a-f0-9]{32}$/); expect(ensureDatabaseAuth(database, key)).toBe(id);
  expect(fs.readFileSync(database + ".auth")).toEqual(bytes);
  expect(fs.existsSync(database)).toBe(false); expect(fs.existsSync(database + ".auth.pending")).toBe(false);
});
it.each(["", "-wal", "-shm"])("refuses existing unauthenticated database state %j", suffix => {
  fs.mkdirSync(path.dirname(database)); fs.writeFileSync(database + suffix, "existing");
  expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_AUTH_UNAVAILABLE$/);
  expect(fs.existsSync(database + ".auth")).toBe(false);
});
it.each([Buffer.alloc(0), Buffer.alloc(67), Buffer.alloc(257), Buffer.alloc(80)])("rejects malformed authentication of length $length", bytes => {
  fs.mkdirSync(path.dirname(database)); fs.writeFileSync(database + ".auth", bytes);
  expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_AUTH_INVALID$/);
});
it.each([4, 8])("rejects unsupported version at offset %s", offset => {
  ensureDatabaseAuth(database, key); const bytes = fs.readFileSync(database + ".auth"); bytes.writeUInt32LE(2, offset); fs.writeFileSync(database + ".auth", bytes);
  expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_SCHEMA_UNSUPPORTED$/);
});
it("rejects a directory in place of an auth file", () => {
  fs.mkdirSync(database + ".auth", { recursive: true }); expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_AUTH_INVALID$/);
});
it("rejects a different key and tampered ciphertext", () => {
  ensureDatabaseAuth(database, key); expect(() => ensureDatabaseAuth(database, Buffer.alloc(32, 9))).toThrow(/^MEMORY_AUTH_FAILED$/);
  const bytes = fs.readFileSync(database + ".auth"); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(database + ".auth", bytes);
  expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_AUTH_FAILED$/);
});
it("rejects an authenticated but incorrect marker", () => {
  const id = ensureDatabaseAuth(database, key), header = fs.readFileSync(database + ".auth").subarray(0, 28);
  fs.writeFileSync(database + ".auth", Buffer.concat([header, sealPayload(key, { recordType: "database-auth", id, schemaVersion: 1, keyVersion: 1 }, Buffer.from("wrong marker"))]));
  expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_AUTH_FAILED$/);
});
it("recovers a validated pending publication", () => {
  const id = ensureDatabaseAuth(database, key); fs.copyFileSync(database + ".auth", database + ".auth.pending"); fs.unlinkSync(database + ".auth");
  expect(ensureDatabaseAuth(database, key)).toBe(id); expect(fs.existsSync(database + ".auth.pending")).toBe(false);
});
it("cleans up identical pending publication", () => {
  const id = ensureDatabaseAuth(database, key); fs.copyFileSync(database + ".auth", database + ".auth.pending");
  expect(ensureDatabaseAuth(database, key)).toBe(id); expect(fs.existsSync(database + ".auth.pending")).toBe(false);
});
it("retains conflicting valid publications for diagnosis", () => {
  ensureDatabaseAuth(database, key); const other = path.join(root, "other.sqlite"); ensureDatabaseAuth(other, key);
  fs.copyFileSync(other + ".auth", database + ".auth.pending");
  expect(() => ensureDatabaseAuth(database, key)).toThrow(/^MEMORY_AUTH_PUBLICATION_CONFLICT$/);
  expect(fs.existsSync(database + ".auth.pending")).toBe(true);
});
