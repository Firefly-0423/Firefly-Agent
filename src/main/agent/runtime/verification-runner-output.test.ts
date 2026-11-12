import { describe, it, expect } from "vitest";
import { DEFAULT_TIMEOUT_MS_BY_TYPE, VerificationRunner, type VerificationStep } from "./verification-runner";

const nodeStep = (program: string): VerificationStep => ({
  executable: process.execPath, args: ["-e", program], cwd: process.cwd(), packageRoot: process.cwd(),
  source: "firefly_config", trust: "builtin", type: "test", id: "agenda-validation",
});

describe("Verification process output contract", () => {
  it("assigns the documented duration budget to every verification category", () => {
    expect(DEFAULT_TIMEOUT_MS_BY_TYPE).toStrictEqual({ typecheck: 120_000, lint: 120_000, build: 300_000, test: 600_000 });
  });

  it("retains both output windows after capturing more than thirty thousand characters", async () => {
    const completed = await new VerificationRunner().runStep(nodeStep("process.stdout.write('BEGIN_AGENDA' + 'z'.repeat(32_000) + '\\nEND_AGENDA_OK')"), { permissionLevel: "full" });
    expect({ passed: completed.passed, timedOut: completed.timedOut }).toEqual({ passed: true, timedOut: false });
    for (const marker of ["BEGIN_AGENDA", "END_AGENDA_OK", "... (truncated"]) expect(completed.stdout).toContain(marker);
  });

  it("uses an explicit timeout instead of the category default and reports failure", async () => {
    const timed = await new VerificationRunner().runStep(nodeStep("setTimeout(() => process.exit(0), 12000)"), { permissionLevel: "full", defaultTimeoutMs: 1_500 });
    expect({ timedOut: timed.timedOut, passed: timed.passed, errorCode: timed.errorCode }).toEqual({ timedOut: true, passed: false, errorCode: "VERIFICATION_TIMEOUT" });
  }, 15_000);
});
