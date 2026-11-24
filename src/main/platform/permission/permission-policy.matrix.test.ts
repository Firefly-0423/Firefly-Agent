import { describe, expect, it } from "vitest";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "./permission-policy";

type Decision = "allow" | "ask" | "deny";
const RISKS: ToolRiskLevel[] = ["safe", "fs-read", "fs-write", "shell", "network", "input-control"];
const FIVE_RISK_KINDS: ToolRiskLevel[] = ["fs-read", "fs-write", "shell", "network", "input-control"];

// 与 Spec §7.2 表一致（shell 沿用当前内置工具行为：read-only 下放行）。列顺序与 RISKS 一致。
const EXPECTED: Record<AgentFileAccessLevel, Decision[]> = {
  //            safe     fs-read  fs-write shell    network  input-control
  "read-only": ["allow", "allow", "deny", "allow", "allow", "deny"],
  "per-action": ["allow", "ask", "ask", "ask", "ask", "ask"],
  "full": ["allow", "allow", "allow", "allow", "allow", "allow"],
};

const CELLS = (Object.keys(EXPECTED) as AgentFileAccessLevel[]).flatMap((level) =>
  RISKS.map((risk, i) => [level, risk, EXPECTED[level][i]] as const),
);

const SPEC_FIVE_RISK_CELLS = (Object.keys(EXPECTED) as AgentFileAccessLevel[]).flatMap((level) =>
  FIVE_RISK_KINDS.map((risk) => [level, risk, EXPECTED[level][RISKS.indexOf(risk)]] as const),
);

describe("policyFor decision table", () => {
  it("covers all 3 levels x 6 risks (including safe) and 3 levels x 5 risk kinds", () => {
    expect(CELLS).toHaveLength(18);
    expect(SPEC_FIVE_RISK_CELLS).toHaveLength(15);
  });

  it.each(CELLS)("%s + %s -> %s", (level, risk, decision) => {
    expect(policyFor(level, risk)).toBe(decision);
  });

  it.each(SPEC_FIVE_RISK_CELLS)("spec §7.2 matrix: %s + %s -> %s", (level, risk, decision) => {
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
  const unknownLevels = ["project-read-only", "scoped", "bogus", "", "FULL", "Full ", undefined, null, 0, {}] as unknown as AgentFileAccessLevel[];
  const unknownRisks = ["bogus", "", "FS-WRITE", undefined, null] as unknown as ToolRiskLevel[];
  const call = policyFor as (level: unknown, risk: unknown) => unknown;

  it("keeps safe tools allowed whatever the level is", () => {
    for (const level of unknownLevels) expect(policyFor(level, "safe")).toBe("allow");
  });

  it("denies non-safe risks for legacy and unknown levels", () => {
    for (const level of unknownLevels) {
      for (const risk of FIVE_RISK_KINDS) {
        expect(policyFor(level, risk)).toBe("deny");
      }
    }
  });

  it("denies an unknown risk at read-only", () => {
    for (const risk of unknownRisks) expect(call("read-only", risk)).toBe("deny");
  });

  it("asks for an unknown risk at per-action and allows it at full (unchanged)", () => {
    for (const risk of unknownRisks) {
      expect(call("per-action", risk)).toBe("ask");
      expect(call("full", risk)).toBe("allow");
    }
  });

  it("does not match levels by case or whitespace", () => {
    expect(call("Per-Action", "fs-write")).toBe("deny");
    expect(call(" read-only", "fs-write")).toBe("deny");
  });
});
