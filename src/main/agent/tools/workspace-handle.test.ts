import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../tooling/registry/tool-context";
const { live, guard } = vi.hoisted(() => ({ live: { level: "full" }, guard: vi.fn() }));
vi.mock("../../platform/permission/permission", () => ({ getCurrentLevel: () => live.level }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "C:\\app" } }));
vi.mock("./workspace-boundary", async original => ({ ...await original<typeof import("./workspace-boundary")>(), assertWorkspaceBoundary: guard }));
import { createWorkspaceHandleBridge, workspaceHelperPath } from "./workspace-handle";

const root = "C:\\workspace", file = root + "\\file.txt";
const ctx = (level: ToolContext["fileAccessLevel"]): ToolContext => ({ userQuery: "test", resolvedWorkspaceRoot: root, fileAccessLevel: level });
function processMock() {
  const output = new PassThrough(), errors = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const input = new Writable({ write(_bytes, _encoding, done) { done(); } });
  Object.assign(child, { stdin: input, stdout: output, stderr: errors, kill: vi.fn() });
  const start = vi.fn(() => child);
  const bridge = createWorkspaceHandleBridge({ platform: "win32", spawn: start as unknown as typeof spawn, resolveBinary: () => "C:\\app\\bin\\firefly-workspace.exe", timeoutMs: 50 });
  return { bridge, child, start };
}
afterEach(() => { live.level = "full"; guard.mockReset(); vi.restoreAllMocks(); });

describe("workspace helper transport and three-level policy", () => {
  it.each(["linux", "darwin"] as const)("exposes unsupported %s and uses the existing guard", async platform => {
    const start = vi.fn();
    const b = createWorkspaceHandleBridge({ platform, spawn: start as unknown as typeof spawn });
    const target = "/workspace/file.txt";
    expect(b.support).toEqual({ supported: false, code: "workspace-unsupported-platform" });
    expect(await b.readFile(target, { ...ctx("read-only"), resolvedWorkspaceRoot: "/workspace" })).toBeUndefined();
    expect(await b.withWrite(target, { ...ctx("per-action"), resolvedWorkspaceRoot: "/workspace" }, false, async lease => lease)).toBeUndefined();
    expect(guard).toHaveBeenCalledWith(target, "read", expect.anything());
    expect(guard).toHaveBeenCalledWith(target, "write", expect.anything());
    expect(start).not.toHaveBeenCalled();
  });

  it.each([undefined, "full", "per-action", "read-only"] as const)("does not spawn for unrestricted read level %s", async level => {
    const p = processMock();
    expect(await p.bridge.readFile(file, ctx(level))).toBeUndefined();
    expect(p.start).not.toHaveBeenCalled();
  });

  it.each([undefined, "full", "per-action"] as const)("does not spawn for unrestricted write level %s", async level => {
    const p = processMock();
    const ran = await p.bridge.withWrite(file, ctx(level), false, async lease => lease ?? "direct");
    expect(ran).toBe("direct");
    expect(p.start).not.toHaveBeenCalled();
  });

  it("denies writes under read-only without spawning helper", async () => {
    const p = processMock();
    await expect(p.bridge.withWrite(file, ctx("read-only"), false, async () => { throw Error("must not run"); }))
      .rejects.toMatchObject({ code: "E_FILESYSTEM_READ_ONLY", category: "permission_denied" });
    expect(p.start).not.toHaveBeenCalled();
  });

  it("resolves packaged resources without using an asar path", () => {
    const resources = path.resolve("fixture", "resources"), repository = path.resolve("fixture", "repo");
    expect(workspaceHelperPath({ isPackaged: true, getAppPath: () => { throw Error("asar"); } }, resources)).toBe(path.join(resources, "bin", "firefly-workspace.exe"));
    expect(workspaceHelperPath({ isPackaged: false, getAppPath: () => repository }, resources)).toBe(path.join(repository, "native", "target", "release", "firefly-workspace.exe"));
  });
});
