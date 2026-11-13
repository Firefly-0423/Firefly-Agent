import type { ToolRiskLevel } from "../../platform/permission/permission";
import type { ToolContext } from "./tool-context";
import { RETIRED_MEMORY_TOOL_IDS } from "./retired-memory-tools";
import type { ConversationMode } from "../../../shared/chat-types";

export type ToolEffectKind = "read" | "mutation" | "verification" | "external_side_effect" | "unknown";
export type VerificationPolicy = "none" | "artifact" | "code" | "unknown";
export type ToolEffectResolver = (input: Record<string, unknown>) => ToolEffectKind;
export type ToolConcurrencyClassifier = (input: Record<string, unknown>) => boolean;
export type VerificationPolicyResolver = (input: Record<string, unknown>) => VerificationPolicy;

export type JsonSchemaProp =
  | { description?: string; type: string; default?: unknown; enum?: string[]; askAliases?: Record<string, unknown> }
  | { items: JsonSchemaProp; type: "array"; description?: string; default?: unknown; askAliases?: Record<string, unknown> }
  | { properties: Record<string, JsonSchemaProp>; type: "object"; required?: string[]; description?: string; default?: unknown; askAliases?: Record<string, unknown> };

export type ControlledInputPolicy = "context_ref" | "context_ref_array" | "tool_result"
  | { kind: string; type: "context_ref" } | { kind: string; type: "context_ref_array" } | { type: "tool_result" };

export function controlledInputType(restriction: ControlledInputPolicy): string {
  if (typeof restriction === "string") return restriction;
  return restriction.type;
}

export function controlledInputKind(restriction: ControlledInputPolicy): string | undefined {
  if (typeof restriction === "object" && "kind" in restriction) return restriction.kind;
  return undefined;
}

// 模型协议字段与 Runtime 策略共用定义，执行许可仍由调度层决定。
export interface ToolDefinition {
  id: string;
  description: string;
  name: string;
  enabled: boolean;
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
  inputSchema: { required?: string[]; type: "object"; properties: Record<string, JsonSchemaProp> };
  catalogHint?: string;
  category?: string;
  capability?: string;
  controlledInput?: Record<string, ControlledInputPolicy>;
  modes?: ConversationMode[];
  risk?: ToolRiskLevel;
  chatBuiltin?: boolean;
  needsContext?: boolean;
  ledgerPolicy?: "success_terminal" | "bypass";
  deprecated?: boolean;
  isConcurrencySafe?: ToolConcurrencyClassifier;
  effectKind?: ToolEffectKind;
  effectResolver?: ToolEffectResolver;
  verificationPolicyResolver?: VerificationPolicyResolver;
  verificationPolicy?: VerificationPolicy;
}

import type { ToolModeOverrides } from "../../../shared/mode-overrides";
export type { ToolModeOverrides };

const retiredMemoryIds = RETIRED_MEMORY_TOOL_IDS;

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  private memoryBackend: "legacy" | "smh";

  constructor(configuration: { personalMemoryMode?: "legacy" | "smh" } = {}) {
    this.memoryBackend = configuration.personalMemoryMode ?? "legacy";
  }

  setPersonalMemoryMode(backend: "legacy" | "smh"): void { this.memoryBackend = backend; }

  private memoryIsRetired(toolId: string): boolean {
    return this.memoryBackend === "smh" && retiredMemoryIds.has(toolId);
  }

  register(definition: ToolDefinition): void {
    if (!retiredMemoryIds.has(definition.id)) {
      this.definitions.set(definition.id, definition);
      return;
    }
    const toolId = definition.id;
    const implementation = definition.execute;
    this.definitions.set(definition.id, {
      ...definition,
      execute: async (input, runContext) => {
        if (this.memoryIsRetired(toolId)) return "MEMORY_LEGACY_RETIRED";
        return implementation(input, runContext);
      },
    });
  }

  unregister(toolId: string): boolean { return this.definitions.delete(toolId); }

  setEnabled(toolId: string, active: boolean): void {
    const definition = this.definitions.get(toolId);
    if (definition) definition.enabled = active;
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.definitions.values()).filter(definition =>
      definition.enabled && !definition.deprecated && !this.memoryIsRetired(definition.id));
  }

  getEnabledToolsForMode(selected: ConversationMode, custom?: ToolModeOverrides): ToolDefinition[] {
    return Array.from(this.definitions.values()).filter(definition => {
      if (!definition.enabled || definition.deprecated || this.memoryIsRetired(definition.id)) return false;
      const chosen = custom?.[definition.id]?.[selected];
      if (chosen !== undefined) return chosen;
      return !definition.modes || definition.modes.includes(selected);
    });
  }

  getAllTools(): ToolDefinition[] { return Array.from(this.definitions.values()); }
  getById(toolId: string): ToolDefinition | undefined { return this.definitions.get(toolId); }
}

export const toolRegistry = new ToolRegistry();

export function resolveEffectKind(
  definition: ToolDefinition | undefined, input: Record<string, unknown>,
): ToolEffectKind {
  if (!definition) return "unknown";
  return definition.effectResolver ? definition.effectResolver(input) : definition.effectKind ?? "unknown";
}

export function resolveVerificationPolicy(
  definition: ToolDefinition | undefined, input: Record<string, unknown>,
): VerificationPolicy {
  if (!definition) return "none";
  return definition.verificationPolicyResolver
    ? definition.verificationPolicyResolver(input) : definition.verificationPolicy ?? "none";
}
