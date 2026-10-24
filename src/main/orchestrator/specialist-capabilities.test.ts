import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import { createSpecialistProfiles } from "./specialist-profiles";
import { resolveAgentCapabilities } from "./agent-capabilities";

function tool(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

const parentTools = [
  "read_file",
  "write_word",
  "write_excel",
  "write_pdf",
  "write_file",
  "list_dir",
  "web_search",
  "fetch_url",
  "task",
  "ask_user",
  "confirm_uncertain_effect",
].map(tool);

describe("specialist capability intersection", () => {
  it("provides implementation, documents and research without generic profiles", () => {
    const profiles = createSpecialistProfiles("work", parentTools, []);
    expect(profiles.map(profile => profile.id)).toEqual(expect.arrayContaining(["implementation", "documents-data", "research"]));
    expect(profiles.some(profile => ["general", "document", "search"].includes(profile.id))).toBe(false);
    expect(profiles.find(profile => profile.id === "documents-data")!.allowedToolIds).toContain("write_word");
    expect(profiles.find(profile => profile.id === "research")!.allowedToolIds).toEqual(expect.arrayContaining(["web_search", "fetch_url"]));
  });

  it("never gives a child a blocked delegate or interactive tool", () => {
    const profile = createSpecialistProfiles("work", parentTools, [])[0];
    const resolved = resolveAgentCapabilities(profile, "work", parentTools, []).tools;

    expect(resolved.map((entry) => entry.id)).toEqual(expect.arrayContaining(["read_file", "write_word"]));
    expect(resolved.map((entry) => entry.id)).not.toEqual(expect.arrayContaining([
      "task",
      "ask_user",
      "confirm_uncertain_effect",
    ]));
  });

  it("intersects a specialized profile with the parent's enabled tools", () => {
    const profile = { ...createSpecialistProfiles("work", parentTools, []).find(profile => profile.id === "research")!, allowedToolIds: ["web_search", "fetch_url"] };
    const resolved = resolveAgentCapabilities(profile, "work", parentTools, []).tools;

    expect(resolved.map((entry) => entry.id)).toEqual(["web_search", "fetch_url"]);
    expect(resolveAgentCapabilities(profile, "work", [tool("web_search")], []).tools.map((entry) => entry.id)).toEqual(["web_search"]);
  });
});
