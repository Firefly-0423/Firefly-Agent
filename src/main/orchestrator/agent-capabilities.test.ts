import { describe, expect, it } from "vitest";
import { resolveAgentCapabilities } from "./agent-capabilities";
import type { AgentProfile } from "../../shared/agent-profile";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { SkillEntry } from "../skills/types";

const tool = (id: string): ToolDefinition => ({
  id, name: id, description: id, enabled: true, inputSchema: { type: "object", properties: {} },
  execute: async () => "fixture", effectKind: "read",
});
const skill = (id: string): SkillEntry => ({
  id, name: id, description: id, dirPath: "/fixture", bodyPath: "/fixture/SKILL.md",
  references: [], enabled: true, source: "builtin", modes: ["code"], effectKind: "unknown",
});
const profile: AgentProfile = {
  id: "test-review", nickname: "test", role: "Review", description: "Review", systemPrompt: "Review only the authorized scope",
  modelProfile: "default", allowedToolIds: ["read_file", "write_file", "task", "delegate_agent", "ask_user"],
  allowedSkillIds: ["as-code-review-and-quality", "as-security-and-hardening"],
  supportedModes: ["code"], persistent: true, timeoutMs: 0, maxConcurrency: 1,
};

describe("specialist capability intersection", () => {
  it("cannot acquire tools or Skills absent from the parent's effective set", () => {
    const read = tool("read_file");
    const review = skill("as-code-review-and-quality");
    const resolved = resolveAgentCapabilities(profile, "code", [read, tool("run_shell")], [review]);
    expect(resolved.tools).toEqual([read]);
    expect(resolved.skillIds).toEqual(new Set([review.id]));
    expect(resolved.skills[0].effectKind).toBe("unknown");
    expect(resolved.tools[0]).toBe(read);
  });

  it("does not permit delegated agents to delegate again or ask for another approval path", () => {
    const resolved = resolveAgentCapabilities(profile, "code", [tool("task"), tool("delegate_agent"), tool("ask_user")], []);
    expect(resolved.tools).toEqual([]);
    expect(resolved.skillIds).toEqual(new Set());
  });

  it("rejects modes outside a specialist profile without modifying the parent", () => {
    const tools = [tool("read_file")];
    expect(() => resolveAgentCapabilities(profile, "work", tools, [])).toThrow("AGENT_MODE_UNAVAILABLE");
    expect(tools).toHaveLength(1);
  });
});
