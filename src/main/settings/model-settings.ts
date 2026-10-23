import fs from "node:fs";
import { createModelConnectionState, normalizeConnectionConfig } from "./model-connection-state";
import type { ModelConnectionSnapshot } from "../../shared/model-connection-types";
import type { TestConnectionResult, VendorConfig } from "../orchestrator/vendors/types";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeProfile } from "../runtime-profile";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../orchestrator/model-config";
import { LEGACY_DEFAULT_CONTEXT_WINDOW_TOKENS, parseContextWindowTokens, resolveContextWindowTokens } from "../../shared/context-window";
import { foldReasoning, normalizeReasoningLevels, normalizeReasoningPreference, type ReasoningLevelsConfig, type ReasoningPreference } from "../../shared/reasoning";
import type { StickerSize } from "../../shared/sticker-types";
import { getSettingsPath } from "../settings-store";
import { logger, LogTag } from "../logger";
import { getCapabilityOrOpenAI } from "../orchestrator/vendors/capabilities";
import { resolveInputModalities } from "../orchestrator/vendors/multimodal";
import { normalizeDeclaredInputModalities, type InputModality, type InputModalitySource } from "../../shared/input-modalities";
import { addModelProfile, resolveDefaultModelProfile, updateModelProfile, type SavedModelProfile } from "./model-catalog";
import { normalizeAgentModelProfiles } from "./agent-model-routing";
import { decodeCredentials, migrateCredentials, writeCredentials, MODEL_CREDENTIAL_FIELDS } from "./credential-storage";

/**
 * 统一模型配置入口：所有模块（包括 Code 模式）必须通过此函数读取。
 * 禁止在 Code 模块本地复制读取 JSON 逻辑。
 */
export type { PublicModelConfig } from "../../shared/model-connection-types";
import type { PublicModelConfig } from "../../shared/model-connection-types";

// 每个厂商各存一份配置：切走再切回来时，从这里把字段原样恢复。
export type ProviderProfile = {
  inputModalitiesSource?: InputModalitySource; // inputModalities 的来源，仅用于界面说明：厂商接口记录或用户手动覆盖
  /** 显式声明的输入模态（图片 / 仅文本）。未声明时按内置目录，再回落到仅文本（见 resolveInputModalities）。只存一份，用户覆盖会替换厂商接口的记录。 */
  inputModalities?: InputModality[];
  /** 上下文窗口（token）。档案级字段，范围 4096 到 1M；未设置时回退到顶层 ModelSettings.contextWindowTokens（默认 1M）。 */
  contextWindowTokens?: number;
  /**
   * 这个 API 真正支持的推理档位，由用户在 API 设置里声明。未声明时按型号名回退到 shared/reasoning 的规则表；
   * 声明过则以声明为准。
   */
  reasoningLevels?: ReasoningLevelsConfig;
  /**
   * 用户保存的推理偏好，是唯一的真值来源；顶层 ModelSettings.reasoning 只是当前厂商的镜像。
   * 即便当前模型不支持某个 effort，偏好也保留着，真正发请求时由 resolveEffectiveReasoning 算出实际生效的配置。
   */
  reasoning?: ReasoningPreference;
  explicitTransport?: "openai" | "anthropic" | "responses";
  displayName?: string;
  apiKey: string;
  model: string;
  baseUrl: string;
};

