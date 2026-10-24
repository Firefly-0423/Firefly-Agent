import { expect, describe, it } from "vitest";
import { inspectToolCallArguments as inspect, parseAndValidateToolCallArguments as validate, resolveToolForCapability } from "./tool-argument-validator";
import { controlledInputKind, controlledInputType, type ToolDefinition, type ControlledInputPolicy } from "./tool-registry";
import type { ToolCallResult } from "../../types";

const definition = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: "open_selection", capability: "selection.open", name: "Open selection", description: "Open an approved selection", enabled: true,
  inputSchema: { type: "object", required: ["candidateRef"], properties: { candidateRef: { type: "string" } } },
  controlledInput: { candidateRef: { type: "context_ref", kind: "candidate" } }, execute: async () => "opened", ...overrides,
});
const request = (args: unknown, name = "open_selection") => ({ id: "request-73", name, arguments: JSON.stringify(args) });
const document = (defaults = false): ToolDefinition => definition({
  id: "compose_report", controlledInput: undefined,
  inputSchema: { type: "object", properties: {
    title: { type: "string" }, format: { type: "string", enum: defaults ? ["docx"] : ["docx", "pdf"] },
    copies: defaults ? { type: "integer", default: 1 } : { type: "integer" },
  }, required: ["title", "format", "copies"] },
});

describe("argument inspection before execution", () => {
  it("reports the remaining required fields in schema order", () => {
    expect(inspect(request({ title: "Field report" }, "compose_report"), document(), [], []))
      .toEqual({ kind: "missing_required", args: { title: "Field report" }, missingFields: ["format", "copies"] });
  });
  it("fills required fields with a single enum choice or a valid explicit default", () => {
    expect(inspect(request({ title: "Field report" }, "compose_report"), document(true), [], []))
      .toEqual({ kind: "complete", args: { title: "Field report", format: "docx", copies: 1 } });
  });
  it("rejects an invalid supplied value even while other required values are missing", () => {
    expect(() => inspect(request({ title: "Field report", copies: 1.5 }, "compose_report"), document(), [], []))
      .toThrow(/field 'copies' expected integer/);
  });
  it("names every missing field when full validation is requested", () => {
    const tool = definition({ controlledInput: undefined, inputSchema: { type: "object", properties: {
      filename: { type: "string" }, title: { type: "string" }, paragraphs: { type: "array" },
    }, required: ["filename", "title", "paragraphs"] } });
    expect(() => validate(request({}), tool, [], []))
      .toThrow(/E_TOOL_ARGUMENT_SCHEMA: missing required fields: filename, title, paragraphs/);
  });
});

describe("trusted sources for controlled inputs", () => {
  it.each(["context_ref", { type: "context_ref", kind: "candidate" }] as const)("accepts an approved reference under policy %j", (policy) => {
    expect(validate(request({ candidateRef: "ctx_approved_73" }), definition({ controlledInput: { candidateRef: policy } }), ["ctx_approved_73"], []))
      .toEqual({ candidateRef: "ctx_approved_73" });
  });
  it("requires result-controlled values to originate in a successful result", () => {
    const tool = definition({ controlledInput: { playlistId: "tool_result" }, inputSchema: {
      type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"],
    } });
    const previous: ToolCallResult = { toolId: "find_collection", args: {}, output: JSON.stringify({ playlistId: "collection-73" }), status: "succeeded" };
    expect(validate(request({ playlistId: "collection-73" }), tool, [], [previous])).toEqual({ playlistId: "collection-73" });
    expect(() => validate(request({ playlistId: "collection-73" }), tool, [], [{ ...previous, status: "failed" }]))
      .toThrow("E_TOOL_ARGUMENT_SOURCE");
  });
  it("rejects a fabricated context reference", () => {
    expect(() => validate(request({ candidateRef: "ctx_fabricated_91" }), definition(), ["ctx_approved_73"], []))
      .toThrow("E_TOOL_ARGUMENT_SOURCE");
  });
});

describe("protocol and schema errors", () => {
  it.each(["{invalid", "null", "[]", "false"])("rejects a non-object argument payload %s", (argumentsText) => {
    expect(() => validate({ ...request({}), arguments: argumentsText }, definition(), [], [])).toThrow("E_TOOL_ARGUMENT_PROTOCOL");
  });
  it("rejects absent required arguments and unknown supplied keys", () => {
    expect(() => validate(request({}), definition(), [], [])).toThrow("E_TOOL_ARGUMENT_SCHEMA");
    expect(() => validate(request({ candidateRef: "ctx_approved_73", unexpected: "value" }), definition(), ["ctx_approved_73"], []))
      .toThrow(/unknown fields: unexpected/);
  });
  it("includes the field and both types in a numeric type mismatch", () => {
    const tool = definition({ controlledInput: undefined, inputSchema: { type: "object", properties: {
      count: { type: "number" }, name: { type: "string" },
    }, required: ["count", "name"] } });
    expect(() => validate(request({ count: "several", name: "batch" }), tool, [], []))
      .toThrow(/field 'count' expected number, got string/);
  });
  it("requires the requested name to match the chosen tool", () => {
    expect(() => validate(request({}, "different_tool"), definition(), [], [])).toThrow("E_NATIVE_TOOL_PROTOCOL");
  });
});

describe("capability lookup", () => {
  it("selects a unique enabled match", () => {
    const tool = definition();
    expect(resolveToolForCapability([definition({ enabled: false }), tool], "selection.open")).toBe(tool);
    expect(resolveToolForCapability([tool], "selection.open").id).toBe("open_selection");
  });
  it("reports missing and ambiguous capabilities separately", () => {
    expect(() => resolveToolForCapability([], "selection.open")).toThrow("E_ACTION_CAPABILITY_UNAVAILABLE");
    expect(() => resolveToolForCapability([definition(), definition()], "selection.open")).toThrow("E_ACTION_CAPABILITY_AMBIGUOUS");
  });
});

describe("controlled policy accessors", () => {
  it.each([
    ["context_ref", "context_ref", undefined], ["context_ref_array", "context_ref_array", undefined], ["tool_result", "tool_result", undefined],
    [{ type: "context_ref", kind: "candidate" }, "context_ref", "candidate"],
    [{ type: "context_ref_array", kind: "candidate" }, "context_ref_array", "candidate"],
    [{ type: "context_ref_array", kind: "selection_set" }, "context_ref_array", "selection_set"],
    [{ type: "tool_result" }, "tool_result", undefined],
  ] as Array<[ControlledInputPolicy, string, string | undefined]>)("reads %j without synthesizing a kind", (policy, type, kind) => {
    expect(controlledInputType(policy)).toEqual(type);
    expect(controlledInputKind(policy)).toEqual(kind);
  });
});
