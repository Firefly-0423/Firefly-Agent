import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emitCacheDiagnostic } from "./harness-observability";
import type { HarnessRun } from "./firefly-harness";

describe("Harness cache diagnostics", () => {
  it("does not traverse the request when no diagnostic observer is installed", () => {
    const run = {
      input: {},
      get messages() { throw new Error("unobserved history traversal"); },
    } as unknown as HarnessRun;
    expect(() => emitCacheDiagnostic(run, { stablePrefix: "persona" })).not.toThrow();
  });

  it("reports structural fingerprints without exposing prompt or transcript text", () => {
    let diagnostic: unknown;
    const run = {
      input: { runId: "run-fixture", onCacheDiagnostic: (value: unknown) => { diagnostic = value; } },
      allToolSpecs: [], messages: [], cache: { cacheEpoch: 2 }, rounds: 3,
    } as unknown as HarnessRun;
    emitCacheDiagnostic(run, { stablePrefix: "persona" });
    expect(diagnostic).toMatchObject({ runId: "run-fixture", cacheEpoch: 2, round: 3, messageCount: 0,
      stablePromptFingerprint: createHash("sha256").update(JSON.stringify("persona")).digest("hex") });
    expect(JSON.stringify(diagnostic)).not.toContain("persona");
  });
});
