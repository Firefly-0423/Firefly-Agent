import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentFileAccessLevel } from "../../permission-policy";

const host = vi.hoisted(() => ({
  level: "read-only" as AgentFileAccessLevel, executable: "",
  locate: vi.fn(), status: vi.fn(), install: vi.fn(), initialize: vi.fn(), reset: vi.fn(), wrap: vi.fn(),
}));
vi.mock("../../logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, LogTag: { Runtime: "runtime" } }));
vi.mock("../../permission", () => ({ getCurrentLevel: () => host.level }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  get VENDORED_SRT_WIN_EXE() { return host.executable; },
  resolveSrtWin: host.locate, checkWindowsSandboxStatusAsync: host.status, installWindowsSandboxAsync: host.install,
  SandboxManager: { initialize: host.initialize, reset: host.reset, wrapWithSandboxArgv: host.wrap },
}));

let sandbox: typeof import("./sandbox-exec");
let savedPlatform: PropertyDescriptor | undefined, savedSetting: string | undefined;
const roots: string[] = [];
const workspace = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-sandbox-")); roots.push(root); return root; };
const healthy = { user: { provisioned: true, sid: "S-1-5-21-84" }, wfp: { state: "active" } };
const wrapped = { argv: ["calendar-srt.exe", "--srt-win", "--", "cmd.exe", "/c", "echo calendar"], env: { FIREFLY_SANDBOX: "1" } };
beforeEach(async () => {
  savedPlatform = Object.getOwnPropertyDescriptor(process, "platform"); savedSetting = process.env.FIREFLY_SRT;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  delete process.env.FIREFLY_SRT;
  vi.resetModules(); vi.resetAllMocks();
  host.level = "read-only";
  host.executable = ["D:", "calendar-app", "app.asar", "vendor", "srt-win.exe"].join(path.sep);
  host.locate.mockImplementation(({ path: executable }: { path: string }) => ({ exe: executable, prependArgs: ["--srt-win"] }));
  host.status.mockResolvedValue(healthy); host.install.mockResolvedValue(healthy);
  host.initialize.mockResolvedValue(undefined); host.reset.mockResolvedValue(undefined); host.wrap.mockResolvedValue(wrapped);
  sandbox = await import("./sandbox-exec");
});
afterEach(() => {
  if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
  if (savedSetting === undefined) delete process.env.FIREFLY_SRT; else process.env.FIREFLY_SRT = savedSetting;
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("Windows sandbox session grants", () => {
  it.each(["scoped", "project-read-only"] as const)("%s grants the trusted workspace rather than cwd or an ancestor project", async (level) => {
    const outer = workspace();
    fs.writeFileSync(path.join(outer, "package.json"), "{}");
    const root = path.join(outer, "bound");
    const cwd = path.join(root, "sub");
    fs.mkdirSync(cwd, { recursive: true });
    await sandbox.initSandbox();
    expect(await sandbox.wrapWithSandbox("echo test", cwd, undefined, level, root)).toMatchObject({ ok: true });
    const filesystem = host.initialize.mock.calls[0][0].filesystem;
    if (level === "scoped") expect(filesystem.allowWrite).toEqual([root]);
    else expect(filesystem.allowRead).toEqual([root]);
    expect(host.wrap.mock.calls[0][4]).toBe(cwd);
  });

  it.each([
    ["read-only", { allowWrite: [], denyRead: [], denyWrite: [] }],
    ["project-read-only", { allowRead: ["E:\\calendar-workspace"], allowWrite: [], denyRead: [], denyWrite: [] }],
    ["scoped", { allowWrite: ["E:\\calendar-workspace"], denyRead: [], denyWrite: [] }],
    ["per-action", { allowWrite: ["E:\\calendar-workspace"], denyRead: [], denyWrite: [] }],
    ["full", { allowWrite: [], denyRead: [], denyWrite: [], disabled: true }],
  ] as const)("resolves %s access without unrelated home or app grants", (level, expected) => {
    expect(sandbox.resolveSandboxSessionFilesystem(level, "E:\\calendar-workspace")).toEqual(expected);
  });

  it("keeps the trusted permission snapshot even when live settings have become full", async () => {
    const root = workspace(); await sandbox.initSandbox(); host.level = "full";
    expect(await sandbox.wrapWithSandbox("echo calendar", root, undefined, "read-only")).toMatchObject({ ok: true });
    expect(host.initialize).toHaveBeenCalledWith(expect.objectContaining({ filesystem: { allowWrite: [], denyRead: [], denyWrite: [] } }));
    expect(host.wrap).toHaveBeenCalledWith("echo calendar", undefined, { filesystem: { denyRead: [], denyWrite: [] } }, undefined, root, undefined);
  });
});

describe("Sandbox startup and explicit disable", () => {
  it.each(["linux", "0", "false"])("skips sandbox loading for disabled setting or platform %s", async (setting) => {
    if (setting === "linux") Object.defineProperty(process, "platform", { configurable: true, value: "linux" }); else process.env.FIREFLY_SRT = setting;
    await sandbox.initSandbox();
    expect(sandbox.isSandboxReady()).toEqual(false); expect(host.locate).not.toHaveBeenCalled();
    await expect(sandbox.wrapWithSandbox("echo calendar", workspace())).resolves.toMatchObject({ ok: false, reason: "disabled" });
  });

  it("keeps startup status failure distinct from disable and fails closed on wrapping", async () => {
    host.status.mockRejectedValue(Error("Calendar sandbox status unavailable"));
    await sandbox.initSandbox();
    expect(sandbox.isSandboxReady()).toEqual(true);
    await expect(sandbox.wrapWithSandbox("echo calendar", workspace())).resolves.toMatchObject({ ok: false, reason: "not_ready" });
  });

  it("does not install at startup, probes only once and unpacks the vendored executable path", async () => {
    host.status.mockResolvedValue({ user: { provisioned: false }, wfp: { state: "absent" } });
    await sandbox.initSandbox(); await sandbox.initSandbox();
    expect(host.install).not.toHaveBeenCalled(); expect(sandbox.isSandboxReady()).toEqual(true);
    expect(host.status).toHaveBeenCalledTimes(1);
    expect(host.locate).toHaveBeenCalledWith({ path: ["D:", "calendar-app", "app.asar.unpacked", "vendor", "srt-win.exe"].join(path.sep) });
  });
});

describe("Command wrapping and session reuse", () => {
  it.each(["read-only", "scoped", "per-action"] as const)("initializes %s grants and passes only the per-call filesystem policy", async (level) => {
    host.level = level; await sandbox.initSandbox(); const root = workspace();
    const result = await sandbox.wrapWithSandbox("echo calendar", root);
    expect(result).toEqual({ ok: true, ...wrapped });
    expect(host.initialize).toHaveBeenCalledWith(expect.objectContaining({
      filesystem: { allowWrite: level === "read-only" ? [] : [root], denyRead: [], denyWrite: [] },
      windows: { srtWin: { path: expect.stringContaining("app.asar.unpacked") } },
    }));
    expect(host.wrap).toHaveBeenCalledWith("echo calendar", undefined, { filesystem: level === "per-action" ? { disabled: true } : { denyRead: [], denyWrite: [] } }, undefined, root, undefined);
    expect(sandbox.isSandboxReady()).toEqual(true);
  });

  it("finds the project root for readonly access from a nested working directory", async () => {
    host.level = "project-read-only"; await sandbox.initSandbox();
    const root = workspace(), nested = path.join(root, "packages", "calendar");
    fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(path.join(root, ".git"));
    expect((await sandbox.wrapWithSandbox("git log", nested)).ok).toEqual(true);
    expect(host.initialize).toHaveBeenCalledWith(expect.objectContaining({ filesystem: { allowRead: [root], allowWrite: [], denyRead: [], denyWrite: [] } }));
  });

  it("bypasses sandbox work entirely for full access and forwards an explicitly selected shell otherwise", async () => {
    host.level = "full"; await sandbox.initSandbox();
    expect(await sandbox.wrapWithSandbox("echo calendar", workspace())).toEqual({ ok: false, reason: "disabled", detail: "full level" });
    expect(host.initialize).not.toHaveBeenCalled(); expect(host.wrap).not.toHaveBeenCalled();
    host.level = "read-only";
    const root = workspace(), bash = "D:\\Calendar Tools\\Git\\bin\\bash.exe";
    expect((await sandbox.wrapWithSandbox("ls -l", root, bash)).ok).toEqual(true);
    expect(host.wrap).toHaveBeenCalledWith("ls -l", bash, expect.anything(), undefined, root, undefined);
  });

  it("reuses the same workspace session and reinitializes on workspace or permission changes", async () => {
    await sandbox.initSandbox(); const first = workspace(), second = workspace();
    await sandbox.wrapWithSandbox("echo morning", first); await sandbox.wrapWithSandbox("echo evening", first);
    expect(host.initialize).toHaveBeenCalledTimes(1); expect(host.status).toHaveBeenCalledTimes(2); expect(host.wrap).toHaveBeenCalledTimes(2);
    await sandbox.wrapWithSandbox("echo next", second);
    expect(host.reset).toHaveBeenCalledTimes(1); expect(host.initialize).toHaveBeenCalledTimes(2);
    host.level = "scoped"; await sandbox.wrapWithSandbox("echo scoped", second);
    expect(host.reset).toHaveBeenCalledTimes(2); expect(host.initialize).toHaveBeenCalledTimes(3);
    expect(host.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ filesystem: { allowWrite: [second], denyRead: [], denyWrite: [] } }));
  });
});

