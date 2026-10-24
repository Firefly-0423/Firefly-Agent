export type ReasoningMode = "auto" | "off" | "on";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningControl = "none" | "toggle" | "effort" | "toggle-effort" | "fixed-on" | "dynamic";
export type ReasoningRequestStyle = "openai-effort" | "openrouter-reasoning" | "thinking-type" | "anthropic-adaptive" | "qwen-enable-thinking" | "none";
export type ReasoningCapability = {
    autoEffort?: ReasoningEffort;
    keepOnTools?: boolean;
    supportsDisable: boolean;
    requestStyle: ReasoningRequestStyle;
    defaultEffort?: ReasoningEffort;
    supportedEfforts?: readonly ReasoningEffort[];
    control: ReasoningControl;
};
export type ReasoningPreference = {
    effort?: ReasoningEffort;
    mode: ReasoningMode;
};
export type ModelReasoningRule = {
    ownProviderOnly?: boolean;
    capability: ReasoningCapability;
    modelPattern: RegExp;
    providerId: string;
};
export type ReasoningLevelsConfig = {
    allowOff?: boolean;
    efforts: ReasoningEffort[];
};

const unrecognizedModel: ReasoningCapability = { control: "none", requestStyle: "none", supportsDisable: false };
type PolicyField = { [K in keyof ReasoningCapability]-?: [K, ReasoningCapability[K]] }[keyof ReasoningCapability];
function policy(fields: PolicyField[]): ReasoningCapability {
  return Object.fromEntries(fields) as unknown as ReasoningCapability;
}
function entry(vendor: string, pattern: RegExp, settings: ReasoningCapability, exclusive?: true): ModelReasoningRule {
  // 聚合服务的限定标记在基线中位于 capability 之前。
  return exclusive
    ? { providerId: vendor, modelPattern: pattern, ownProviderOnly: true, capability: settings }
    : { providerId: vendor, modelPattern: pattern, capability: settings };
}
export const MODEL_REASONING_RULES: readonly ModelReasoningRule[] = [
  entry("chatgpt", /^gpt-6/i, policy([["control", "effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh", "max"]], ["defaultEffort", "medium"], ["requestStyle", "openai-effort"], ["supportsDisable", false]])),
  entry("chatgpt", /^gpt-5\.6/i, policy([["control", "effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh", "max"]], ["defaultEffort", "medium"], ["requestStyle", "openai-effort"], ["supportsDisable", true]])),
  entry("chatgpt", /^gpt-5/i, policy([["control", "effort"], ["supportedEfforts", ["minimal", "low", "medium", "high"]], ["defaultEffort", "medium"], ["requestStyle", "openai-effort"], ["supportsDisable", true]])),
  entry("chatgpt", /^o1/i, policy([["control", "effort"], ["supportedEfforts", ["low", "medium", "high"]], ["defaultEffort", "medium"], ["requestStyle", "openai-effort"], ["supportsDisable", true]])),
  entry("chatgpt", /^o3/i, policy([["control", "effort"], ["supportedEfforts", ["low", "medium", "high"]], ["defaultEffort", "medium"], ["requestStyle", "openai-effort"], ["supportsDisable", true]])),
  entry("chatgpt", /^o4/i, policy([["control", "effort"], ["supportedEfforts", ["medium", "high"]], ["defaultEffort", "medium"], ["requestStyle", "openai-effort"], ["supportsDisable", true]])),
  entry("chatgpt", /.*/, unrecognizedModel),
  entry("claude", /^claude-fable-5/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh", "max"]], ["defaultEffort", "high"], ["requestStyle", "anthropic-adaptive"], ["supportsDisable", true]])),
  entry("claude", /^claude-sonnet-5/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh", "max"]], ["defaultEffort", "high"], ["requestStyle", "anthropic-adaptive"], ["supportsDisable", true]])),
  entry("claude", /^claude-opus-4-(8|7|6)/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh", "max"]], ["defaultEffort", "high"], ["requestStyle", "anthropic-adaptive"], ["supportsDisable", true]])),
  entry("claude", /^claude-sonnet-4-6/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh"]], ["defaultEffort", "high"], ["requestStyle", "anthropic-adaptive"], ["supportsDisable", true]])),
  entry("claude", /.*/, unrecognizedModel),
  entry("deepseek", /^deepseek-(?:v4|flash)/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["high", "max"]], ["defaultEffort", "high"], ["requestStyle", "thinking-type"], ["supportsDisable", true], ["autoEffort", "high"]])),
  entry("deepseek", /^deepseek-(chat|reasoner)$/i, unrecognizedModel),
  entry("deepseek", /.*/, unrecognizedModel),
  entry("glm", /^glm-5\.3/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["low", "high", "max"]], ["defaultEffort", "high"], ["requestStyle", "thinking-type"], ["supportsDisable", false], ["autoEffort", "high"]])),
  entry("glm", /^glm-5\.2/i, policy([["control", "toggle-effort"], ["supportedEfforts", ["low", "medium", "high", "xhigh", "max"]], ["defaultEffort", "high"], ["requestStyle", "thinking-type"], ["supportsDisable", true], ["autoEffort", "high"]])),
  entry("glm", /^glm-5-turbo$/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true]])),
  entry("glm", /^glm-5v-turbo$/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true]])),
  entry("glm", /^glm-5\.1/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true]])),
  entry("glm", /^glm-5/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true]])),
  entry("glm", /^glm-(4\.5|4\.6|4\.7)/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true]])),
  entry("glm", /.*/, unrecognizedModel),
  entry("qwen", /-thinking$/i, policy([["control", "fixed-on"], ["requestStyle", "none"], ["supportsDisable", false]])),
  entry("qwen", /^qwen3/i, policy([["control", "toggle"], ["requestStyle", "qwen-enable-thinking"], ["supportsDisable", true]])),
  entry("qwen", /^qwen-(max|plus|turbo)/i, policy([["control", "toggle"], ["requestStyle", "qwen-enable-thinking"], ["supportsDisable", true]])),
  entry("qwen", /.*/, unrecognizedModel),
  entry("kimi", /^kimi-k3/i, policy([["control", "effort"], ["supportedEfforts", ["low", "high", "max"]], ["defaultEffort", "high"], ["requestStyle", "openai-effort"], ["supportsDisable", false], ["autoEffort", "high"]])),
  entry("kimi", /^kimi-k2\.7-code-highspeed$/i, policy([["control", "fixed-on"], ["requestStyle", "none"], ["supportsDisable", false]])),
  entry("kimi", /^kimi-k2\.7-code$/i, policy([["control", "fixed-on"], ["requestStyle", "none"], ["supportsDisable", false]])),
  entry("kimi", /^kimi-k2\.6/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true], ["keepOnTools", true]])),
  entry("kimi", /^kimi-k2\.5/i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true], ["keepOnTools", false]])),
  entry("kimi", /^kimi-k2-thinking/i, policy([["control", "fixed-on"], ["requestStyle", "none"], ["supportsDisable", false]])),
  entry("kimi", /.*/, unrecognizedModel),
  entry("minimax", /^MiniMax-M3/i, policy([["control", "toggle"], ["requestStyle", "anthropic-adaptive"], ["supportsDisable", true]])),
  entry("minimax", /^MiniMax-M2\./i, policy([["control", "fixed-on"], ["requestStyle", "none"], ["supportsDisable", false]])),
  entry("minimax", /.*/, unrecognizedModel),
  entry("mimo", /^mimo-v2\./i, policy([["control", "toggle"], ["requestStyle", "thinking-type"], ["supportsDisable", true]])),
  entry("mimo", /.*/, unrecognizedModel),
  entry("openrouter", /.*/, policy([["control", "effort"], ["supportedEfforts", ["low", "medium", "high", "max"]], ["defaultEffort", "medium"], ["requestStyle", "openrouter-reasoning"], ["supportsDisable", true]]), true),
];

