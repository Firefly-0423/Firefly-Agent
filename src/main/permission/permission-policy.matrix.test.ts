import { describe, expect, it } from "vitest";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "./permission-policy";

type Decision = "allow" | "ask" | "deny";
const RISKS: ToolRiskLevel[] = ["safe", "fs-read", "fs-write", "shell", "network", "input-control"];

// 期望表以字面量固定，由改写前的实现逐格跑出；列顺序与 RISKS 一致。
const EXPECTED: Record<AgentFileAccessLevel, Decision[]> = {
  //                      safe     fs-read  fs-write shell    network  input-control
  "project-read-only": ["allow", "allow", "deny", "allow", "allow", "deny"],
  "read-only": ["allow", "allow", "deny", "allow", "allow", "deny"],
  "scoped": ["allow", "allow", "allow", "allow", "allow", "deny"],
  "per-action": ["allow", "ask", "ask", "ask", "ask", "ask"],
  "full": ["allow", "allow", "allow", "allow", "allow", "allow"],
};

const CELLS = (Object.keys(EXPECTED) as AgentFileAccessLevel[]).flatMap((level) =>
  RISKS.map((risk, i) => [level, risk, EXPECTED[level][i]] as const),
);

describe("policyFor decision table", () => {
  it("covers all 5 levels x 6 risks", () => {
    expect(CELLS).toHaveLength(30);
  });

  it.each(CELLS)("%s + %s -> %s", (level, risk, decision) => {
    expect(policyFor(level, risk)).toBe(decision);
  });

  it("is a pure function of its two arguments", () => {
    for (const [level, risk, decision] of CELLS) {
      expect(policyFor(level, risk)).toBe(decision);
      expect(policyFor(level, risk)).toBe(decision);
    }
  });
});

describe("policyFor with unknown inputs", () => {
  const unknownLevels = ["bogus", "", "FULL", "Full ", undefined, null, 0, {}] as unknown as AgentFileAccessLevel[];
  const unknownRisks = ["bogus", "", "FS-WRITE", undefined, null] as unknown as ToolRiskLevel[];
  const call = policyFor as (level: unknown, risk: unknown) => unknown;

  it("keeps safe tools allowed whatever the level is", () => {
    for (const level of unknownLevels) expect(policyFor(level, "safe")).toBe("allow");
  });

  it("never grants allow or ask for a non-safe risk under an unknown level", () => {
    for (const level of unknownLevels) {
      for (const risk of RISKS.filter((r) => r !== "safe")) {
        // 旧实现返回 undefined，新实现返回 deny；两者对调用方都不是放行。
        expect([undefined, "deny"]).toContain(policyFor(level, risk));
      }
    }
  });

  it("denies an unknown risk at every restrictive level", () => {
    for (const level of ["project-read-only", "read-only", "scoped"] as const) {
      for (const risk of unknownRisks) expect(call(level, risk)).toBe("deny");
    }
  });

  it("asks for an unknown risk at per-action and allows it at full (unchanged)", () => {
    for (const risk of unknownRisks) {
      expect(call("per-action", risk)).toBe("ask");
      expect(call("full", risk)).toBe("allow");
    }
  });

  it("does not match levels by case or whitespace", () => {
    expect([undefined, "deny"]).toContain(call("Per-Action", "fs-write"));
    expect([undefined, "deny"]).toContain(call(" scoped", "fs-write"));
  });
});
