/**
 * Memory 各操作的结构化输出契约：JSON Schema、parseSchema 与 validateBusiness。
 * 与 runStructuredOutput<T>() 配合——parseSchema 负责从模型输出里取出并校验对象，
 * validateBusiness 做业务层校验（多数情况下直接放行）。
 */

import type { BusinessValidationResult } from "../orchestrator/structured-output/runner";
import type { StructuredErrorDisposition } from "../orchestrator/structured-output/errors";
import type { MemoryCandidate, MemoryConflictResolution } from "./memory-types";
import type { ExtractedEntity } from "./entity-graph";

// ───── 基础取值与校验小工具 ─────

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const isPlain = !!value && typeof value === "object" && !Array.isArray(value);
  if (!isPlain) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${label} must be a non-empty string`);
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${label} must be a finite number`);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== "string") throw new Error(`${label}[${i}] must be a string`);
    out.push(item);
  });
  return out;
}

/** 逐项解析数组，出错时在消息前加上 “前缀[下标]: ” */
function parseEach<T>(items: unknown[], prefix: string, parseOne: (item: unknown) => T): T[] {
  return items.map((item, i) => {
    try {
      return parseOne(item);
    } catch (err) {
      throw new Error(`${prefix}[${i}]: ${reasonOf(err)}`);
    }
  });
}

/** 顶层既可以是数组，也可以是带指定键的对象 */
function unwrapList(value: unknown, key: string, failure: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as unknown[];
  }
  throw new Error(failure);
}

// ───── 枚举取值集合 ─────

const choiceSet = (spaceSeparated: string): Set<string> => new Set(spaceSeparated.split(" "));

const VALID_LAYERS = choiceSet("L0 L1 L2");
const VALID_IMPORTANCE = choiceSet("low medium high");
const VALID_STABILITY = choiceSet("one_off situational stable");
const VALID_CERTAINTY = choiceSet("explicit inferred uncertain");
const VALID_ATTRIBUTION = choiceSet("user_explicit assistant_inferred mixed");
const VALID_RESOLUTION_TYPES = choiceSet("unrelated context_difference preference_evolution direct_conflict uncertain");
const VALID_MEMORY_STATUS = choiceSet("active aging archived superseded merged");
const VALID_ENTITY_TYPES = choiceSet("person place concept preference organization");

// ───── L2 slug / sourceQuote ─────

const SLUG_MAX_LENGTH = 20;
// 允许中文（含扩展 A 区）、字母、数字、下划线、连字符；空格、标点、引号、emoji 都不行
const SLUG_ALLOWED_PATTERN = /^[㐀-龥A-Za-z0-9_-]+$/;

/** slug 是否合法；不合法的会被丢弃（候选照常入库，文件名退回内部 id），不会抛错 */
export function isValidSlug(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length === 0 || text.length > SLUG_MAX_LENGTH) return false;
  if (/\p{Extended_Pictographic}/u.test(text)) return false;
  return SLUG_ALLOWED_PATTERN.test(text);
}

const SOURCE_QUOTE_MAX_LENGTH = 500;

/** sourceQuote 只要求非空且 trim 后不超过 500 字，任意 Unicode 均可（它是展示用的原话，比 slug 宽松） */
export function isValidSourceQuote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = value.trim().length;
  return length > 0 && length <= SOURCE_QUOTE_MAX_LENGTH;
}

// ───── provider_json_schema 使用的 JSON Schema ─────
// A 档模型（GPT/Claude/Kimi）会收到这些 schema 做严格约束；字段顺序即发送顺序

const str = () => ({ type: "string" });
const num = () => ({ type: "number" });
const bool = () => ({ type: "boolean" });
const oneOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });
const listOf = (items: Record<string, unknown>) => ({ type: "array", items });
/** 固定的对象外壳：type → properties → required → additionalProperties */
const strictObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const judgeCandidateProps = {
  layer: oneOf(["L0", "L1", "L2"]),
  field: str(),
  summary: str(),
  slug: str(),
  sourceQuote: str(),
  content: str(),
  confidence: num(),
  triggerText: str(),
  importance: oneOf(["low", "medium", "high"]),
  stability: oneOf(["one_off", "situational", "stable"]),
  certainty: oneOf(["explicit", "inferred", "uncertain"]),
  attribution: oneOf(["user_explicit", "assistant_inferred", "mixed"]),
  evidenceQuotes: listOf(str()),
  contextSummary: str(),
  shouldWrite: bool(),
  reason: str(),
  forbiddenOverclaims: listOf(str()),
};

const judgeEntityProps = {
  name: str(),
  type: oneOf(["person", "place", "concept", "preference", "organization"]),
  aliases: listOf(str()),
};

export const MEMORY_JUDGE_JSON_SCHEMA: Record<string, unknown> = strictObject(
  {
    candidates: listOf(strictObject(judgeCandidateProps, ["layer", "content", "confidence", "triggerText"])),
    entities: listOf(strictObject(judgeEntityProps, ["name", "type"])),
  },
  ["candidates", "entities"],
);

