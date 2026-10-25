import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const boundary = vi.hoisted(() => ({ wrap: vi.fn(), spawn: vi.fn() }));
vi.mock("../../sandbox/sandbox-exec", () => ({
  wrapWithSandbox: boundary.wrap, isSandboxReady: () => true, ensureSandboxReady: async () => true,
  initSandbox: async () => undefined, resetSandbox: async () => undefined,
}));
vi.mock("../../../permission/permission", () => ({ getCurrentLevel: () => "scoped" }));
vi.mock("child_process", async (original) => {
  const native = await original<typeof import("child_process")>();
  return { ...native, spawn: (...args: Parameters<typeof native.spawn>) => { boundary.spawn(...args); return native.spawn(...args); } };
});
import { runShellTool } from "./run-shell-tool";

describe.runIf(process.platform === "win32")("sandbox failure blocks process creation", () => {
  let directory: string;
  let artifact: string;
  const writer = () => `echo sandbox-contract-73> "${artifact}"`;
  beforeEach(() => {
    boundary.wrap.mockReset();
    boundary.spawn.mockClear();
    directory = mkdtempSync(join(tmpdir(), "shell-boundary-73-"));
    artifact = join(directory, "must-not-exist.txt");
  });
  afterEach(() => {
    const target = resolve(directory);
    if (target.startsWith(resolve(tmpdir()) + "\\")) rmSync(target, { force: true, recursive: true });
  });
  async function invoke(command: string, background = false) {
    return JSON.parse(await runShellTool.execute({ command, shell: "cmd", ...(background ? { run_in_background: true } : {}) }));
  }
  function blocked(result: Record<string, unknown>, message: string) {
    expect(boundary.spawn).toHaveBeenCalledTimes(0);
    expect(existsSync(artifact)).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.sandboxed).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  }
  it("refuses a write when sandbox wrapping throws", async () => {
    boundary.wrap.mockImplementation(() => { throw new Error("Injected wrapper exception"); });
    blocked(await invoke(writer()), "拒绝");
  });
  it("refuses a wrapper failure without launching the original write", async () => {
    boundary.wrap.mockResolvedValue({ ok: false, reason: "wrap_failed", detail: "No executable returned" });
    blocked(await invoke(writer()), "沙箱包装失败");
  });
  it.each(["write", "read"])("refuses a %s command when the sandbox is not ready", async (kind) => {
    boundary.wrap.mockResolvedValue({ ok: false, reason: "not_ready" });
    blocked(await invoke(kind === "write" ? writer() : "git log -1"), "沙箱不可用");
  });
  it.each(["write", "nominal read"])("refuses a %s command when sandboxing is disabled", async (kind) => {
    boundary.wrap.mockResolvedValue({ ok: false, reason: "disabled", detail: "Disabled by configuration" });
    blocked(await invoke(kind === "write" ? writer() : "echo boundary-73"), "沙箱未启用");
  });
  it("does not allocate a background job when sandbox setup fails", async () => {
    boundary.wrap.mockResolvedValue({ ok: false, reason: "not_ready" });
    const result = await invoke(writer(), true);
    blocked(result, "[拒绝]");
    expect(result.stderr).toContain("沙箱不可用");
    expect(result.ranInBackground).toBeUndefined();
    expect(result.jobId).toBeUndefined();
  });
  it("launches only the wrapped executable after a successful plan", async () => {
    const command = writer();
    boundary.wrap.mockResolvedValue({ ok: true, argv: ["missing-sandbox-contract-73.exe", "--execute", command], env: {} });
    const result = await invoke(command);
    expect(boundary.spawn).toHaveBeenCalledTimes(1);
    expect(boundary.spawn).toHaveBeenCalledWith("missing-sandbox-contract-73.exe", ["--execute", command], expect.any(Object));
    expect(result.sandboxed).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  });
});
