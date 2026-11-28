import {
  resolveEffectiveReasoning, resolveReasoningCapability,
  type ReasoningLevelsConfig, type ReasoningPreference,
} from "../../../shared/reasoning";
import type { Transport } from "./types";
import { getVendorRuntimeSettings } from "./runtime-settings";

export type ToolChoicePolicy =
  | { kind: "omit" } | { kind: "auto" } | { kind: "required" } | { kind: "named"; name: string };
export type ToolChoicePolicyInput = {
  supportedModes?: ReadonlyArray<ToolChoicePolicy["kind"]>;
  requestedToolName: string;
  reasoningLevels?: ReasoningLevelsConfig;
  reasoning: ReasoningPreference;
  transport: Transport;
  model: string;
  providerId: string;
};
export type AutomaticToolChoicePolicyInput = Omit<ToolChoicePolicyInput, "requestedToolName">;

function mayThink(request: AutomaticToolChoicePolicyInput): boolean {
  const preference = resolveEffectiveReasoning(request.reasoning,
    resolveReasoningCapability(request.providerId, request.model, request.reasoningLevels,
      request.transport === "anthropic" ? "anthropic-adaptive" : "openai-effort"),
    getVendorRuntimeSettings().thinkingOverride);
  return preference.mode === "on" || preference.mode === "auto";
}
export function resolveAutomaticToolChoicePolicy(input: AutomaticToolChoicePolicyInput): "auto" | "omit" {
  if (input.providerId === "deepseek" && mayThink(input)) return "omit";
  return input.supportedModes && !input.supportedModes.includes("auto") ? "omit" : "auto";
}
export function resolveToolChoicePolicy(input: ToolChoicePolicyInput): ToolChoicePolicy {
  const active = mayThink(input);
  const permitted = input.supportedModes;
  let wanted: ToolChoicePolicy["kind"];
  if (input.providerId === "minimax" || input.providerId === "anySearch") wanted = "auto";
  else if (input.providerId === "deepseek" && active) wanted = "omit";
  else if (input.providerId === "kimi" && active) wanted = "auto";
  else if (input.transport === "anthropic" && active) wanted = "auto";
  else wanted = active ? "auto" : "named";
  if (permitted?.length && !permitted.includes(wanted)) {
    wanted = (["named", "required", "auto", "omit"] as const).find((kind) => permitted.includes(kind)) ?? "omit";
  }
  return wanted === "named" ? { kind: wanted, name: input.requestedToolName } : { kind: wanted };
}
