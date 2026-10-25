import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

vi.mock("../index", () => ({ sendToLive2DWindow: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => process.env.TEMP ?? process.cwd() }, ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
import { toolRegistry } from "./tools/registry/tool-registry";
import { setCurrentLevel } from "../permission/permission";
import { VerificationRunner, type VerificationResult } from "./verification-runner";
import "./tools/built-in-tools";

let workspace: string;
const verify = async (verificationType: string) => JSON.parse(await toolRegistry.getById("run_verification")!.execute({ cwd: workspace, verificationType }));
function completed(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { cwd: workspace, stepId: "calendar-check", type: "typecheck", passed: true, skipped: false, trust: "workspace_script", executable: process.execPath, args: [], exitCode: 0, stdout: "Agenda checked", stderr: "", timedOut: false, durationMs: 28, ...overrides };
}
function manifest(packageManager?: string, withBuild = true) {
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ ...(packageManager ? { packageManager } : {}), scripts: withBuild ? { build: 'node -e "process.stdout.write(\'agenda-build-complete\')"' } : { test: "vitest" } }));
  fs.writeFileSync(path.join(workspace, packageManager ? "pnpm-lock.yaml" : "package-lock.json"), packageManager ? "lockfileVersion: '9.0'\n" : "{}\n");
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(process.cwd(), ".tmp-agenda-verification-"));
  fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, include: ["agenda.ts"] }));
  fs.writeFileSync(path.join(workspace, "agenda.ts"), "export const appointment = 84;\n");
  setCurrentLevel("full");
});
afterEach(() => {
  vi.restoreAllMocks(); setCurrentLevel("read-only");
  fs.rmSync(workspace, { force: true, recursive: true });
});

describe("Work verification through the shared process runner", () => {
  it("preserves the successful legacy JSON result and uses local TypeScript", async () => {
    const runner = vi.spyOn(VerificationRunner.prototype, "runStep").mockResolvedValue(completed());
    expect(await verify("typecheck")).toMatchObject({ success: true, verificationType: "typecheck", exitCode: 0, stdout: "Agenda checked", stderr: "", spawnError: null, timedOut: false, passed: true });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][0].executable).toEqual("builtin:tsc");
  });

  it("invokes local Vitest directly with the default reporter", async () => {
    const runner = vi.spyOn(VerificationRunner.prototype, "runStep").mockResolvedValue(completed({ type: "test" }));
    await verify("test");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][0]).toMatchObject({ args: ["--reporter=default"], executable: "builtin:vitest" });
  });

  it.each([undefined, "pnpm@10.0.0"])("dispatches the workspace build using package manager %s", async (packageManager) => {
    manifest(packageManager);
    const runner = vi.spyOn(VerificationRunner.prototype, "runStep").mockResolvedValue(completed({ type: "build" }));
    const output = await verify("build");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][0]).toMatchObject({ executable: packageManager ? "pnpm" : "npm", args: ["run", "build"], cwd: workspace, source: "package_script" });
    expect(output).toMatchObject({ verificationType: "build", passed: true });
    if (!packageManager) expect(output.command).toContain("npm run build");
  });

  it("runs a real workspace build and returns the script's output", async () => {
    manifest();
    const output = await verify("build");
    expect(output).toMatchObject({ success: true, verificationType: "build", exitCode: 0, passed: true });
    expect(output.stdout).toContain("agenda-build-complete");
  });

  it("returns structured missing-script and missing-config failures without invoking the runner", async () => {
    manifest(undefined, false);
    const runner = vi.spyOn(VerificationRunner.prototype, "runStep");
    expect(await verify("build")).toMatchObject({ success: false, passed: false, errorCode: "PACKAGE_SCRIPT_NOT_FOUND", actualCwd: workspace });
    expect(runner).not.toHaveBeenCalled();
    fs.rmSync(path.join(workspace, "tsconfig.json"));
    expect(await verify("typecheck")).toMatchObject({ success: false, passed: false, timedOut: false, errorCode: "VERIFICATION_CONFIG_NOT_FOUND", actualCwd: workspace });
    expect(runner).not.toHaveBeenCalled();
  });

  it("distinguishes a nonzero process result from a retryable timeout", async () => {
    const runner = vi.spyOn(VerificationRunner.prototype, "runStep").mockResolvedValueOnce(completed({ passed: false, exitCode: 2, stdout: "", stderr: "Agenda type mismatch", errorCode: "VERIFICATION_EXECUTION_FAILED" }));
    expect(await verify("typecheck")).toMatchObject({ success: true, passed: false, exitCode: 2, stderr: "Agenda type mismatch" });
    runner.mockResolvedValueOnce(completed({ passed: false, exitCode: null, timedOut: true, errorCode: "VERIFICATION_TIMEOUT" }));
    expect(await verify("typecheck")).toMatchObject({ success: false, timedOut: true, errorCode: "VERIFICATION_TIMEOUT", retryable: true });
  });
});
