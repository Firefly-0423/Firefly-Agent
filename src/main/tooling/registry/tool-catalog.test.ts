import { describe, expect, it } from "vitest";
import { buildToolCatalog } from "./tool-catalog";
import type { ToolDefinition } from "./tool-registry";

const entry = (id: string, fields: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id, name: "Catalog entry", description: "Inspect a resource", enabled: true,
  inputSchema: { type: "object", properties: {} }, execute: async () => "ready", ...fields,
});

describe("model-visible tool directory", () => {
  it("uses the exact empty-directory placeholder", () => {
    expect(buildToolCatalog([])).toEqual("（当前没有可用工具）");
  });
  it("serializes each id, purpose and risk in input order", () => {
    expect(buildToolCatalog([
      entry("inspect_archive", { description: "Inspect an archive", risk: "network" }),
      entry("inspect_workspace", { description: "Inspect a workspace" }),
      entry("inspect_document", { description: "Inspect a document", risk: "network" }),
    ])).toEqual("- inspect_archive\n  用途：Inspect an archive\n  风险：network\n- inspect_workspace\n  用途：Inspect a workspace\n  风险：safe\n- inspect_document\n  用途：Inspect a document\n  风险：network");
  });
  it("prefers a trimmed hint and leaves out the longer description", () => {
    const result = buildToolCatalog([entry("inspect_hint", {
      catalogHint: "  Concise purpose  ", description: "Verbose explanation of this operation",
    })]);
    expect(result).toEqual("- inspect_hint\n  用途：Concise purpose\n  风险：safe");
    expect(result).not.toContain("Verbose explanation");
  });
  it("uses just the first description line when no hint was provided", () => {
    const result = buildToolCatalog([entry("inspect_lines", { description: "  Main purpose  \nAdditional usage instructions" })]);
    expect(result).toEqual("- inspect_lines\n  用途：Main purpose\n  风险：safe");
    expect(result).not.toContain("Additional usage instructions");
  });
  it("accepts a hint even when the description is empty", () => {
    expect(buildToolCatalog([entry("inspect_fallback", { description: "", catalogHint: "Fallback purpose" })]))
      .toEqual("- inspect_fallback\n  用途：Fallback purpose\n  风险：safe");
  });
  it("never repeats parameter schemas in the directory text", () => {
    const result = buildToolCatalog([entry("inspect_input", { inputSchema: {
      type: "object", properties: { location: { type: "string", description: "Resource location" } }, required: ["location"],
    } })]);
    expect(result).toEqual("- inspect_input\n  用途：Inspect a resource\n  风险：safe");
    for (const forbidden of ["location", "properties", "required"]) expect(result).not.toContain(forbidden);
  });
});