export type ModelSettings = {
  // 状态栏的展示名：用户自己起的昵称，留空时使用厂商的 shortName
  displayName?: string;
  // 图片能力相关：inputModalities 的镜像，真值同样在 perProvider[provider] 里
  inputModalitiesSource?: InputModalitySource;
  inputModalities?: InputModality[];
  /** 上下文窗口（token）。默认 1M，上限 1M，取值规则来自 shared/context-window。 */
  contextWindowTokens: number;
  /**
   * 上下文窗口迁移标记。没有这个字段就是旧存档：旧设置页把“留空”固化为 256000 写进每个档案，
   * 读取时把恰好是 256000 的值视为未设置、回到默认 1M；写盘后会带上 2，之后用户手填的 256000 原样保留。
   */
  contextWindowVersion?: 2;
  thinkingOverride?: -1 | 0 | 1;
  disableMaxToken?: boolean;
  /**
   * 当前主模型能否直接收图：由 resolveInputModalities 结合当前厂商的显式声明与内置目录算出，不是独立开关。
   * 写盘时同步刷新；读到旧存档里同名的字段会被忽略。
   */
  multimodal: boolean;
  /**
   * Embedding 维度（可选，仅 cloud 模式生效）。
   * 留空表示首次请求时自动探测；填了则当作严格声明，并和实际返回值做校验。
   */
  embeddingDimensions?: number;
  embeddingModel: "bgem3";
  rerankerMode: "standard" | "none";
  /** 整个聊天请求的总超时（秒），范围 30–1800，默认 300。 */
  chatRequestTimeoutSec: number;
  stickerSimilarityThreshold: number;
  stickerSize: StickerSize;
  stickerEnabled: boolean;
  specialistModelProfiles?: Record<string, string>;
  agentModelProfiles?: Record<string, string>;
  defaultModelProfileId?: string;
  /** 用户保存的可选模型；默认项决定新对话与非对话任务使用哪个模型。 */
  modelProfiles?: SavedModelProfile[];
  // 按厂商缓存：不是当前厂商的配置也留在这里，切回时从这里恢复。
  // 真值在 perProvider；顶层的 baseUrl / model / apiKey 只是当前厂商那一份的展开镜像，
  // Main 进程读取的是当前档案的顶层镜像。
  perProvider: Record<string, ProviderProfile>;
  /** 当前模型档案所声明推理档位的镜像，参见 ProviderProfile.reasoningLevels。 */
  reasoningLevels?: ReasoningLevelsConfig;
  /**
   * 当前厂商的推理偏好镜像，和 explicitTransport 的思路一致：真值在 perProvider[currentProvider].reasoning，
   * 顶层字段只是一个视图。保存的是用户的偏好（不做覆盖）；实际生效的配置由 capability 决定。
   */
  reasoning?: ReasoningPreference;
  /**
   * 当前厂商 explicitTransport 的镜像（顶层字段是 perProvider[currentProvider] 的视图），
   * 详见 ProviderProfile.explicitTransport。
   */
  explicitTransport?: "openai" | "anthropic" | "responses";
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
  schemaVersion: 2;
  mode: "auto" | "manual";
};

/** 当前配置文件的 schema 版本。 */
const MODEL_SETTINGS_SCHEMA_VERSION = 2;
const modelConnections = createModelConnectionState();

function refreshModelConnections(settings: ModelSettings): void {
  modelConnections.refresh(listSavedModelProfiles(settings), getDefaultModelProfile(settings)?.id);
}
export function getModelConnectionSnapshot(): ModelConnectionSnapshot {
  refreshModelConnections(loadModelSettings());
  return modelConnections.snapshot();
}
export const onModelConnectionChanged = modelConnections.subscribe;
export function testModelConnection(input: unknown, driver: (config: VendorConfig) => Promise<TestConnectionResult>): Promise<TestConnectionResult> {
  const config = normalizeConnectionConfig(input);
  refreshModelConnections(loadModelSettings());
  return modelConnections.test(config, driver);
}

// 默认厂商为 MiniMax（v1 适配器里第一个落地的厂商）；DeepSeek 已从 v1 清单中移除。
const DEFAULT_PROVIDER = "MiniMax（稀宇科技）";
const DEFAULT_ENDPOINT = { baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3" };

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  mode: "auto",
  schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
  provider: DEFAULT_PROVIDER,
  baseUrl: DEFAULT_ENDPOINT.baseUrl,
  model: DEFAULT_ENDPOINT.model,
  apiKey: "",
  explicitTransport: "anthropic",
  perProvider: {},
  stickerEnabled: false,
  stickerSize: "standard",
  stickerSimilarityThreshold: 0.55,
  chatRequestTimeoutSec: 300,
  rerankerMode: "standard",
  embeddingModel: "bgem3",
  multimodal: resolveInputModalities({ provider: DEFAULT_PROVIDER, model: DEFAULT_ENDPOINT.model }).image,
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
};

