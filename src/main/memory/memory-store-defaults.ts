import { L0Profile, L1Profile, MemoryStore } from "./memory-types"
import { getMemoryLanguage } from "../startup/locale-context"

export const CURRENT_MEMORY_SCHEMA_VERSION = 2

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

const allStrings = (values: unknown[]): boolean => values.every((v) => typeof v === "string")

/** 判断读出的 JSON 是否为当前 schema 的记忆库（只做结构层面的检查） */
export function isCurrentMemoryStore(value: unknown): value is MemoryStore {
  if (!isPlainObject(value)) return false
  const candidate = value as Partial<MemoryStore>
  const { schemaVersion, version, l0, l1, l2 } = candidate
  if (schemaVersion !== CURRENT_MEMORY_SCHEMA_VERSION || typeof version !== "number") return false
  if (!isPlainObject(l0) || !isPlainObject(l1)) return false

  const profile0 = l0 as unknown as L0Profile
  const profile1 = l1 as unknown as L1Profile
  const l0Texts = [
    profile0.nickname,
    profile0.preferredName,
    profile0.occupation,
    profile0.longTermInterests,
    profile0.language,
    profile0.permanentNote,
  ]
  if (!allStrings(l0Texts)) return false
  if (typeof profile0.isPinned !== "boolean" || typeof profile0.updatedAt !== "number") return false

  if (!allStrings([profile1.recentGoals, profile1.recentPreferences, profile1.currentProject])) return false
  if (typeof profile1.generatedAt !== "number" || typeof profile1.roundCount !== "number") return false

  if (!Array.isArray(l2)) return false
  const brokenItem = l2.some((item) => !item || typeof item.id !== "string" || typeof item.content !== "string")
  if (brokenItem) return false

  const optionalLists = [candidate.evidence, candidate.reflectionLogs, candidate.conflictLogs, candidate.l2DmaeStates]
  return optionalLists.every((list) => list === undefined || Array.isArray(list))
}

export function createDefaultL0(): L0Profile {
  const names = { nickname: "", preferredName: "" };
  const about = { occupation: "", longTermInterests: "", language: getMemoryLanguage(), permanentNote: "" };
  return { ...names, ...about, isPinned: false, updatedAt: 0 };
}

export const DEFAULT_L1: L1Profile = {
  recentGoals: "",
  recentPreferences: "",
  currentProject: "",
  generatedAt: 0,
  roundCount: 0,
}

export function createDefaultMemoryStore(): MemoryStore {
  // 先放前四项，其余键依次补上，最终键序与历史落盘格式一致
  const store = {
    schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
    l0: createDefaultL0(),
    l1: Object.assign({}, DEFAULT_L1),
    l2: [],
  } as unknown as MemoryStore
  store.evidence = []
  store.reflectionLogs = []
  store.conflictLogs = []
  store.version = 1
  store.l2DmaeStates = []
  return store
}

const CJK_CHAR = /[一-龥぀-ゟ゠-ヿ]/g
const LATIN_WORD = /[a-z0-9]+/g

/** V5 DMAE：从文本中取出出现频率最高的若干字符/单词，作为命中检测关键词 */
export function extractMemoryKeywords(input: string, max = 12): string[] {
  if (!input) return []
  const pieces = [
    ...Array.from(input.matchAll(CJK_CHAR), (m) => m[0]),
    ...Array.from(input.toLowerCase().matchAll(LATIN_WORD), (m) => m[0]),
  ]
  const counts = new Map<string, number>()
  pieces.forEach((p) => counts.set(p, (counts.get(p) ?? 0) + 1))
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token)
}

export function boundMemorySnippet(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  return text.length > maxLength ? text.slice(0, maxLength) : text
}
