import {
  resolveEffectiveReasoning, resolveReasoningCapability,
  type ReasoningEffort, type ReasoningPreference, type ReasoningLevelsConfig,
} from "../../shared/reasoning";

export interface ReasoningDropdownItem {
  hint?: string;
  disabled?: boolean;
  preference: ReasoningPreference;
  label: string;
}
export interface ReasoningDropdownView {
  items: ReasoningDropdownItem[];
  activePreference: ReasoningPreference;
  statusText: string;
  disabled: boolean;
}
const effortNames: Record<ReasoningEffort, string> = {
  max: "max", xhigh: "xhigh", high: "high", medium: "medium", low: "low", minimal: "minimal",
};
function statusTextFor(preference: ReasoningPreference): string {
  switch (preference.mode) {
    case "auto": return "跟随模型";
    case "off": return "关闭";
    default: return preference.effort ? effortNames[preference.effort] : "开启";
  }
}
function lockedView(active: ReasoningPreference, text: string, mode: ReasoningPreference["mode"], hint: string): ReasoningDropdownView {
  return {
    disabled: true,
    statusText: text,
    activePreference: active,
    items: [{ label: text, preference: { mode }, disabled: true, hint }],
  };
}
export function computeReasoningDropdown(
  providerId: string, model: string, saved: ReasoningPreference | undefined,
  thinkingOverride?: -1 | 0 | 1, levels?: ReasoningLevelsConfig,
): ReasoningDropdownView {
  const capability = resolveReasoningCapability(providerId, model, levels);
  const active = resolveEffectiveReasoning(saved, capability, thinkingOverride);
  if (thinkingOverride === -1) return lockedView(active, "跟随模型", "auto", "当前模型未配置推理控制");
  if (thinkingOverride !== 1) {
    switch (capability.control) {
      case "fixed-on": return lockedView(active, "始终开启", "on", "该模型始终思考，无法关闭");
      case "dynamic": return lockedView(active, "跟随动态路由", "auto", "由服务端动态路由决定");
      case "none": return lockedView(active, "跟随模型", "auto", "当前模型未配置推理控制");
    }
  }
  const choices: ReasoningDropdownItem[] = [{ label: "跟随模型", preference: { mode: "auto" } }];
  if (thinkingOverride === 1 || capability.supportsDisable) choices.push({ label: "关闭", preference: { mode: "off" } });
  if (thinkingOverride === 1 || capability.control === "toggle") {
    choices.push({ label: "开启", preference: { mode: "on" } });
  } else {
    for (const effort of capability.supportedEfforts ?? []) {
      choices.push({ label: effortNames[effort], preference: { mode: "on", effort } });
    }
  }
  return {
    disabled: false,
    statusText: statusTextFor(active),
    activePreference: active,
    items: choices,
  };
}
export function formatReasoningTriggerLabel(statusText: string): string {
  return "推理 · " + statusText;
}