const reflectionUpdateProps = {
  layer: oneOf(["L0", "L1"]),
  field: str(),
  content: str(),
  confidence: num(),
};

export const MEMORY_REFLECTION_JSON_SCHEMA: Record<string, unknown> = strictObject(
  { updates: listOf(strictObject(reflectionUpdateProps, ["layer", "content", "confidence"])) },
  ["updates"],
);

const statusChoices = oneOf([...VALID_MEMORY_STATUS]);

const resolveActionProps = {
  createResolvedMemory: bool(),
  oldMemoryStatus: statusChoices,
  newMemoryStatus: statusChoices,
  shouldUpdateCoreMemory: bool(),
  shouldAskUser: bool(),
  clarificationNeeded: bool(),
};

export const MEMORY_RESOLVE_JSON_SCHEMA: Record<string, unknown> = strictObject(
  {
    resolutionType: oneOf([...VALID_RESOLUTION_TYPES]),
    resolvedSummary: str(),
    currentSummary: str(),
    historicalSummary: str(),
    reason: str(),
    confidence: num(),
    actions: strictObject(resolveActionProps, ["createResolvedMemory"]),
  },
  ["resolutionType", "reason", "confidence", "actions"],
);

// ───── Judge：候选 + 顺带抽取的实体 ─────

/**
 * Judge 的完整输出。实体是 judge 那次模型调用顺手产出的（不额外调用，也避免旧正则产生垃圾实体），
 * 之后由 EntityGraph.ingestEntities() 入库。
 */
export type MemoryJudgeResult = {
  entities: ExtractedEntity[];
  candidates: MemoryCandidate[];
}

function parseMemoryCandidate(value: unknown): MemoryCandidate {
  const raw = requiredObject(value, "candidate");
  const layer = requiredString(raw.layer, "layer");
  if (!VALID_LAYERS.has(layer)) throw new Error(`layer must be L0/L1/L2, got "${layer}"`);

  const candidate: MemoryCandidate = {
    layer: layer as MemoryCandidate["layer"],
    content: requiredString(raw.content, "content"),
    confidence: requiredNumber(raw.confidence, "confidence"),
    triggerText: requiredString(raw.triggerText, "triggerText"),
  };

  const field = optionalString(raw.field);
  if (field !== undefined) candidate.field = field;
  const summary = optionalString(raw.summary);
  if (summary !== undefined) candidate.summary = summary;

  // slug、sourceQuote 只对 L2 有意义，L0/L1 上的一律丢弃
  if (layer === "L2") {
    if (isValidSlug(raw.slug)) candidate.slug = raw.slug.trim();
    if (isValidSourceQuote(raw.sourceQuote)) candidate.sourceQuote = raw.sourceQuote.trim();
  }

  if (VALID_IMPORTANCE.has(raw.importance as string)) candidate.importance = raw.importance as MemoryCandidate["importance"];
  if (VALID_STABILITY.has(raw.stability as string)) candidate.stability = raw.stability as MemoryCandidate["stability"];
  if (VALID_CERTAINTY.has(raw.certainty as string)) candidate.certainty = raw.certainty as MemoryCandidate["certainty"];
  if (VALID_ATTRIBUTION.has(raw.attribution as string)) candidate.attribution = raw.attribution as MemoryCandidate["attribution"];
  if (Array.isArray(raw.evidenceQuotes)) candidate.evidenceQuotes = stringArray(raw.evidenceQuotes, "evidenceQuotes");
  if (typeof raw.contextSummary === "string") candidate.contextSummary = raw.contextSummary;
  if (typeof raw.shouldWrite === "boolean") candidate.shouldWrite = raw.shouldWrite;
  if (typeof raw.reason === "string") candidate.reason = raw.reason;
  if (Array.isArray(raw.forbiddenOverclaims)) {
    candidate.forbiddenOverclaims = stringArray(raw.forbiddenOverclaims, "forbiddenOverclaims");
  }
  return candidate;
}

function parseExtractedEntity(value: unknown): ExtractedEntity {
  const raw = requiredObject(value, "entity");
  const name = requiredString(raw.name, "name");
  const type = requiredString(raw.type, "type");
  if (!VALID_ENTITY_TYPES.has(type)) {
    throw new Error(`entity type must be one of ${[...VALID_ENTITY_TYPES].join(", ")}, got "${type}"`);
  }
  const entity: ExtractedEntity = { name, type: type as ExtractedEntity["type"] };
  if (Array.isArray(raw.aliases)) {
    entity.aliases = stringArray(raw.aliases, "aliases")
      .map((a) => a.trim())
      .filter((a) => a && a !== name);
  }
  return entity;
}

/**
 * runStructuredOutput 的 parseSchema 回调：取出 MemoryJudgeResult。
 * 顶层可以是 { candidates, entities }（新形式），也可以是纯候选数组（旧形式，此时没有实体）。
 */
