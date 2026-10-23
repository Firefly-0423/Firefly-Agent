import { resolveEffectiveReasoning, type ReasoningCapability, type ReasoningPreference } from "../../../shared/reasoning";
import { getVendorRuntimeSettings } from "./runtime-settings";

export type ApplyReasoningContext = { model: string; providerId: string; hasTools: boolean };

function writeEffortField(target: Record<string, unknown>, rules: ReasoningCapability, level: string): void {
  if (rules.requestStyle !== "openrouter-reasoning") {
    target.reasoning_effort = level;
    return;
  }
  target.reasoning = { effort: level === "max" ? "xhigh" : level };
}
function enabledThinking(rules: ReasoningCapability, call: ApplyReasoningContext): Record<string, unknown> {
  return rules.keepOnTools === true && call.hasTools ? { type: "enabled", keep: "all" } : { type: "enabled" };
}
function chosenEffort(preference: ReasoningPreference, rules: ReasoningCapability): string {
  let level = preference.effort ?? rules.defaultEffort ?? "medium";
  if (preference.effort !== undefined && rules.supportedEfforts && !rules.supportedEfforts.includes(preference.effort)) {
    level = rules.defaultEffort ?? level;
  }
  return level;
}
function disableReasoning(target: Record<string, unknown>, rules: ReasoningCapability): void {
  if (rules.control === "effort") {
    if (rules.supportsDisable) writeEffortField(target, rules, "none");
    return;
  }
  if (rules.control !== "toggle" && rules.control !== "toggle-effort") return;
  const style = rules.requestStyle;
  if (style === "openai-effort" || style === "openrouter-reasoning") {
    if (rules.supportsDisable) writeEffortField(target, rules, "none");
  } else if (style === "thinking-type" || style === "anthropic-adaptive") {
    target.thinking = { type: "disabled" };
  } else if (style === "qwen-enable-thinking" && rules.control === "toggle") {
    target.enable_thinking = false;
  }
}
function enableReasoning(target: Record<string, unknown>, rules: ReasoningCapability,
  preference: ReasoningPreference, call: ApplyReasoningContext): void {
  if (rules.control === "effort") {
    writeEffortField(target, rules, chosenEffort(preference, rules));
    return;
  }
  if (rules.control === "toggle") {
    if (rules.requestStyle === "qwen-enable-thinking") target.enable_thinking = true;
    else if (rules.requestStyle === "thinking-type") target.thinking = enabledThinking(rules, call);
    else if (rules.requestStyle === "anthropic-adaptive") target.thinking = { type: "adaptive" };
    return;
  }
  if (rules.control !== "toggle-effort") return;
  const level = chosenEffort(preference, rules);
  if (rules.requestStyle === "openai-effort" || rules.requestStyle === "openrouter-reasoning") {
    writeEffortField(target, rules, level);
  } else if (rules.requestStyle === "thinking-type") {
    target.thinking = enabledThinking(rules, call);
    target.reasoning_effort = level;
  } else if (rules.requestStyle === "anthropic-adaptive") {
    target.thinking = { type: "adaptive" };
    const previous = (target.output_config ?? {}) as Record<string, unknown>;
    target.output_config = { ...previous, effort: level };
  }
}
export function applyReasoningPreference(body: Record<string, unknown>, preference: ReasoningPreference,
  capability: ReasoningCapability, context: ApplyReasoningContext): Record<string, unknown> {
  let normalized = resolveEffectiveReasoning(preference, capability, getVendorRuntimeSettings().thinkingOverride);
  const wire: Record<string, unknown> = { ...body };
  const before = `${preference.mode}/${preference.effort ?? "-"}`;
  const after = `${normalized.mode}/${normalized.effort ?? "-"}`;
  if (before !== after) {
    console.log(`[reasoning] provider=${context.providerId} model=${context.model} requested=${before} effective=${after}`);
  }
  if (capability.control === "none" || capability.control === "dynamic") return wire;
  if (capability.control === "fixed-on") {
    const style = capability.requestStyle;
    if (style === "thinking-type") wire.thinking = { type: "enabled" };
    else if (style === "anthropic-adaptive") wire.thinking = { type: "adaptive" };
    else if (style === "qwen-enable-thinking") wire.enable_thinking = true;
    else if (style !== "openai-effort" && style !== "openrouter-reasoning" && style !== "none") {
      const impossible: never = style;
      throw new Error(`unsupported requestStyle: ${String(impossible)}`);
    }
    return wire;
  }
  if (normalized.mode === "auto" && capability.autoEffort) normalized = { mode: "on", effort: capability.autoEffort };
  if (normalized.mode === "off" && !capability.supportsDisable) normalized = { mode: "on" };
  if (normalized.mode === "off") disableReasoning(wire, capability);
  else if (normalized.mode === "on") enableReasoning(wire, capability, normalized, context);
  return wire;
}