/** 字符串去首尾空白；非字符串统一当作空串。 */
const trimmedText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
/** 夹在 [low, high] 区间内。 */
const clampTo = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

function resolveProfileTransport(
  input: Partial<ProviderProfile> | null | undefined,
  provider: string,
): ProviderProfile["explicitTransport"] {
  const declared = input?.explicitTransport;
  if (declared === "openai" || declared === "anthropic" || declared === "responses") return declared;
  return getCapabilityOrOpenAI(provider).transport;
}

function normalizeProviderProfile(input: Partial<ProviderProfile> | null | undefined, provider = DEFAULT_MODEL_SETTINGS.provider, legacyContextWindow = false): ProviderProfile {
  const explicitTransport: ProviderProfile["explicitTransport"] = resolveProfileTransport(input, provider);
  const rawContextWindow = (input as { contextWindowTokens?: unknown })?.contextWindowTokens;
  return {
    baseUrl: trimmedText(input?.baseUrl),
    model: trimmedText(input?.model),
    apiKey: trimmedText(input?.apiKey),
    displayName: trimmedText(input?.displayName) || undefined,
    explicitTransport,
    reasoning: normalizeReasoningPreference((input as { reasoning?: unknown })?.reasoning),
    reasoningLevels: normalizeReasoningLevels((input as { reasoningLevels?: unknown })?.reasoningLevels),
    // 非法值记为 undefined（回退全局设置），并夹在 4096 到 1M 之间，和界面输入框保持一致。
    // 旧存档里恰好是 256000 的值，是旧版固化下来的默认，按未设置处理。
    contextWindowTokens: legacyContextWindow && rawContextWindow === LEGACY_DEFAULT_CONTEXT_WINDOW_TOKENS
      ? undefined
      : parseContextWindowTokens(rawContextWindow),
    // 输入模态声明：非法时不写入（回退到内置目录），规则见 normalizeDeclaredInputModalities
    ...normalizeDeclaredInputModalities(input?.inputModalities, input?.inputModalitiesSource),
  };
}

