import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeProfile, applyElectronPaths, assertRuntimePathsOwned } from "./runtime-profile";
import { createStorageContext, getStorageContext } from "./storage-context";

const roots: string[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-profile-test-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function input(profile: string, isolationRoot?: string) {
  const productionAppData = temporary();
  return { argv: [`--firefly-profile=${profile}`, ...(isolationRoot === undefined ? [] : [`--firefly-isolation-root=${isolationRoot}`])], env: {}, isPackaged: true, productionAppData };
}
describe("runtime profile boundary", () => {
  it.each(["development", "test", "smoke"])("rejects %s without explicit isolation before any writer", (profile) => {
    const resolve = resolveRuntimeProfile;
    expect(() => resolve(input(profile))).toThrow("FIREFLY_RUNTIME_ISOLATION_REQUIRED");
  });
  it("preserves the production physical layout", () => {
    const resolve = resolveRuntimeProfile;
    const request = input("production");
    const profile = resolve(request);
    expect(profile.userData).toBe(path.join(request.productionAppData, "Firefly"));
    expect(profile.appData).toBe(request.productionAppData);
    expect(profile.sessionData).toBe(profile.userData);
    expect(profile.logs).toBe(path.join(profile.userData, "logs"));
    expect(profile.isolationRoot).toBeUndefined();
  });
  it.each(["development", "test", "smoke"])("resolves all %s Electron roots inside one explicit boundary without writing", (kind) => {
    const resolve = resolveRuntimeProfile;
    const isolationRoot = temporary();
    // Keep the caller's raw path (including Windows 8.3 aliases) as resolver input.
    const canonicalRoot = fs.realpathSync.native(isolationRoot);
    const profile = resolve(input(kind, isolationRoot));
    expect(profile.kind).toBe(kind);
    expect(profile.applicationName).toBe(`Firefly-${kind}`);
    expect(profile.isolationRoot).toBe(canonicalRoot);
    for (const key of ["appData", "userData", "sessionData", "logs"] as const) {
      const relative = path.relative(canonicalRoot, profile[key]);
      expect(relative).not.toMatch(/^\.\./);
      expect(path.isAbsolute(relative)).toBe(false);
    }
    expect(fs.readdirSync(isolationRoot)).toEqual([]);
  });
  it("rejects invalid and unknown profile arguments", () => {
    const resolve = resolveRuntimeProfile;
    expect(() => resolve(input("unknown", temporary()))).toThrow("FIREFLY_RUNTIME_PROFILE_INVALID");
    expect(() => resolve(input("smoke", "relative"))).toThrow("FIREFLY_RUNTIME_ISOLATION_INVALID");
  });
  it("rejects equal, child, parent and normalized production aliases", () => {
    const resolve = resolveRuntimeProfile;
    const request = input("smoke");
    const child = path.join(request.productionAppData, "child");
    fs.mkdirSync(child);
    for (const isolationRoot of [request.productionAppData, child, path.dirname(request.productionAppData), path.join(child, "..")]) {
      expect(() => resolve({ ...request, argv: ["--firefly-profile=smoke", `--firefly-isolation-root=${isolationRoot}`] })).toThrow("FIREFLY_RUNTIME_PRODUCTION_OVERLAP");
    }
  });
  it("rejects a junction alias into production", () => {
    const resolve = resolveRuntimeProfile;
    const request = input("smoke");
    const outer = temporary();
    const alias = path.join(outer, "alias");
    fs.symlinkSync(request.productionAppData, alias, "junction");
    expect(() => resolve({ ...request, argv: ["--firefly-profile=smoke", `--firefly-isolation-root=${alias}`] })).toThrow("FIREFLY_RUNTIME_PRODUCTION_OVERLAP");
  });
  it("pins the canonical isolation root when the supplied directory alias is retargeted", () => {
    const isolation = temporary();
    const foreign = temporary();
    const alias = path.join(temporary(), "alias");
    fs.symlinkSync(isolation, alias, "junction");
    const profile = resolveRuntimeProfile(input("test", alias));
    expect(profile.isolationRoot).toBe(fs.realpathSync.native(isolation));
    expect(Object.isFrozen(profile)).toBe(true);

    fs.unlinkSync(alias);
    fs.symlinkSync(foreign, alias, "junction");
    const context = createStorageContext(profile);
    expect(context.configRoot).toBe(path.join(fs.realpathSync.native(isolation), "Firefly-test"));
    expect(() => assertRuntimePathsOwned(profile, [path.join(alias, "escaped.json")])).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
    expect(fs.readdirSync(isolation)).toEqual([]);
    expect(fs.readdirSync(foreign)).toEqual([]);
  });
  it.runIf(process.platform === "win32")("rejects raw Windows 8.3 and canonical aliases of the same production directory", ({ skip }) => {
    const fixtureRoot = temporary();
    if(!process.env.ComSpec)throw Error("ComSpec is required for the Windows short-path fixture");
    const rawRoot=execFileSync(process.env.ComSpec,["/d","/s","/c",'for %I in ("%FIREFLY_PROFILE_TEST_ROOT%") do @echo %~fsI'],{env:{...process.env,FIREFLY_PROFILE_TEST_ROOT:fixtureRoot},encoding:"utf8",windowsHide:true,windowsVerbatimArguments:true,timeout:5000}).trim();
    const canonicalRoot = fs.realpathSync.native(fixtureRoot);
    expect(fs.realpathSync.native(rawRoot)).toBe(canonicalRoot);
    // Query a real short path; never substitute a junction or change volume settings.
    if (!/~\d+(?:\\|$)/.test(rawRoot)) { skip("The isolated test directory has no real Windows 8.3 short path"); return; }
    expect(rawRoot.toLowerCase()).not.toBe(canonicalRoot.toLowerCase());
    for (const [productionAppData, isolationRoot] of [[canonicalRoot, rawRoot], [rawRoot, canonicalRoot]]) {
      expect(() => resolveRuntimeProfile({
        argv: ["--firefly-profile=smoke", `--firefly-isolation-root=${isolationRoot}`],
        env: {}, isPackaged: true, productionAppData,
      })).toThrow("FIREFLY_RUNTIME_PRODUCTION_OVERLAP");
    }
    expect(fs.readdirSync(rawRoot)).toEqual([]);
  });
  it("rejects an existing child junction escaping isolation before mkdir", () => {
    const resolve = resolveRuntimeProfile;
    const isolationRoot = temporary();
    fs.symlinkSync(temporary(), path.join(isolationRoot, "Firefly-smoke"), "junction");
    expect(() => resolve(input("smoke", isolationRoot))).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
  });
  it("rejects case aliases on Windows", () => {
    const resolve = resolveRuntimeProfile;
    const request = input("smoke");
    const isolationRoot = process.platform === "win32" ? request.productionAppData.toUpperCase() : request.productionAppData;
    expect(() => resolve({ ...request, argv: ["--firefly-profile=smoke", `--firefly-isolation-root=${isolationRoot}`] })).toThrow("FIREFLY_RUNTIME_PRODUCTION_OVERLAP");
  });
  it("rejects a root parameter without an explicit profile", () => {
    const resolve = resolveRuntimeProfile;
    expect(() => resolve({ ...input("smoke"), argv: [`--firefly-isolation-root=${temporary()}`] })).toThrow("FIREFLY_RUNTIME_PROFILE_REQUIRED");
  });
});

describe("Electron application boundary", () => {
  it("applies and verifies every Electron root before service initialization", () => {
    const resolve = resolveRuntimeProfile;
    const apply = applyElectronPaths;
    const profile = resolve(input("smoke", temporary()));
    const retained = new Map<string, string>();
    const app = { setName: vi.fn(), setPath: (key: string, value: string) => retained.set(key, value), setAppLogsPath: (value: string) => retained.set("logs", value), getPath: (key: string) => retained.get(key)! };
    apply(app, profile);
    expect(app.setName).toHaveBeenCalledWith("Firefly-smoke");
    for (const key of ["appData", "userData", "sessionData", "logs"] as const) expect(retained.get(key)).toBe(profile[key]);
  });
  it("fails closed when Electron does not retain session isolation", () => {
    const resolve = resolveRuntimeProfile;
    const apply = applyElectronPaths;
    const profile = resolve(input("test", temporary()));
    const retained = new Map<string, string>();
    const app = { setName: vi.fn(), setPath: (key: string, value: string) => retained.set(key, value), setAppLogsPath: (value: string) => retained.set("logs", value), getPath: (key: string) => key === "sessionData" ? os.tmpdir() : retained.get(key)! };
    expect(() => apply(app, profile)).toThrow("FIREFLY_RUNTIME_SESSIONDATA_FAILED");
  });
  it("rejects an isolation escape introduced between resolve and apply before writing", () => {
    const resolve = resolveRuntimeProfile;
    const apply = applyElectronPaths;
    const isolation = temporary();
    const profile = resolve(input("smoke", isolation));
    fs.symlinkSync(temporary(), profile.userData, "junction");
    const setPath = vi.fn();
    expect(() => apply({ setName: vi.fn(), setPath, setAppLogsPath: vi.fn(), getPath: vi.fn() }, profile)).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
    expect(setPath).not.toHaveBeenCalled();
  });
  it("rejects replacement of the trusted root itself before any Electron or storage write", () => {
    const parent = temporary();
    const isolation = path.join(parent, "isolation");
    fs.mkdirSync(isolation);
    const profile = resolveRuntimeProfile(input("test", isolation));
    const foreign = temporary();
    const sentinel = path.join(foreign, "sentinel.txt");
    fs.writeFileSync(sentinel, "outside-original");
    const retained = path.join(parent, "retained");
    fs.renameSync(isolation, retained);
    fs.symlinkSync(foreign, isolation, "junction");
    const app = { setName: vi.fn(), setPath: vi.fn(), setAppLogsPath: vi.fn(), getPath: vi.fn() };

    expect(() => assertRuntimePathsOwned(profile, [profile.userData])).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
    expect(() => createStorageContext(profile)).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
    expect(() => applyElectronPaths(app, profile)).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
    for (const method of Object.values(app)) expect(method).not.toHaveBeenCalled();
    expect(fs.readdirSync(retained)).toEqual([]);
    expect(fs.readdirSync(foreign)).toEqual(["sentinel.txt"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("outside-original");
  });
  it("guards StorageContext before initialization", () => {
    const getContext = getStorageContext;
    expect(() => getContext()).toThrow("FIREFLY_STORAGE_NOT_INITIALIZED");
  });
  it("defines distinct profile-owned memory roots without creating or moving data", () => {
    const resolve = resolveRuntimeProfile;
    const profile = resolve(input("smoke", temporary()));
    const create = createStorageContext;
    const context = create(profile);
    expect(context.configRoot).toBe(profile.userData);
    expect(context.dataRoot).toBe(profile.userData);
    expect(context.stateRoot).toBe(profile.userData);
    expect(context.logsRoot).toBe(profile.logs);
    expect(context.sessionRoot).toBe(profile.sessionData);
    expect(new Set(Object.values(context.memory)).size).toBe(3);
    for (const root of Object.values(context.memory) as string[]) expect(path.relative(profile.userData, root)).not.toMatch(/^\.\./);
    expect(fs.readdirSync(profile.isolationRoot)).toEqual([]);
  });
});

it("rejects Memory index aliases that would make an index rebuild target the data root", () => {
  const profile = resolveRuntimeProfile(input("smoke", temporary()));
  const memoryRoot = path.join(profile.userData, "memory");
  fs.mkdirSync(path.join(memoryRoot, "data"), { recursive: true });
  fs.symlinkSync(path.join(memoryRoot, "data"), path.join(memoryRoot, "index"), "junction");
  const create = createStorageContext;
  expect(() => create(profile)).toThrow("FIREFLY_MEMORY_ROOT_ALIAS");
});
it("rejects a Memory parent junction escaping a validated profile", () => {
  const profile = resolveRuntimeProfile(input("smoke", temporary()));
  const foreignRoot = temporary();
  fs.writeFileSync(path.join(foreignRoot, "mcp.json"), "[]");
  fs.mkdirSync(profile.userData, { recursive: true });
  // File symlinks need Windows privileges; a parent junction exercises the same resolver.
  fs.symlinkSync(foreignRoot, path.join(profile.userData, "memory"), "junction");
  const create = createStorageContext;
  expect(() => create(profile)).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
});

it.each(["data-child", "memory-parent"])("rejects overlapping Memory roots (%s)", (alias) => {
  const profile = resolveRuntimeProfile(input("smoke", temporary()));
  const memoryRoot = path.join(profile.userData, "memory");
  const dataChild = path.join(memoryRoot, "data", "child");
  fs.mkdirSync(dataChild, { recursive: true });
  fs.symlinkSync(alias === "data-child" ? dataChild : memoryRoot, path.join(memoryRoot, "index"), "junction");
  expect(() => createStorageContext(profile)).toThrow("FIREFLY_MEMORY_ROOT_ALIAS");
  expect(fs.existsSync(dataChild)).toBe(true);
});
