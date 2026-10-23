// Skill 目录扫描与 frontmatter 解析。这里的函数不依赖 electron，路径由调用方传入。

import * as fs from "fs";
import * as path from "path";
import { parseSkillMatter, SkillFrontmatterError, type SkillFrontmatterErrorCode } from "./skill-frontmatter";
import type { ParsedSkill, SkillEntry, SkillManifest, SkillMode } from "./types";
import type { ToolEffectKind } from "../orchestrator/tools/registry/tool-registry";
import { logger } from "../../shared/logger";
import { LogTag } from "../../shared/logger-tags";

const KNOWN_EFFECTS = new Set(["read", "mutation", "verification", "external_side_effect"]);
const KNOWN_MODES = new Set<SkillMode>(["work", "code"]);
const EXTERNAL_PREFIX = "external-";

/** 读取并校验 manifest.json；任一字段不符或解析失败都视为没有 manifest。 */
function loadManifest(skillDir: string, id: string): SkillManifest | undefined {
  const location = path.join(skillDir, "manifest.json");
  if (!fs.existsSync(location)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(location, "utf8")) as Partial<SkillManifest>;
    const ok = parsed.id === id
      && typeof parsed.version === "string"
      && typeof parsed.defaultEnabled === "boolean"
      && typeof parsed.entry === "string"
      && Array.isArray(parsed.dependencies);
    if (!ok) return undefined;
    return { ...parsed, dependencies: parsed.dependencies!.map(String) } as SkillManifest;
  } catch {
    return undefined;
  }
}

/** external- 前缀（不区分大小写）整体保留给外部 skill，即使 id 格式不合法也一样。 */
export function isExternalSkillId(id: string): boolean {
  return id.toLowerCase().startsWith(EXTERNAL_PREFIX);
}

/** 外部 skill 的内容或来源不可用时，只生成一条停用的占位记录，绝不解析其内容。 */
export function externalSkillPlaceholder(id: string, directory: string, source: "builtin" | "user" = "user"): SkillEntry {
  return {
    id,
    name: id,
    description: "External Skill requires reimport.",
    tools: [],
    dirPath: directory,
    bodyPath: path.join(directory, "SKILL.md"),
    references: [],
    enabled: false,
    source,
    hiddenFromUi: false,
    external: {
      status: "reimport-required",
      reason: "External Skill provenance or content is unavailable. Reimport is required.",
    },
  };
}

/** 只保留 work/code 两种有效模式，去掉空白和大小写差异后去重。 */
function pickModes(raw: unknown): SkillMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned: SkillMode[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const norm = item.trim().toLowerCase();
    if (KNOWN_MODES.has(norm as SkillMode)) cleaned.push(norm as SkillMode);
  }
  return Array.from(new Set(cleaned));
}

/**
 * 解析 SKILL.md。成功返回结构化结果，失败返回 null。
 * 失败的原因包括缺少 name 或 description、tools 不是数组、或没有 frontmatter。
 * onError 只回报错误码，不会把 frontmatter 的原始内容暴露出来。
 */
export function parseSkillFrontmatter(content: string, onError?: (code: SkillFrontmatterErrorCode) => void): ParsedSkill | null {
  try {
    const doc = parseSkillMatter(content);
    const meta = doc.data ?? {};
    if (typeof meta.name !== "string" || !meta.name) return null;
    if (typeof meta.description !== "string" || !meta.description) return null;
    if (meta.tools !== undefined && !Array.isArray(meta.tools)) return null;
    const effect = typeof meta.effectKind === "string" && KNOWN_EFFECTS.has(meta.effectKind)
      ? meta.effectKind as ToolEffectKind
      : undefined;
    return {
      name: meta.name,
      description: meta.description,
      tools: Array.isArray(meta.tools) ? meta.tools.map(String) : undefined,
      version: meta.version !== undefined ? String(meta.version) : undefined,
      effectKind: effect,
      modes: pickModes(meta.modes),
      hiddenFromUi: meta.hiddenFromUi === true || meta.hiddenFromUi === "true",
      body: doc.content.trim(),
    };
  } catch (err) {
    onError?.(err instanceof SkillFrontmatterError ? err.code : "SKILL_FRONTMATTER_PARSE_ERROR");
    return null;
  }
}

/** 列出 references/ 下的普通文件名（不含子目录，也不读内容）。 */
function listReferenceFiles(skillDir: string): string[] {
  const refDir = path.join(skillDir, "references");
  try {
    if (!fs.existsSync(refDir) || !fs.statSync(refDir).isDirectory()) return [];
    return fs.readdirSync(refDir).filter((name) => fs.statSync(path.join(refDir, name)).isFile());
  } catch {
    return [];
  }
}

/**
 * 扫描一个 skill 根目录，返回所有合规的 SkillEntry。
 * 不合规的条目会被跳过并打印警告，不会抛出异常。
 * 普通 skill 默认启用，之后由 initSkills 叠加用户持久化的开关；external- 条目只生成停用的占位记录。
 * 跨来源的覆盖（user 覆盖 builtin）由 initSkills 负责，本函数不处理。
 */
export function scanSkills(dir: string, source: "builtin" | "user"): SkillEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory() || isExternalSkillId(item.name))
      .map((item) => item.name);
  } catch {
    return [];
  }

  const out: SkillEntry[] = [];
  for (const id of names) {
    const skillDir = path.join(dir, id);
    if (isExternalSkillId(id)) {
      out.push(externalSkillPlaceholder(id, skillDir, source));
      continue;
    }
    const mdFile = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(mdFile)) {
      console.warn("[Skills] 跳过无 SKILL.md 的目录:", skillDir);
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(mdFile, "utf8");
    } catch {
      continue;
    }
    let failure: SkillFrontmatterErrorCode | undefined;
    const parsed = parseSkillFrontmatter(text, (code) => { failure = code; });
    if (!parsed) {
      console.warn("[Skills] 跳过不合规 SKILL.md（缺 name/description 或 frontmatter 解析失败）:", mdFile, failure ?? "SKILL_METADATA_INVALID");
      continue;
    }
    if (parsed.name !== id) {
      logger.warn(LogTag.Skills, `name(${parsed.name}) != dir(${id}), using dir as id`);
    }
    const manifest = loadManifest(skillDir, id);
    out.push({
      id,
      name: parsed.name,
      description: parsed.description,
      tools: parsed.tools ?? manifest?.dependencies,
      version: parsed.version ?? manifest?.version,
      dirPath: skillDir,
      bodyPath: mdFile,
      references: listReferenceFiles(skillDir),
      enabled: manifest?.defaultEnabled ?? true,
      source,
      manifest,
      effectKind: parsed.effectKind,
      modes: parsed.modes,
      hiddenFromUi: parsed.hiddenFromUi,
    });
  }
  return out;
}
