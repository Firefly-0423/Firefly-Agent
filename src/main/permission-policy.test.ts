import { describe, it, expect } from "vitest";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "./permission-policy";

describe("permission decisions exposed to tool callers", () => {
  const risks: ToolRiskLevel[] = ["safe", "shell", "fs-read", "fs-write", "network", "input-control"];
  it.each<[AgentFileAccessLevel, string[]]>([
    ["full", ["allow", "allow", "allow", "allow", "allow", "allow"]],
    ["per-action", ["allow", "ask", "ask", "ask", "ask", "ask"]],
    ["scoped", ["allow", "allow", "allow", "allow", "allow", "deny"]],
    ["read-only", ["allow", "allow", "allow", "deny", "allow", "deny"]],
    ["project-read-only", ["allow", "allow", "allow", "deny", "allow", "deny"]],
  ])("resolves the complete risk vector for %s", (access, decisions) => {
    expect(risks.map(risk => policyFor(access, risk))).toEqual(decisions);
  });
});