function modelPolicy(vendor: string, modelName: string): ReasoningCapability {
  const matches = (candidate: ModelReasoningRule): boolean =>
    candidate.modelPattern.test(modelName) && candidate.capability !== unrecognizedModel;
  const local = MODEL_REASONING_RULES.find(candidate => candidate.providerId === vendor && matches(candidate));
  if (local) return local.capability;
  const inferred = MODEL_REASONING_RULES.find(candidate => matches(candidate) && !candidate.ownProviderOnly);
  return inferred?.capability ?? unrecognizedModel;
}

export function resolveReasoningCapability(
  vendor: string, modelName: string, declaredLevels?: ReasoningLevelsConfig,
  defaultStyle: Exclude<ReasoningRequestStyle, "none"> = "openai-effort",
): ReasoningCapability {
  const known = modelPolicy(vendor, modelName);
  return declaredLevels ? declaredPolicy(known, declaredLevels, defaultStyle) : known;
}

export function resolveEffectiveReasoning(
  saved: ReasoningPreference | undefined, policy: ReasoningCapability, override?: -1 | 0 | 1,
): ReasoningPreference {
  const requested = saved ?? { mode: "auto" };
  if (override === -1 || (override !== 1 && (policy.control === "none" || policy.control === "dynamic"))) {
    return { mode: "auto" };
  }
  if (policy.control === "fixed-on") return { mode: "on" };
  const selectedMode = requested.mode;
  if (selectedMode !== "on") return { mode: selectedMode };
  let selectedEffort = requested.effort;
  if (selectedEffort !== undefined && policy.supportedEfforts && !policy.supportedEfforts.includes(selectedEffort)) {
    selectedEffort = policy.defaultEffort;
  }
  if (selectedEffort === undefined && policy.defaultEffort) selectedEffort = policy.defaultEffort;
  return selectedEffort === undefined ? { mode: selectedMode } : { mode: selectedMode, effort: selectedEffort };
}