export function normalizeModelSettings(input: Partial<ModelSettings> | null | undefined): ModelSettings {
  const mode: "auto" | "manual" = input?.mode === "manual" ? "manual" : "auto";
  const provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : DEFAULT_MODEL_SETTINGS.provider;

  const legacyContextWindow = (input as { contextWindowVersion?: unknown } | undefined)?.contextWindowVersion !== 2;

  // 清洗 perProvider：跳过非对象和非法的键
  const rawPerProvider = (input as ModelSettings | undefined)?.perProvider;
  const perProvider: Record<string, ProviderProfile> = {};
  if (rawPerProvider && typeof rawPerProvider === "object") {
    for (const [key, value] of Object.entries(rawPerProvider)) {
      const providerName = typeof key === "string" ? key.trim() : "";
      if (!providerName) continue;
      perProvider[providerName] = normalizeProviderProfile(value as Partial<ProviderProfile>, providerName, legacyContextWindow);
    }
  }

  if (!perProvider[provider]) {
    perProvider[provider] = normalizeProviderProfile({
      baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl : provider === DEFAULT_MODEL_SETTINGS.provider ? DEFAULT_MODEL_SETTINGS.baseUrl : "",
      model: typeof input?.model === "string" ? input.model : provider === DEFAULT_MODEL_SETTINGS.provider ? DEFAULT_MODEL_SETTINGS.model : "",
      apiKey: typeof input?.apiKey === "string" ? input.apiKey : "",
      explicitTransport: input?.explicitTransport,
    }, provider, legacyContextWindow);
  }

  // 顶层镜像：由 perProvider[provider] 展开而来
  const profile = perProvider[provider];

  // 图片能力只有一个入口 resolveInputModalities：显式声明 > 内置目录 > 仅文本。旧存档里的 multimodal / vision 字段直接忽略。
  const multimodal = resolveInputModalities({
    provider,
    model: profile.model,
    declared: profile.inputModalities,
    declaredSource: profile.inputModalitiesSource,
  }).image;

  const modelProfiles: SavedModelProfile[] = Array.isArray(input?.modelProfiles)
    ? input.modelProfiles.filter((item): item is SavedModelProfile => Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.provider === "string"))
      .map((item) => ({ ...normalizeProviderProfile(item, item.provider, legacyContextWindow), id: item.id, provider: item.provider }))
    : [];

  return {
    mode, schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION, provider, displayName: profile.displayName,
    baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey, explicitTransport: profile.explicitTransport,
    reasoning: profile.reasoning, // 顶层镜像，与 explicitTransport 同源（perProvider[currentProvider].reasoning）
    reasoningLevels: profile.reasoningLevels,
    inputModalities: profile.inputModalities, inputModalitiesSource: profile.inputModalitiesSource,
    perProvider, modelProfiles,
    defaultModelProfileId: typeof input?.defaultModelProfileId === "string" ? input.defaultModelProfileId : modelProfiles[0]?.id,
    agentModelProfiles: normalizeAgentModelProfiles(input?.agentModelProfiles),
    specialistModelProfiles: normalizeAgentModelProfiles(input?.specialistModelProfiles),
    stickerEnabled: input?.stickerEnabled === true,
    stickerSize: input?.stickerSize === "small" || input?.stickerSize === "large" ? input.stickerSize : "standard",
    stickerSimilarityThreshold: typeof input?.stickerSimilarityThreshold === "number"
      ? clampTo(input.stickerSimilarityThreshold, 0.3, 0.9)
      : 0.55,
    chatRequestTimeoutSec: typeof input?.chatRequestTimeoutSec === "number" && Number.isFinite(input.chatRequestTimeoutSec)
      ? clampTo(Math.round(input.chatRequestTimeoutSec), 30, 1800)
      : 300,
    rerankerMode: input?.rerankerMode === "none" ? "none" : "standard",
    embeddingModel: "bgem3",
    embeddingDimensions: typeof input?.embeddingDimensions === "number" && Number.isFinite(input.embeddingDimensions) && input.embeddingDimensions > 0 ? Math.round(input.embeddingDimensions) : undefined,
    multimodal,
    thinkingOverride: input?.thinkingOverride,
    disableMaxToken: input?.disableMaxToken,
    contextWindowTokens: legacyContextWindow && input?.contextWindowTokens === LEGACY_DEFAULT_CONTEXT_WINDOW_TOKENS
      ? DEFAULT_CONTEXT_WINDOW_TOKENS
      : resolveContextWindowTokens(input?.contextWindowTokens),
    contextWindowVersion: 2,
  };
}

export function listSavedModelProfiles(settings = loadModelSettings()): SavedModelProfile[] {
  const { modelProfiles } = settings;
  return modelProfiles ?? [];
}

export function getDefaultModelProfile(settings = loadModelSettings()): SavedModelProfile | undefined {
  const profiles = listSavedModelProfiles(settings);
  return resolveDefaultModelProfile(profiles, settings.defaultModelProfileId);
}

/**
 * 为一次对话展开已保存的模型。
 * - 传入 id：展开该档案；档案不存在时退回当前设置。
 * - 不传 id：展开默认档案（defaultModelProfileId，缺失时取第一个）；没有任何档案时原样返回 settings。
 *
 * 不传 id 时绝不能退回顶层镜像：顶层镜像对应当前厂商在 perProvider 里的那一项，可能是空的
 * （用户只在档案里配了模型）。渠道机器人、定时任务这类不带 profileId 的调用方，曾因此拿到空的 baseUrl 直接报错，
 * 飞书、微信渠道就会出现“消息能看到但不回复”的情况。
 */
