import type { JsonSchemaProp, ToolDefinition } from "./tool-registry";
import { controlledInputType } from "./tool-registry";
import type { ToolCallResult } from "../../types";
import type { ToolCall } from "../../vendors/types";

export function resolveToolForCapability(available: ToolDefinition[], requested: string): ToolDefinition {
  const candidates = available.filter(definition => definition.enabled && (definition.capability ?? definition.id) === requested);
  if (candidates.length === 0) throw new Error("E_ACTION_CAPABILITY_UNAVAILABLE");
  if (candidates.length > 1) throw new Error("E_ACTION_CAPABILITY_AMBIGUOUS");
  return candidates[0];
}

function decodeCall(call: ToolCall): Record<string, unknown> {
  let decoded: unknown;
  try { decoded = JSON.parse(call.arguments || "{}"); }
  catch { throw new Error("E_TOOL_ARGUMENT_PROTOCOL"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("E_TOOL_ARGUMENT_PROTOCOL");
  return decoded as Record<string, unknown>;
}

function acceptsValue(input: unknown, rule: JsonSchemaProp): boolean {
  if (rule.type === "array" && "items" in rule) {
    return Array.isArray(input) && input.every(element => acceptsValue(element, rule.items));
  }
  if (rule.type === "object" && "properties" in rule) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const fields = input as Record<string, unknown>;
    if (Object.keys(fields).some(name => !(name in rule.properties))) return false;
    if (rule.required?.some((name: string) => !(name in fields))) return false;
    return Object.entries(fields).every(([name, content]) => acceptsValue(content, rule.properties[name]));
  }
  switch (rule.type) {
    case "number": if (typeof input !== "number") return false; break;
    case "integer": if (!Number.isInteger(input) || typeof input !== "number") return false; break;
    case "string": if (typeof input !== "string") return false; break;
    case "boolean": if (typeof input !== "boolean") return false; break;
  }
  if (!("enum" in rule) || rule.enum === undefined) return true;
  return typeof input === "string" && rule.enum.includes(input);
}

function populateRequired(input: Record<string, unknown>, definition: ToolDefinition): Record<string, unknown> {
  const filled = { ...input };
  for (const name of definition.inputSchema.required ?? []) {
    if (name in filled) continue;
    const rule = definition.inputSchema.properties[name];
    const fallback = rule.default !== undefined ? rule.default
      : "enum" in rule && rule.enum?.length === 1 ? rule.enum[0] : undefined;
    if (fallback !== undefined && acceptsValue(fallback, rule)) filled[name] = fallback;
  }
  return filled;
}

function checkFields(input: Record<string, unknown>, definition: ToolDefinition, partial = false): string[] {
  const contract = definition.inputSchema;
  const unknown = Object.keys(input).filter(name => !(name in contract.properties));
  if (unknown.length > 0) throw new Error(`E_TOOL_ARGUMENT_SCHEMA: unknown fields: ${unknown.join(", ")}`);
  const absent = contract.required?.filter(name => !(name in input)) ?? [];
  if (absent.length > 0 && !partial) throw new Error(`E_TOOL_ARGUMENT_SCHEMA: missing required fields: ${absent.join(", ")}`);
  for (const [name, content] of Object.entries(input)) {
    if (acceptsValue(content, contract.properties[name])) continue;
    const wanted = contract.properties[name].type;
    const received = Array.isArray(content) ? "array" : typeof content;
    throw new Error(`E_TOOL_ARGUMENT_SCHEMA: field '${name}' expected ${wanted}, got ${received}`);
  }
  return absent;
}

function successfulPayloads(history: ToolCallResult[]): unknown[] {
  return history.filter(entry => entry.status === "succeeded").flatMap(entry => {
    try { return [JSON.parse(entry.output) as unknown]; }
    catch { return []; }
  });
}

function gatherField(tree: unknown, requested: string, destination: Set<unknown>): void {
  if (Array.isArray(tree)) {
    tree.forEach(child => gatherField(child, requested, destination));
  } else if (tree && typeof tree === "object") {
    for (const [name, child] of Object.entries(tree as Record<string, unknown>)) {
      if (name === requested) {
        if (Array.isArray(child)) child.forEach(element => destination.add(element));
        else destination.add(child);
      }
      gatherField(child, requested, destination);
    }
  }
}

function checkSources(
  input: Record<string, unknown>, definition: ToolDefinition, references: string[], history: ToolCallResult[],
): void {
  const payloads = successfulPayloads(history);
  for (const [name, restriction] of Object.entries(definition.controlledInput ?? {})) {
    const supplied = input[name];
    if (supplied === undefined) continue;
    const sourceType = controlledInputType(restriction);
    if (sourceType === "context_ref" || sourceType === "context_ref_array") {
      const permitted = new Set<unknown>(references);
      for (const payload of payloads) {
        for (const alias of [name, "contextRef", "candidateRef", "setRef"]) gatherField(payload, alias, permitted);
      }
      const suppliedRefs = sourceType === "context_ref_array" && Array.isArray(supplied) ? supplied : [supplied];
      if (suppliedRefs.some(reference => !permitted.has(reference))) throw new Error("E_TOOL_ARGUMENT_SOURCE");
    } else {
      const permitted = new Set<unknown>();
      payloads.forEach(payload => gatherField(payload, name, permitted));
      if (!permitted.has(supplied)) throw new Error("E_TOOL_ARGUMENT_SOURCE");
    }
  }
}

export function parseAndValidateToolCallArguments(
  call: ToolCall, definition: ToolDefinition, references: string[], history: ToolCallResult[],
): Record<string, unknown> {
  if (call.name !== definition.id) throw new Error("E_NATIVE_TOOL_PROTOCOL");
  const input = populateRequired(decodeCall(call), definition);
  checkFields(input, definition);
  checkSources(input, definition, references, history);
  return input;
}

export type ToolArgumentInspection =
  | { kind: "complete"; args: Record<string, unknown> }
  | { missingFields: string[]; kind: "missing_required"; args: Record<string, unknown> };

export function inspectToolCallArguments(
  call: ToolCall, definition: ToolDefinition, references: string[], history: ToolCallResult[],
): ToolArgumentInspection {
  if (call.name !== definition.id) throw new Error("E_NATIVE_TOOL_PROTOCOL");
  const input = populateRequired(decodeCall(call), definition);
  const absent = checkFields(input, definition, true);
  checkSources(input, definition, references, history);
  if (absent.length > 0) return { kind: "missing_required", args: input, missingFields: absent };
  return { kind: "complete", args: input };
}
