import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ steps: [] as Array<{ executable: string; args: string[]; trust: string; cwd: string }> }));
vi.mock("../../verification-runner", () => ({
  resolveBuiltinExecutable: () => null,
  VerificationRunner: class {
    async runStep(step: { executable: string; args: string[]; trust: string; cwd: string }) {
      runner.steps.push(step);
      return { passed: true, exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    }
  },
}));
vi.mock("../../../permission/permission", () => ({ getCurrentLevel: () => "full" }));
import { runVerificationTool } from "./run-verification-tool";

const roots: string[] = [];
afterEach(() => { runner.steps = []; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-verification-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}
const run = async (verificationType: string, cwd: string) => JSON.parse(await runVerificationTool.execute!({ verificationType, cwd }, {} as never) as string);

describe("run_verification in a Rust workspace", () => {
  it.each([
    ["typecheck", ["check"]],
    ["test", ["test"]],
    ["build", ["build"]],
    ["lint", ["clippy", "--all-targets", "--", "-D", "warnings"]],
  ])("runs cargo for %s as a workspace script", async (kind, args) => {
    const cwd = workspace({ "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n' });
    const result = await run(kind, cwd);
    expect(result).toMatchObject({ passed: true, verificationType: kind });
    expect(runner.steps).toEqual([expect.objectContaining({ executable: "cargo", args, trust: "workspace_script", cwd })]);
  });
});

it("tells the model to use the project's own command in a workspace it does not recognise", async () => {
  const result = await run("test", workspace({ "pyproject.toml": "[project]\nname = 'demo'\n" }));
  expect(result).toMatchObject({ success: false, passed: false, errorCode: "VERIFICATION_PROJECT_UNSUPPORTED" });
  expect(result.error).toContain("run_shell");
  expect(runner.steps).toEqual([]);
});