export function resolveModelSettingsProfile(settings: ModelSettings, id?: string): ModelSettings {
  const profiles = listSavedModelProfiles(settings);
  const profile = id
    ? profiles.find((item) => item.id === id)
    : resolveDefaultModelProfile(profiles, settings.defaultModelProfileId);
  if (!profile) return settings;
  // 图片能力只看档案本身，不回落到顶层镜像（镜像只代表当前厂商那一份）
  const multimodal = resolveInputModalities({
    provider: profile.provider,
    model: profile.model,
    declared: profile.inputModalities,
    declaredSource: profile.inputModalitiesSource,
  }).image;
  return {
    ...settings,
    provider: profile.provider, displayName: profile.displayName, baseUrl: profile.baseUrl, model: profile.model,
    apiKey: profile.apiKey, explicitTransport: profile.explicitTransport, reasoning: profile.reasoning, reasoningLevels: profile.reasoningLevels,
    // 档案级的上下文窗口覆盖顶层值；档案没设置时沿用全局值（老档案的行为不变）
    contextWindowTokens: profile.contextWindowTokens ?? settings.contextWindowTokens,
    inputModalities: profile.inputModalities,
    inputModalitiesSource: profile.inputModalitiesSource,
    multimodal,
  };
}

export function saveModelProfile(input: Omit<SavedModelProfile, "id"> & { id?: string }): { settings: ModelSettings; added: boolean } {
  assertModelSettingsReadable();
  const existing = loadModelSettings();
  const profile: SavedModelProfile = { ...normalizeProviderProfile(input, input.provider), id: input.id ?? randomUUID(), provider: input.provider };

  // 带 id 且档案存在则更新。表单是整体提交的，所以字段直接全量覆盖，不做去重。
  if (input.id) {
    const updated = updateModelProfile(listSavedModelProfiles(existing), profile);
    if (updated) return { settings: saveModelSettings({ modelProfiles: updated }), added: true };
    // id 已经不存在（档案被删了等情况），就走新增路径，保留这个 id
  }

  const result = addModelProfile(listSavedModelProfiles(existing), profile);
  if (!result.added) return { settings: existing, added: false };
  const settings = saveModelSettings({ modelProfiles: result.profiles, defaultModelProfileId: existing.defaultModelProfileId ?? profile.id });
  return { settings: existing.defaultModelProfileId ? settings : setDefaultModelProfile(profile.id), added: true };
}

export function setDefaultModelProfile(id: string): ModelSettings {
  assertModelSettingsReadable();
  const existing = loadModelSettings();
  const profile = listSavedModelProfiles(existing).find((item) => item.id === id);
  if (!profile) throw new Error("模型不存在");
  // 即使没有声明也显式传入输入模态字段（值为 undefined），让顶层镜像跟随默认档案一起更新，不会残留上一个档案的声明
  return saveModelSettings({
    ...profile,
    inputModalities: profile.inputModalities,
    inputModalitiesSource: profile.inputModalitiesSource,
    defaultModelProfileId: id,
  });
}

let modelSettingsCache: ModelSettings | null = null;
let modelSettingsReadFailed = false;
let diagnosticReadOnly = false;

/** 仅主进程可用的严格快照：从不加载或 stat 设置文件，也不注册到 IPC。 */
export function getCachedSavedModelProfile(id: string): SavedModelProfile | undefined {
  if (modelSettingsReadFailed || !modelSettingsCache) return undefined;
  const profile = modelSettingsCache.modelProfiles?.find(item => item.id === id);
  if (!profile) return undefined;
  return {id:profile.id,provider:profile.provider,baseUrl:profile.baseUrl,model:profile.model,
    apiKey:profile.apiKey,explicitTransport:profile.explicitTransport};
}
/** 原生主进程的选择器只接收 ID，不做默认值或回退，也不导出给渲染进程。 */
export function listCachedSavedModelProfileIds(): string[] {
  if (modelSettingsReadFailed || !modelSettingsCache) return [];
  return (modelSettingsCache.modelProfiles ?? []).map(profile => profile.id);
}


export function assertModelSettingsReadable(): void {
  if (diagnosticReadOnly) throw new Error("DIAGNOSTIC_READ_ONLY");
  loadModelSettings();
  if (modelSettingsReadFailed) throw new Error("MODEL_SETTINGS_READ_FAILED: 模型配置读取失败，原文件已保留");
}

