import { it, expect } from "vitest";
import type { PluginTool } from "../../plugins/types";
import { toolRegistry, resolveVerificationPolicy, resolveEffectKind, type ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { policyFor } from "../permission-policy";

it("accepts a plugin declaration with optional host metadata omitted and removes it cleanly", () => {
  const declaration: PluginTool = {
    id: "garden_contract_tool", name: "Garden lookup", description: "Looks up a plant", enabled: true,
    inputSchema: { properties: {}, type: "object" }, execute: async () => "plant",
  };
  toolRegistry.register(declaration as ToolDefinition);
  try {
    expect(toolRegistry.getById(declaration.id)).toBe(declaration);
    expect(toolRegistry.getEnabledTools()).toContain(declaration);
    for (const tool of [undefined, declaration as ToolDefinition]) {
      expect([resolveEffectKind(tool, {}), resolveVerificationPolicy(tool, {})]).toEqual(["unknown", "none"]);
    }
  } finally {
    expect(toolRegistry.unregister(declaration.id)).toBe(true);
  }
  expect(toolRegistry.getById(declaration.id)).toBeUndefined();
});
it("routes every plugin risk at every host access level, including safe defaults", () => {
  for (const access of ["full", "scoped", "per-action", "read-only", "project-read-only"] as const) {
    for (const risk of ["input-control", "network", "shell", "fs-write", "fs-read", "safe"] as const) {
      expect(["allow", "ask", "deny"]).toContain(policyFor(access, risk));
    }
    expect(policyFor(access, "safe")).toBe("allow");
  }
});
