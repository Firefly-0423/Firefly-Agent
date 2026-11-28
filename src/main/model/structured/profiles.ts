import type {
  StructuredOutputProfile, StructuredOutputProfileContext, StructuredOutputRepairPolicy,
  StructuredOutputTier, StructuredOutputMode, StructuredOutputVerification,
} from "./types";

type ProfileRow = readonly [
  id: string, provider: string, transport: StructuredOutputProfileContext["transport"],
  pattern: RegExp, tier: Exclude<StructuredOutputTier, "D">,
  mode: StructuredOutputMode, verification: StructuredOutputVerification,
  hints?: Partial<StructuredOutputProfile["requestHints"]>,
];

const catalog: readonly ProfileRow[] = [
  ["openai-structured-output", "chatgpt", "openai",
    /^(?:gpt-6(?:$|-)|gpt-5(?:\.\d+)?(?:-(?:sol|terra|luna))?|gpt-4\.1(?:$|-)|gpt-4o-mini(?:$|-)|gpt-4o-(?:2024-08-06|2024-11-20)|o[134](?:$|-))/i,
    "A", "provider_json_schema", "official"],
  ["claude-structured-output", "claude", "anthropic",
    /^claude-(?:fable-5|mythos(?:-5|-preview)|opus-4-[5-8]|sonnet-(?:5|4-[56])|haiku-4-5)(?:$|-\d{8})/i,
    "A", "provider_json_schema", "official"],
  ["kimi-structured-output", "kimi", "openai",
    /^(?:kimi-for-coding|kimi-(?:k3|k2\.(?:6|7-code(?:-highspeed)?)))(?:$|-)/i,
    "A", "provider_json_schema", "official"],
  ["deepseek-json-object", "deepseek", "openai", /^deepseek-(?:v4-(?:pro|flash)|flash)$/i,
    "B", "provider_json_object", "official"],
  ["qwen-json-object", "qwen", "openai", /^(?:qwen3\.(?:7-(?:max|plus)|[56]-plus)|qwen-flash)(?:$|-)/i,
    "B", "provider_json_object", "official"],
  ["glm-json-object", "glm", "openai", /^glm-(?:5\.[123]|4\.[67])(?:$|-)/i,
    "B", "provider_json_object", "official"],
  ["mimo-json-object", "mimo", "openai", /^mimo-v2\.5(?:$|-)/i,
    "B", "provider_json_object", "official"],
  ["minimax-m3-adapter", "minimax", "openai", /^MiniMax-M3(?:$|[-_])/i,
    "M", "prompt_json", "contract_verified", { sendJsonObject: true, reasoningSplit: true }],
];

const memoryPolicy: StructuredOutputRepairPolicy = {
  maxAttempts: 2, totalBudgetMs: 15_000, perAttemptTimeoutMs: 8_000, minimumRemainingBudgetMs: 500,
};
function repairTable(total: number, perCall: number): StructuredOutputProfile["repair"] {
  const standard: StructuredOutputRepairPolicy = {
    maxAttempts: 2, totalBudgetMs: total, perAttemptTimeoutMs: perCall, minimumRemainingBudgetMs: 800,
  };
  return {
    task_router: standard, planner: standard, native_fc: standard, memory: standard,
    memory_judge: memoryPolicy, memory_compress: memoryPolicy,
    memory_reflect: memoryPolicy, memory_resolve: memoryPolicy,
  };
}
const repairs = {
  D: repairTable(10_000, 5_000),
  A: repairTable(25_000, 12_500),
  B: repairTable(20_000, 10_000),
  M: repairTable(12_000, 7_000),
};
const conservative: StructuredOutputProfile = {
  id: "prompt-json-fallback", provider: "unknown", model: "unknown", tier: "D",
  mode: "prompt_json", verification: "contract_required", allowCapabilityPromotion: false,
  requestHints: { sendJsonObject: false, reasoningSplit: false }, reasoning: "disabled", repair: repairs.D,
};

export function resolveStructuredOutputProfile(context: StructuredOutputProfileContext): StructuredOutputProfile {
  const otherwise: StructuredOutputProfile = { ...conservative, provider: context.provider, model: context.model };
  if (context.endpointKind !== "official") return otherwise;
  const row = catalog.find((entry) => entry[1] === context.provider
    && entry[2] === context.transport && entry[3].test(context.model));
  if (!row) return otherwise;
  const [id, provider, transport, , tier, mode, verification, hints] = row;
  return {
    id, provider, model: context.model, transport, tier, mode, verification,
    allowCapabilityPromotion: false,
    requestHints: { sendJsonObject: hints?.sendJsonObject ?? false, reasoningSplit: hints?.reasoningSplit ?? false },
    reasoning: "disabled", repair: repairs[tier],
  };
}

function endpointKey(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}
export function classifyStructuredOutputEndpoint(input: {
  providerId: string;
  configuredBaseUrl: string;
  officialBaseUrl: string;
}): StructuredOutputProfileContext["endpointKind"] {
  const requested = endpointKey(input.configuredBaseUrl);
  const alternatives = [input.officialBaseUrl,
    ...(input.providerId === "kimi" ? ["https://api.kimi.com/coding/v1"] : [])]
    .filter(Boolean).map(endpointKey);
  if (/^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(requested)) return "local";
  return input.providerId === "unknown" || !requested || !alternatives.includes(requested) ? "custom" : "official";
}
