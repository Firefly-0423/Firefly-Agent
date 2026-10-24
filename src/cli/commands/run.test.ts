import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ args: [] as string[] }));
vi.mock("../util/resolve-electron.js", () => ({ resolveElectron: () => "fixture-electron" }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return { spawn: (_command: string, args: string[]) => {
    fake.args = args;
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 0));
    return child;
  } };
});
const originalCwd = process.cwd();
const roots: string[] = [];
afterEach(() => { process.chdir(originalCwd); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("launches the existing run command with explicit development identity and inherited explicit isolation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-cli-profile-")); roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), "{}"); process.chdir(root);
  const { runFireflyRun } = await import("./run");
  expect(await runFireflyRun()).toEqual({ kind: "ok", code: 0 });
  expect(fake.args).toContain("--firefly-profile=development");
  expect(fs.readdirSync(root)).toEqual(["package.json"]);
});