export function parseMemoryJudgeResult(value: unknown): MemoryJudgeResult {
  if (Array.isArray(value)) {
    return { candidates: parseEach(value, "candidate", parseMemoryCandidate), entities: [] };
  }
  const raw = requiredObject(value, "judge result");
  if (!Array.isArray(raw.candidates)) {
    throw new Error("Memory judge result.candidates must be an array");
  }
  const candidates = parseEach(raw.candidates, "candidate", parseMemoryCandidate);
  const entityItems = Array.isArray(raw.entities) ? raw.entities : [];
  return { candidates, entities: parseEach(entityItems, "entity", parseExtractedEntity) };
}

export function validateMemoryJudgeBusiness(
  result: MemoryJudgeResult,
): BusinessValidationResult<MemoryJudgeResult> {
  // 没有候选、没有实体都是合法结果，直接放行
  return { status: "accepted", value: result };
}

// ───── Compress ─────

export type MemoryCompressionGroup = {
  ids: string[];
  summary: string;
}

function parseCompressionGroup(value: unknown): MemoryCompressionGroup {
  const raw = requiredObject(value, "group");
  return {
    ids: stringArray(raw.ids, "ids"),
    summary: requiredString(raw.summary, "summary"),
  };
}

export function parseMemoryCompressResult(value: unknown): MemoryCompressionGroup[] {
  const items = unwrapList(value, "groups", "Memory compress result must be an array or { groups: [...] }");
  return parseEach(items, "group", parseCompressionGroup);
}

export function validateMemoryCompressBusiness(
  groups: MemoryCompressionGroup[],
): BusinessValidationResult<MemoryCompressionGroup[]> {
  if (groups.length > 0) return { status: "accepted", value: groups };
  return { status: "rejected", error: { layer: "schema", code: "EMPTY_GROUPS", disposition: "fail_closed" } };
}

// ───── Resolve ─────

type ResolutionActions = MemoryConflictResolution["actions"];

function parseResolutionActions(value: unknown): ResolutionActions {
  const raw = requiredObject(value, "actions");
  const actions: ResolutionActions = {
    createResolvedMemory: raw.createResolvedMemory === true,
  };
  if (VALID_MEMORY_STATUS.has(raw.oldMemoryStatus as string)) {
    actions.oldMemoryStatus = raw.oldMemoryStatus as ResolutionActions["oldMemoryStatus"];
  }
  if (VALID_MEMORY_STATUS.has(raw.newMemoryStatus as string)) {
    actions.newMemoryStatus = raw.newMemoryStatus as ResolutionActions["newMemoryStatus"];
  }
  if (raw.shouldUpdateCoreMemory === true) actions.shouldUpdateCoreMemory = true;
  if (raw.shouldAskUser === true) actions.shouldAskUser = true;
  if (raw.clarificationNeeded === true) actions.clarificationNeeded = true;
  return actions;
}

export function parseMemoryResolveResult(value: unknown): MemoryConflictResolution {
  const raw = requiredObject(value, "resolution");
  const resolutionType = requiredString(raw.resolutionType, "resolutionType");
  if (!VALID_RESOLUTION_TYPES.has(resolutionType)) {
    throw new Error(`resolutionType must be one of ${[...VALID_RESOLUTION_TYPES].join(", ")}, got "${resolutionType}"`);
  }
  const reason = requiredString(raw.reason, "reason");
  const confidence = requiredNumber(raw.confidence, "confidence");
  const resolution: MemoryConflictResolution = {
    resolutionType: resolutionType as MemoryConflictResolution["resolutionType"],
    reason,
    confidence,
    actions: parseResolutionActions(raw.actions),
  };
  for (const key of ["resolvedSummary", "currentSummary", "historicalSummary"] as const) {
    const text = raw[key];
    if (typeof text === "string" && text.trim()) resolution[key] = text.trim();
  }
  return resolution;
}

export function validateMemoryResolveBusiness(
  resolution: MemoryConflictResolution,
): BusinessValidationResult<MemoryConflictResolution> {
  if (resolution.reason.trim()) return { status: "accepted", value: resolution };
  return { status: "rejected", error: { layer: "schema", code: "EMPTY_REASON", disposition: "fail_closed" } };
}

// ───── Reflection ─────

export type MemoryReflectionItem = {
  layer: "L0" | "L1";
  field?: string;
  content: string;
  confidence: number;
}

function parseReflectionItem(value: unknown): MemoryReflectionItem {
  const raw = requiredObject(value, "reflection item");
  const layer = requiredString(raw.layer, "layer");
  if (layer !== "L0" && layer !== "L1") throw new Error(`layer must be L0/L1, got "${layer}"`);
  return {
    layer,
    field: optionalString(raw.field),
    content: requiredString(raw.content, "content"),
    confidence: requiredNumber(raw.confidence, "confidence"),
  };
}

export function parseMemoryReflectionResult(value: unknown): MemoryReflectionItem[] {
  const items = unwrapList(value, "updates", "Memory reflection result must be an array or { updates: [...] }");
  return parseEach(items, "item", parseReflectionItem);
}

export function validateMemoryReflectionBusiness(
  items: MemoryReflectionItem[],
): BusinessValidationResult<MemoryReflectionItem[]> {
  // 空数组表示没有需要更新的内容，同样放行
  return { status: "accepted", value: items };
}