function loadModelSettings0(sourcePath?: string): ModelSettings {
  try {
    const filePath = sourcePath ?? getSettingsPath();
    try {
      fs.statSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      logger.warn(LogTag.Runtime, "startup model settings", { filePresent: false, profileCount: 0 });
      return { ...DEFAULT_MODEL_SETTINGS };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = decodeCredentials(JSON.parse(raw), MODEL_CREDENTIAL_FIELDS) as Partial<ModelSettings>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid model settings");
    if (parsed.schemaVersion !== MODEL_SETTINGS_SCHEMA_VERSION || !Array.isArray(parsed.modelProfiles)) {
      throw new Error("Unsupported model settings format");
    }
    if (parsed.modelProfiles.some((item) => !item || typeof item !== "object"
      || typeof item.id !== "string" || typeof item.provider !== "string")) {
      throw new Error("Invalid model profiles");
    }
    if (parsed.perProvider !== undefined && (!parsed.perProvider || typeof parsed.perProvider !== "object"
      || Array.isArray(parsed.perProvider)
      || Object.values(parsed.perProvider).some((item) => !item || typeof item !== "object" || Array.isArray(item)))) {
      throw new Error("Invalid provider settings");
    }
    const normalized = normalizeModelSettings(parsed);
    if (!diagnosticReadOnly) migrateCredentials(filePath, raw, parsed, MODEL_CREDENTIAL_FIELDS);
    logger.warn(LogTag.Runtime, "startup model settings", {
      filePresent: true,
      profileCount: normalized.modelProfiles?.length ?? 0,
    });
    return normalized;
  } catch {
    modelSettingsReadFailed = true;
    logger.warn(LogTag.Runtime, "startup model settings", { readFailed: true });
    return { ...DEFAULT_MODEL_SETTINGS };
  }
}

/** 仅主进程、显式准备诊断用只读缓存。复用已有的校验读取逻辑，绝不写回源文件。 */
export function prepareReadOnlyDiagnosticModelCache(source: RuntimeProfile): boolean {
  if (source.kind !== "production" || source.isolationRoot !== undefined
    || modelSettingsCache !== null || diagnosticReadOnly) throw new Error("DIAGNOSTIC_SOURCE_REFUSED");
  diagnosticReadOnly = true;
  modelSettingsCache = loadModelSettings0(path.join(source.userData, "model-settings.json"));
  return !modelSettingsReadFailed;
}

export function loadModelSettings(): ModelSettings {
  if (modelSettingsCache !== null) return modelSettingsCache;
  return modelSettingsCache = loadModelSettings0();
}

/**
 * 输入模态的折叠：payload 里带了 inputModalities 这个键（即使值为 undefined，表示清除声明）才覆盖；
 * 没带这个键时保留当前厂商的镜像，避免无关的保存（比如全局选项）把声明抹掉。
 */
function foldInputModalities(
  settings: Partial<ModelSettings>,
  incoming: ProviderProfile,
): Pick<ProviderProfile, "inputModalities" | "inputModalitiesSource"> {
  if (!Object.prototype.hasOwnProperty.call(settings, "inputModalities")) {
    return { inputModalities: incoming.inputModalities, inputModalitiesSource: incoming.inputModalitiesSource };
  }
  return normalizeDeclaredInputModalities(settings.inputModalities, settings.inputModalitiesSource);
}

/**
 * 保存流程：
 *   - 渲染进程通过顶层的 baseUrl / model / apiKey 写入当前模型视图；
 *   - 写盘前先把这三个顶层字段折叠回 perProvider[provider]，保证真值落在字典里；
 *   - normalizeModelSettings 再把 perProvider[provider] 展开成顶层镜像，于是写盘时两份视图保持一致。
 */
export function saveModelSettings(settings: Partial<ModelSettings>): ModelSettings {
  assertModelSettingsReadable();
  const existing = loadModelSettings();
  const merged: Partial<ModelSettings> = { ...existing, ...settings };

  // 当前厂商：优先使用本次传入的，没有就沿用已有的
  const requestedProvider = trimmedText(settings.provider);
  const currentProvider = requestedProvider || existing.provider;

  // 先复制一份已有的 perProvider，再把传入的 perProvider 逐项覆盖进去
  const perProvider: Record<string, ProviderProfile> = { ...(existing.perProvider ?? {}) };
  if (settings.perProvider && typeof settings.perProvider === "object") {
    for (const [key, value] of Object.entries(settings.perProvider)) {
      perProvider[key] = normalizeProviderProfile(value as Partial<ProviderProfile>, key);
    }
  }

  // 把顶层传入的三件套折叠到 currentProvider 名下（渲染进程目前主要走这条写入路径）
  const incomingProfile = perProvider[currentProvider] ?? normalizeProviderProfile(null, currentProvider);
  // 协议只接受用户明确选中的 OpenAI / Anthropic / Responses，其它情况沿用原有值
  const requestedTransport = settings.explicitTransport;
  const incomingExplicitTransport: ProviderProfile["explicitTransport"] =
    requestedTransport === "openai" || requestedTransport === "anthropic" || requestedTransport === "responses"
      ? requestedTransport
      : incomingProfile.explicitTransport;
  // reasoning 的取舍优先级：perProvider 里的 > 顶层的 > 已有的（由 foldReasoning 决定）
  const profileInput = (settings.perProvider ?? {})[currentProvider];
  const profileHasReasoning = Boolean(profileInput) && Object.prototype.hasOwnProperty.call(profileInput, "reasoning");
  const topLevelHasReasoning = Object.prototype.hasOwnProperty.call(settings, "reasoning");
  const reasoningSource: object | undefined = profileHasReasoning ? profileInput : topLevelHasReasoning ? settings : undefined;
  const foldedReasoning = foldReasoning(
    reasoningSource === undefined ? undefined : (reasoningSource as { reasoning?: unknown }).reasoning,
    incomingProfile.reasoning,
    reasoningSource !== undefined,
  );

  const nickname = trimmedText(settings.displayName);
  perProvider[currentProvider] = {
    baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : incomingProfile.baseUrl,
    model: typeof settings.model === "string" ? settings.model.trim() : incomingProfile.model,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : incomingProfile.apiKey,
    displayName: nickname || incomingProfile.displayName,
    explicitTransport: incomingExplicitTransport,
    reasoning: foldedReasoning,
    reasoningLevels: incomingProfile.reasoningLevels,
    ...foldInputModalities(settings, incomingProfile),
  };

  merged.provider = currentProvider;
  merged.perProvider = perProvider;

  const next = normalizeModelSettings(merged);
  const target = getSettingsPath();
  writeCredentials(target, next, MODEL_CREDENTIAL_FIELDS);
  Object.assign(existing, next);
  refreshModelConnections(next);
  return next;
}

// 厂商短名映射（与 settings.ts 中 MODEL_PRESETS.shortName 保持一致，需要手动同步）。
// 状态栏在用户没填昵称时，用这里的短名做兜底。
const PROVIDER_SHORT_NAMES: Record<string, string> = Object.fromEntries([
  ["MiniMax（稀宇科技）", "MiniMax"],
  ["DeepSeek（深度求索）", "DeepSeek"],
  ["GLM（智谱）", "GLM"],
  ["Kimi（月之暗面）", "Kimi"],
  ["Qwen（通义千问）", "Qwen"],
  ["ChatGPT（OpenAI）", "ChatGPT"],
  ["Claude（Anthropic）", "Claude"],
  ["OpenRouter", "OpenRouter"],
]);

export function getPublicModelConfig(settings = loadModelSettings()): PublicModelConfig {
  const shortName = PROVIDER_SHORT_NAMES[settings.provider] ?? settings.provider;
  const connected = modelConnections.isConnected(getDefaultModelProfile(settings));
  return {
    mode: settings.mode, provider: settings.provider, displayName: settings.displayName, shortName,
    model: settings.model, connected, stickerSize: settings.stickerSize, rerankerMode: settings.rerankerMode,
  };
}