describe("Fail-closed wrapping and retry budgets", () => {
  it("refuses commands before initialization and reports wrapping errors or an empty argv", async () => {
    const root = workspace();
    expect(await sandbox.wrapWithSandbox("echo calendar", root)).toMatchObject({ ok: false, reason: "not_ready" });
    expect(host.wrap).not.toHaveBeenCalled();
    await sandbox.initSandbox();
    host.wrap.mockRejectedValueOnce(Error("Calendar wrapping failed"));
    expect(await sandbox.wrapWithSandbox("echo calendar", root)).toEqual({ ok: false, reason: "wrap_failed", detail: "Calendar wrapping failed" });
    host.wrap.mockResolvedValueOnce({ argv: [], env: {} });
    expect(await sandbox.wrapWithSandbox("echo calendar", root)).toEqual({ ok: false, reason: "wrap_failed", detail: "empty argv" });
  });

  it("stops after three readiness failures and restores the budget for another workspace", async () => {
    await sandbox.initSandbox(); host.status.mockRejectedValue(Error("Calendar WFP query failed")); const root = workspace();
    for (let attempt = 0; attempt < 3; attempt++) expect(await sandbox.wrapWithSandbox("echo retry-" + attempt, root)).toMatchObject({ ok: false, reason: "not_ready" });
    expect(host.status).toHaveBeenCalledTimes(4);
    expect(await sandbox.wrapWithSandbox("echo exhausted", root)).toMatchObject({ ok: false, reason: "not_ready" });
    expect(host.status).toHaveBeenCalledTimes(4); expect(sandbox.isSandboxReady()).toEqual(true);
    host.status.mockResolvedValue(healthy);
    expect((await sandbox.wrapWithSandbox("echo recovered", workspace())).ok).toEqual(true);
    expect(host.status).toHaveBeenCalledTimes(5); expect(host.initialize).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])("allows installation after %s UAC cancellations without consuming the error budget", async (cancellations) => {
    host.status.mockResolvedValue({ user: { provisioned: false }, wfp: { state: "absent" } }); await sandbox.initSandbox();
    const root = workspace();
    for (let attempt = 0; attempt < cancellations; attempt++) {
      host.install.mockResolvedValueOnce({ cancelled: true });
      expect(await sandbox.wrapWithSandbox("echo install", root)).toMatchObject({ ok: false, reason: "not_ready" });
      expect(host.install).toHaveBeenCalledTimes(attempt + 1);
    }
    host.install.mockResolvedValueOnce(healthy);
    expect((await sandbox.wrapWithSandbox("echo installed", root)).ok).toEqual(true);
    expect(host.install).toHaveBeenCalledTimes(cancellations + 1); expect(host.initialize).toHaveBeenCalledTimes(1);
  });
});

describe("Sandbox shutdown cleanup", () => {
  it("does nothing before readiness and releases an initialized session", async () => {
    await sandbox.resetSandbox(); expect(host.reset).not.toHaveBeenCalled();
    await sandbox.initSandbox(); await sandbox.wrapWithSandbox("echo calendar", workspace());
    await sandbox.resetSandbox(); expect(host.reset).toHaveBeenCalledTimes(1);
  });
  it("absorbs reset errors during shutdown", async () => {
    await sandbox.initSandbox(); await sandbox.wrapWithSandbox("echo calendar", workspace());
    host.reset.mockRejectedValueOnce(Error("Calendar sandbox cleanup failed"));
    await expect(sandbox.resetSandbox()).resolves.toBeUndefined();
  });
});
