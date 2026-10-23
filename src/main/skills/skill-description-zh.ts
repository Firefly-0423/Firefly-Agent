// 技能描述的中文翻译：技能文件自带的描述多是英文，技能页需要中文。
// - 翻译结果存在本机的独立文件里，按"技能 id + 英文描述的哈希"对应；英文描述一改就视为没翻译过。
// - 不改技能文件本身：外部技能有完整性校验，改动 SKILL.md 会让它们需要重新导入。
// - 一次只翻还缺的那些，分批交给当前默认模型；同一时间只跑一轮，重复请求复用同一轮。
import { createHash } from "node:crypto";
import { AtomicJsonStore } from "../atomic-json-store";
import { getStorageContext } from "../storage-context";

export interface SkillText { id: string; description: string }
export type Translator = (batch: readonly SkillText[]) => Promise<Record<string, string>>;

interface Cache { version: 1; entries: Record<string, { source: string; zh: string }> }

const BATCH = 12;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ZH = 400;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
/** Already Chinese (mostly CJK): nothing to translate. */
export const isChinese = (text: string) => {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters) return true;
  const cjk = letters.match(/\p{Script=Han}/gu)?.length ?? 0;
  return cjk / letters.length > 0.3;
};

function isCache(value: unknown): value is Cache {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<Cache>;
  if (cache.version !== 1 || !cache.entries || typeof cache.entries !== "object" || Array.isArray(cache.entries)) return false;
  return Object.entries(cache.entries).every(([id, entry]) => !UNSAFE.has(id) && !!entry && typeof entry.source === "string" && typeof entry.zh === "string");
}

function store(): AtomicJsonStore<Cache> | undefined {
  try { return new AtomicJsonStore<Cache>(getStorageContext().files.skillDescriptionsZh, isCache); } catch { return undefined; }
}

function readCache(): Cache {
  try { return store()?.read({ version: 1, entries: {} }) ?? { version: 1, entries: {} }; } catch { return { version: 1, entries: {} }; }
}

/** The Chinese description for this skill, if one was saved for exactly this English text. */
export function cachedZh(id: string, description: string, cache: Cache = readCache()): string | undefined {
  if (isChinese(description)) return description;
  const entry = Object.prototype.hasOwnProperty.call(cache.entries, id) ? cache.entries[id] : undefined;
  return entry && entry.source === hash(description) ? entry.zh : undefined;
}

export function cachedZhMap(skills: readonly SkillText[]): Record<string, string> {
  const cache = readCache();
  const result: Record<string, string> = {};
  for (const skill of skills) {
    const zh = cachedZh(skill.id, skill.description, cache);
    if (zh) result[skill.id] = zh;
  }
  return result;
}

interface Run { promise: Promise<Record<string, string>>; covered: Set<string> }
let running: Run | null = null;
const keyOf = (skill: SkillText) => `${skill.id}:${hash(skill.description)}`;

/**
 * Translates the skills that still lack a Chinese description, saves them, and returns every Chinese description now known.
 * Overlapping requests share one run; a request that names skills the active run does not cover (one imported meanwhile)
 * waits for it and then gets its own pass for the rest.
 */
export function translateMissing(skills: readonly SkillText[], translate: Translator): Promise<Record<string, string>> {
  if (running) {
    const active = running;
    if (skills.every(skill => active.covered.has(keyOf(skill)))) return active.promise;
    return active.promise.catch(() => ({})).then(() => translateMissing(skills, translate));
  }
  const run: Run = { covered: new Set(skills.map(keyOf)), promise: Promise.resolve({}) };
  run.promise = (async () => {
    const cache = readCache();
    const missing = skills.filter(skill => !UNSAFE.has(skill.id) && skill.description.trim() && !cachedZh(skill.id, skill.description, cache));
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const translated = await translate(batch);
      for (const skill of batch) {
        const zh = translated[skill.id]?.trim();
        if (zh) cache.entries[skill.id] = { source: hash(skill.description), zh: zh.slice(0, MAX_ZH) };
      }
      // Save after each batch, so a later failure keeps what already worked.
      store()?.write(cache);
    }
    return cachedZhMap(skills);
  })().finally(() => { if (running === run) running = null; });
  running = run;
  return run.promise;
}

/** Prompt for one batch: JSON in, a JSON object of id → Chinese out. */
export function translationMessages(batch: readonly SkillText[]): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: "你是软件界面翻译。把每个技能的英文说明翻成简洁自然的简体中文，一到两句，保留专有名词和代码标识原样。只输出一个 JSON 对象，键是技能 id，值是中文说明，不要输出其他内容。" },
    { role: "user", content: JSON.stringify(Object.fromEntries(batch.map(skill => [skill.id, skill.description]))) },
  ];
}

/** Reads the model's answer: the first JSON object in it, keeping only string values for the asked ids. */
export function parseTranslation(text: string, batch: readonly SkillText[]): Record<string, string> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return {}; }
  if (!parsed || typeof parsed !== "object") return {};
  const result: Record<string, string> = {};
  for (const skill of batch) {
    const value = (parsed as Record<string, unknown>)[skill.id];
    if (typeof value === "string" && value.trim()) result[skill.id] = value.trim();
  }
  return result;
}