const effortScale: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export function normalizeReasoningLevels(candidate: unknown): ReasoningLevelsConfig | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const declaration = candidate as { efforts?: unknown; allowOff?: unknown };
  const requested = new Set(Array.isArray(declaration.efforts) ? declaration.efforts : []);
  const supported = effortScale.filter(level => requested.has(level));
  return declaration.allowOff === true ? { efforts: [...supported], allowOff: true } : { efforts: [...supported] };
}

function defaultForLevels(supported: readonly ReasoningEffort[], desired?: ReasoningEffort): ReasoningEffort | undefined {
  if (desired && supported.includes(desired)) return desired;
  const ordinary = (["medium", "high"] as const).find(level => supported.includes(level));
  return ordinary ?? supported[Math.floor(supported.length / 2)];
}

function declaredPolicy(
  known: ReasoningCapability, declaration: ReasoningLevelsConfig,
  protocolDefault: Exclude<ReasoningRequestStyle, "none">,
): ReasoningCapability {
  const supported = declaration.efforts;
  const anyLevels = supported.length > 0;
  const style = known.requestStyle === "none" ? protocolDefault : known.requestStyle;
  const offUsesEffort = style === "openai-effort" || style === "openrouter-reasoning";
  const meaningfulToggle = !offUsesEffort || declaration.allowOff === true;
  return {
    ...known,
    control: anyLevels ? "effort" : meaningfulToggle ? "toggle" : "none",
    requestStyle: style,
    supportedEfforts: anyLevels ? supported : undefined,
    defaultEffort: anyLevels ? defaultForLevels(supported, known.defaultEffort) : undefined,
    autoEffort: known.autoEffort && supported.includes(known.autoEffort) ? known.autoEffort : undefined,
    supportsDisable: declaration.allowOff === true,
  };
}

const acceptedModes = new Set<ReasoningMode>(["auto", "off", "on"]);
const acceptedEfforts = new Set<ReasoningEffort>(effortScale);
export function normalizeReasoningPreference(candidate: unknown): ReasoningPreference | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const saved = candidate as { mode?: unknown; effort?: unknown; proMode?: unknown };
  if (typeof saved.mode !== "string" || !acceptedModes.has(saved.mode as ReasoningMode)) return undefined;
  const chosenMode = saved.mode as ReasoningMode;
  const hasEffortValue = saved.effort !== undefined && saved.effort !== null;
  let chosenEffort: ReasoningEffort | undefined;
  if (saved.effort === "pro") chosenEffort = "max";
  else if (hasEffortValue && typeof saved.effort === "string" && acceptedEfforts.has(saved.effort as ReasoningEffort)) {
    chosenEffort = saved.effort as ReasoningEffort;
  } else if (!hasEffortValue && chosenMode === "on" && saved.proMode === true) chosenEffort = "max";
  return chosenEffort === undefined ? { mode: chosenMode } : { mode: chosenMode, effort: chosenEffort };
}

export function foldReasoning(
  submitted: unknown, saved: ReasoningPreference | undefined, present: boolean,
): ReasoningPreference | undefined {
  if (present) {
    if (submitted === null || submitted === undefined) return undefined;
    return normalizeReasoningPreference(submitted) ?? saved;
  }
  return saved;
}
