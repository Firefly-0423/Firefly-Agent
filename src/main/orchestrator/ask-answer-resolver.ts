import { createHash } from "crypto";
import type { AskClarificationInput, AskMissingField, AskUserAnswer } from "../../shared/ask-clarification";
import type { ToolCallResult } from "./types";
import type { JsonSchemaProp, ToolDefinition } from "./tools/registry/tool-registry";
import { parseAndValidateToolCallArguments } from "./tools/registry/tool-argument-validator";

export interface PendingActionContext { stepAttemptId?: string; stepId?: string; planId?: string; runId: string }
export interface PendingAction {
  createdAt: number;
  context: PendingActionContext;
  bindings: Record<string, string>;
  schemaFingerprint: string;
  argumentsSnapshot: Record<string, unknown>;
  afterSuccess: "respond" | "replan";
  targetRefs: string[];
  objective: string;
  capability: string;
  toolId: string;
}
export type AskResolution =
  | { kind: "resume_action"; action: { toolId: string; capability: string; objective: string; targetRefs: string[]; afterSuccess: "respond" | "replan"; args: Record<string, unknown> } }
  | { kind: "return_to_agent"; answers: AskUserAnswer; reason: "semantic_question" | "normalization_failed" | "incomplete_arguments" | "schema_validation_failed" | "stale_pending_action" };

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const fields = value as Record<string, unknown>;
  const pairs = Object.keys(fields).sort().map((name) => `${JSON.stringify(name)}:${stableSerialize(fields[name])}`);
  return `{${pairs.join(",")}}`;
}

export function fingerprintToolSchema(tool: ToolDefinition): string {
  const serialized = stableSerialize(tool.inputSchema);
  return createHash("sha256").update(serialized).digest("hex");
}

export function createPendingAction(input: {
  tool: ToolDefinition; capability: string; objective: string; targetRefs: string[]; afterSuccess: "respond" | "replan";
  argumentsSnapshot: Record<string, unknown>; missingFields: string[]; context: PendingActionContext; createdAt?: number;
}): PendingAction {
  const mandatory = new Set(input.tool.inputSchema.required ?? []);
  const fields = [...new Set(input.missingFields)];
  if (fields.length === 0 || fields.length > 3 || fields.length !== input.missingFields.length) {
    throw new Error("E_PENDING_ACTION_BINDING_INVALID");
  }
  const bindings: Record<string, string> = {};
  for (const name of fields) {
    const definition = input.tool.inputSchema.properties[name];
    if (!definition || !mandatory.has(name) || name in input.argumentsSnapshot) throw new Error("E_PENDING_ACTION_BINDING_INVALID");
    if (!["string", "number", "integer", "boolean"].includes(definition.type)) throw new Error("E_PENDING_ACTION_BINDING_UNSUPPORTED");
    bindings[name] = name;
  }
  return {
    toolId: input.tool.id, capability: input.capability, objective: input.objective, targetRefs: [...input.targetRefs],
    afterSuccess: input.afterSuccess, argumentsSnapshot: { ...input.argumentsSnapshot },
    schemaFingerprint: fingerprintToolSchema(input.tool), bindings, context: { ...input.context }, createdAt: input.createdAt ?? Date.now(),
  };
}

function choicesFor(definition: JsonSchemaProp): AskMissingField["allowedOptions"] {
  if (definition.type === "boolean") return [{ label: "是", value: "true" }, { label: "否", value: "false" }];
  if ("enum" in definition && definition.enum && definition.enum.length >= 2) {
    return definition.enum.map((literal) => ({ label: literal, value: literal }));
  }
  return undefined;
}

export function buildPendingAskInput(pendingAction: PendingAction, tool: ToolDefinition, userRequest: string): AskClarificationInput {
  return {
    userRequest,
    missingFields: Object.entries(pendingAction.bindings).map(([name, path]) => {
      const definition = tool.inputSchema.properties[path];
      const suggestions = choicesFor(definition);
      return {
        field: name,
        reason: definition.description?.trim() || `执行 ${tool.name} 还缺少 ${name}`,
        required: true,
        questionHint: definition.description?.trim() || `请确认 ${name}`,
        typeHint: suggestions ? "single_select" : "text",
        allowedOptions: suggestions,
        candidateHints: suggestions?.map((choice) => choice.label) ?? [],
        allowCustom: true,
      };
    }),
  };
}

