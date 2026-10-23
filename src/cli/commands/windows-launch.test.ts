import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Keep the real batch, bundled CLI, cmd shim and read-only RuntimeProfile preflight.
// Only Electron/service startup is replaced, so no real user configuration is read.
describe.runIf(process.platform === "win32")("Windows development launcher", () => {
  let root: string;
  let project: string;
  let isolation: string;
  let production: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-b1-"));
    project = path.join(root, "project with spaces");
    isolation = path.join(root, "explicit development root");
    production = path.join(root, "synthetic production");
    for (const dir of [project, isolation, production, path.join(project, "dist", "cli"), path.join(project, "node_modules", ".bin")]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}");
    fs.copyFileSync(path.resolve("start.bat"), path.join(project, "start.bat"));
    fs.copyFileSync(path.resolve("setup.bat"), path.join(project, "setup.bat"));
    buildSync({ entryPoints: [path.resolve("src/cli/index.ts")], bundle: true, platform: "node", format: "cjs", outfile: path.join(project, "dist/cli/index.js") });
    buildSync({ entryPoints: [path.resolve("src/main/runtime-profile.ts")], bundle: true, platform: "node", format: "cjs", outfile: path.join(project, "profile.cjs") });
    fs.writeFileSync(path.join(project, "electron.cjs"), `
      const { resolveRuntimeProfile } = require('./profile.cjs');
      try {
        const profile = resolveRuntimeProfile({ argv: process.argv.slice(2), env: process.env, isPackaged: false, productionAppData: process.env.APPDATA });
        console.log('PROFILE=' + JSON.stringify(profile));
        process.exit(Number(process.env.FIXTURE_EXIT || 0));
      } catch (error) { console.error(error.message); process.exit(23); }
    `);
    fs.writeFileSync(path.join(project, "node_modules/.bin/electron.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0..\\..\\electron.cjs" %*\r\n`);
    // Characterizes the old globally linked command too, without using npm link.
    fs.writeFileSync(path.join(project, "firefly.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0dist\\cli\\index.js" %*\r\n`);
  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function launch(args: string[] = [], overrides: Record<string, string> = {}, batch = true, script = "start.bat") {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^FIREFLY_/i.test(key)) delete env[key];
    Object.assign(env, { APPDATA: production, PATH: `${project};${path.dirname(process.execPath)};${process.env.PATH}`, ...overrides });
    const result = batch
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${path.join(project, script)}" ${args.map(arg => `"${arg}"`).join(" ")}"`], { env, cwd: root, encoding: "utf8", input: "\r\n", windowsVerbatimArguments: true })
      : spawnSync(process.execPath, [path.join(project, "dist/cli/index.js"), "run"], { env, cwd: project, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(fs.readdirSync(isolation)).toEqual([]);
    expect(fs.readdirSync(production)).toEqual([]);
    return { code: result.status, output: result.stdout + result.stderr };
  }
  function profile(output: string) { return JSON.parse(/PROFILE=(.+)/.exec(output)![1]); }

  it("refuses a fresh shell without choosing a data root and explains how to supply one", () => {
    const result = launch();
    expect(result.code).toBe(1);
    expect(result.output).toContain("FIREFLY_RUNTIME_ISOLATION_REQUIRED");
    expect(result.output).toContain("start.bat");
    expect(result.output).toContain("FIREFLY_ISOLATION_ROOT");
    expect(result.output).not.toContain("PROFILE=");
  });
  it("starts from a fresh shell with explicit isolation and spaces in both paths", () => {
    const result = launch([isolation]);
    expect(result.code, result.output).toBe(0);
    expect(profile(result.output).userData).toBe(path.join(fs.realpathSync.native(isolation), "Firefly-development"));
  });
  it("preserves an existing explicit environment root", () => {
    const result = launch([], { FIREFLY_ISOLATION_ROOT: isolation, FIREFLY_RUNTIME_PROFILE: "production" });
    expect(result.code, result.output).toBe(0);
    expect(profile(result.output).kind).toBe("development");
  });
  it("lets a supplied root override the environment only for this launch", () => {
    fs.writeFileSync(path.join(project, "caller.cmd"), '@echo off\r\ncall "%~dp0start.bat" %*\r\nset "CALLER_EXIT=%errorlevel%"\r\necho CALLER_ROOT=%FIREFLY_ISOLATION_ROOT%\r\nexit /b %CALLER_EXIT%\r\n');
    const result = launch([isolation], { FIREFLY_ISOLATION_ROOT: production }, true, "caller.cmd");
    expect(result.code, result.output).toBe(0);
    expect(profile(result.output).appData).toBe(fs.realpathSync.native(isolation));
    expect(result.output).toContain(`CALLER_ROOT=${production}`);
  });
  it("retains legacy explicit isolation without switching to a production identity", () => {
    const result = launch([], { FIREFLY_ISOLATED_SMOKE_APPDATA: isolation });
    expect(result.code, result.output).toBe(0);
    expect(profile(result.output).kind).toBe("development");
  });
  it("propagates the desktop child's nonzero exit", () => {
    const result = launch([isolation], { FIXTURE_EXIT: "17" });
    expect(result.code, result.output).toBe(17);
    expect(result.output).toContain("17");
  });
  it("rejects extra positional arguments instead of silently ignoring them", () => {
    const result = launch([isolation, "extra"]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).not.toContain("PROFILE=");
  });
  it("uses the checkout CLI even when a different global firefly command exists", () => {
    const command = path.join(project, "firefly.cmd");
    const original = fs.readFileSync(command);
    fs.writeFileSync(command, "@echo off\r\nexit /b 91\r\n");
    try {
      const result = launch([isolation]);
      expect(result.code, result.output).toBe(0);
      expect(profile(result.output).kind).toBe("development");
    } finally { fs.writeFileSync(command, original); }
  });
  it("returns a failure when the checkout CLI has not been built", () => {
    const cli = path.join(project, "dist/cli/index.js");
    const original = fs.readFileSync(cli);
    fs.unlinkSync(cli);
    try {
      const result = launch([isolation]);
      expect(result.code, result.output).toBe(1);
      expect(result.output).not.toContain("PROFILE=");
    } finally { fs.writeFileSync(cli, original); }
  });
  it("explains the explicit isolation contract after setup without installing or linking anything", () => {
    // cmd resolves this current-directory stub before any real npm on PATH.
    fs.writeFileSync(path.join(project, "npm.cmd"), "@echo off\r\nexit /b 0\r\n");
    const result = launch([], {}, true, "setup.bat");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Setup complete");
    expect(result.output).toContain('start.bat "isolation directory"');
    expect(result.output).toContain("FIREFLY_ISOLATION_ROOT");
  });
  it("propagates an Electron executable resolution failure without writing profile data", () => {
    const shim = path.join(project, "node_modules/.bin/electron.cmd");
    const original = fs.readFileSync(shim);
    fs.unlinkSync(shim);
    try {
      const result = launch([isolation], { FIREFLY_ELECTRON_BIN: path.join(root, "missing-electron.exe") });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("failed to spawn electron");
    } finally { fs.writeFileSync(shim, original); }
  });
  it.each(["relative", "missing", "production"])("keeps preflight rejection for %s roots", kind => {
    const value = kind === "relative" ? "relative" : kind === "missing" ? path.join(root, "missing") : production;
    const result = launch([value]);
    expect(result.code, result.output).toBe(23);
    expect(result.output).toContain(kind === "production" ? "FIREFLY_RUNTIME_PRODUCTION_OVERLAP" : "FIREFLY_RUNTIME_ISOLATION_INVALID");
  });
  it("keeps CLI development isolation mandatory in a fresh shell", () => {
    const result = launch([], {}, false);
    expect(result.code, result.output).toBe(23);
    expect(result.output).toContain("FIREFLY_RUNTIME_ISOLATION_REQUIRED");
  });
  it("returns CLI child failures even when the Electron shim path has spaces", () => {
    const result = launch([], { FIREFLY_ISOLATION_ROOT: isolation, FIXTURE_EXIT: "17" }, false);
    expect(result.code, result.output).toBe(17);
  });
});
