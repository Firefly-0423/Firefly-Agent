import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPluginStorage } from "./storage";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "plugin-persistence-contract-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

it("persists structured values and exposes its configured data directory", () => {
  const storage = createPluginStorage(directory);
  storage.set("preferences", { theme: "night", revision: 4 });
  expect(storage.get("preferences")).toStrictEqual({ theme: "night", revision: 4 });
  expect(createPluginStorage(directory).get("preferences")).toStrictEqual({ theme: "night", revision: 4 });
  expect(storage.get("unwritten")).toBeUndefined();
  expect(storage.rootDir()).toEqual(directory);
});

it("rejects path traversal and directory separators in storage keys", () => {
  const storage = createPluginStorage(directory);
  expect(() => storage.set("../escape", 9)).toThrow(/非法存储 key/);
  expect(() => storage.get("nested/key")).toThrow(/非法存储 key/);
});
