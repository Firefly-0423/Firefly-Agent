import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ args: [] as string[], env: {} as Record<string, string | undefined> }));
vi.mock("../util/resolve-electron.js", () => ({ resolveElectron: () => "fixture-electron" }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return { spawn: (_command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    fake.args = args; fake.env = options.env;
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 0));
    return child;
  } };
});
const originalCwd = process.cwd();
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); process.chdir(originalCwd); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("launches the run command with explicit development identity and inherited explicit isolation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-cli-profile-")); roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), "{}"); process.chdir(root);
  vi.stubEnv("FIREFLY_ISOLATION_ROOT", path.join(root, "elsewhere"));
  const { runFireflyRun } = await import("./run");
  expect(await runFireflyRun()).toEqual({ kind: "ok", code: 0 });
  expect(fake.args).toEqual([".", "--firefly-profile=development"]);
  expect(fake.env.FIREFLY_ISOLATION_ROOT).toBe(path.join(root, "elsewhere"));
  expect(fs.readdirSync(root)).toEqual(["package.json"]);
});
it("without explicit isolation keeps the data in the checkout's output/development-profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-cli-profile-")); roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), "{}"); process.chdir(root);
  vi.stubEnv("FIREFLY_ISOLATION_ROOT", ""); vi.stubEnv("FIREFLY_ISOLATED_SMOKE_APPDATA", "");
  const { runFireflyRun } = await import("./run");
  expect(await runFireflyRun()).toEqual({ kind: "ok", code: 0 });
  const isolation = path.join(process.cwd(), "output", "development-profile");
  expect(fake.args).toEqual([".", "--firefly-profile=development"]);
  expect(fake.env.FIREFLY_ISOLATION_ROOT).toBe(isolation);
  expect(fs.statSync(isolation).isDirectory()).toBe(true);
});