function sameContext(expected: PendingActionContext, actual: PendingActionContext): boolean {
  return expected.runId === actual.runId && expected.planId === actual.planId
    && expected.stepId === actual.stepId && expected.stepAttemptId === actual.stepAttemptId;
}

function normalizeValue(raw: string, schema: JsonSchemaProp): unknown | undefined {
  const stripped = raw.trim();
  if (!stripped) return undefined;
  const mapped = Object.entries(schema.askAliases ?? {}).find(([name]) => name.toLowerCase() === stripped.toLowerCase())?.[1];
  const candidate = mapped ?? stripped;
  switch (schema.type) {
    case "string":
      if (typeof candidate !== "string") return undefined;
      if (!("enum" in schema) || !schema.enum) return candidate;
      return schema.enum.find((literal) => literal === candidate)
        ?? schema.enum.find((literal) => literal.toLowerCase() === candidate.toLowerCase());
    case "number": {
      if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : undefined;
      if (typeof candidate !== "string") return undefined;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(candidate)) return undefined;
      const numeric = Number(candidate);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    case "integer": {
      if (typeof candidate === "number") return Number.isSafeInteger(candidate) ? candidate : undefined;
      if (typeof candidate !== "string" || !/^[+-]?\d+$/.test(candidate)) return undefined;
      const numeric = Number(candidate);
      return Number.isSafeInteger(numeric) ? numeric : undefined;
    }
    case "boolean": {
      if (typeof candidate === "boolean") return candidate;
      if (typeof candidate !== "string") return undefined;
      const word = candidate.trim().toLowerCase();
      if (["true", "1", "yes", "y", "是", "允许", "启用"].includes(word)) return true;
      if (["false", "0", "no", "n", "否", "拒绝", "禁用"].includes(word)) return false;
      return undefined;
    }
    default: return undefined;
  }
}

function returnToAgent(answers: AskUserAnswer, reason: Extract<AskResolution, { kind: "return_to_agent" }>["reason"]): AskResolution {
  return { kind: "return_to_agent", answers, reason };
}

export function resolvePendingActionAnswers(input: {
  pendingAction: PendingAction; currentTool?: ToolDefinition; answer: AskUserAnswer; currentContext: PendingActionContext; toolResults: ToolCallResult[];
}): AskResolution {
  const pending = input.pendingAction;
  const tool = input.currentTool;
  const reply = input.answer;
  const fallback = (reason: Extract<AskResolution, { kind: "return_to_agent" }>["reason"]) => returnToAgent(reply, reason);
  if (!tool || tool.id !== pending.toolId || !tool.enabled || !sameContext(pending.context, input.currentContext)) return fallback("stale_pending_action");
  if (fingerprintToolSchema(tool) !== pending.schemaFingerprint) return fallback("schema_validation_failed");
  const slots = Object.entries(pending.bindings);
  if (reply.answers.length !== slots.length) return fallback("incomplete_arguments");
  const responses = new Map(reply.answers.map((response) => [response.field, response]));
  if (responses.size !== reply.answers.length) return fallback("incomplete_arguments");
  const args = { ...pending.argumentsSnapshot };
  for (const [name, path] of slots) {
    const response = responses.get(name);
    const definition = tool.inputSchema.properties[path];
    if (!response || !definition) return fallback("incomplete_arguments");
    const selected = response.selectedValues;
    if (selected && selected.length !== 1) return fallback("normalization_failed");
    if (selected?.length && response.customText) return fallback("normalization_failed");
    const raw = selected?.[0] ?? response.customText;
    if (typeof raw !== "string") return fallback("normalization_failed");
    const converted = normalizeValue(raw, definition);
    if (converted === undefined) return fallback("normalization_failed");
    args[path] = converted;
  }
  try {
    parseAndValidateToolCallArguments({ id: `resume_${reply.requestId}`, name: tool.id, arguments: JSON.stringify(args) }, tool, pending.targetRefs, input.toolResults);
  } catch { return fallback("schema_validation_failed"); }
  return {
    kind: "resume_action",
    action: { toolId: pending.toolId, capability: pending.capability, objective: pending.objective,
      targetRefs: [...pending.targetRefs], afterSuccess: pending.afterSuccess, args },
  };
}
