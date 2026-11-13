import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRuntimeProfile } from "./runtime-profile";

// A source checkout starts with plain `npm run dev` / `npm start`; the launcher, not the reader, supplies the
// isolation root. Whatever the README says, an unpackaged launch must never resolve to the production data.
const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
async function launcher() {
  return await import(pathToFileURL(path.resolve("scripts/dev/launch-electron.mjs")).href) as {
    DEFAULT_ISOLATION: string;
    launchPlan(input: { repoRoot: string; env: Record<string, string | undefined>; vite: boolean }): { args: string[]; env: Record<string, string | undefined> };
  };
}

describe("runtime profile startup documentation", () => {
  it.each(["README.md", "README.en.md"])("%s starts from source with plain npm commands", (file) => {
    const source = fs.readFileSync(path.resolve(file), "utf8");
    expect(source).toMatch(/npm ci\r?\nnpm run dev\r?\n```/);
    expect(source).not.toContain("$env:FIREFLY_RUNTIME_PROFILE");
    expect(source).not.toContain("$env:FIREFLY_ISOLATION_ROOT");
    expect(source).not.toMatch(/开发与构建实例使用同一正式数据身份|Development and built instances share the production data identity/);
  });
  it("npm run dev and npm start both go through the launcher", () => {
    expect(pkg.scripts.dev).toContain("node scripts/dev/launch-electron.mjs --vite");
    expect(pkg.scripts.start).toBe("node scripts/dev/launch-electron.mjs");
  });
  it.each([{ vite: true }, { vite: false }])("the launcher's arguments resolve to an isolated development profile (vite: $vite)", async ({ vite }) => {
    const { DEFAULT_ISOLATION, launchPlan } = await launcher();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-start-docs-"));
    const repoRoot = path.join(root, "repo"), productionAppData = path.join(root, "production");
    fs.mkdirSync(repoRoot); fs.mkdirSync(productionAppData);
    try {
      const plan = launchPlan({ repoRoot, env: {}, vite });
      const resolved = resolveRuntimeProfile({ argv: plan.args, env: plan.env, isPackaged: false, productionAppData });
      expect(resolved.kind).toBe("development");
      expect(resolved.userData).toBe(path.join(fs.realpathSync.native(path.join(repoRoot, DEFAULT_ISOLATION)), "Firefly-development"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("an explicit FIREFLY_ISOLATION_ROOT still decides where the data goes", async () => {
    const { launchPlan } = await launcher();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-start-docs-"));
    const repoRoot = path.join(root, "repo"), elsewhere = path.join(root, "elsewhere"), productionAppData = path.join(root, "production");
    for (const dir of [repoRoot, elsewhere, productionAppData]) fs.mkdirSync(dir);
    try {
      const plan = launchPlan({ repoRoot, env: { FIREFLY_ISOLATION_ROOT: elsewhere }, vite: false });
      const resolved = resolveRuntimeProfile({ argv: plan.args, env: plan.env, isPackaged: false, productionAppData });
      expect(resolved.userData).toBe(path.join(fs.realpathSync.native(elsewhere), "Firefly-development"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
