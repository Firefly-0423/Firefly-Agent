// Data-only adapter: retain gray-matter's delimiter/body behavior, never its
// extensible language dispatch for arbitrary Skill content.
import matter from "@11ty/gray-matter";
import {
  load, YAML11_SCHEMA, boolCoreTag, intYaml11Tag, floatCoreTag, floatYaml11Tag, NOT_RESOLVED,
  binaryTag, mapTag, setTag,
} from "js-yaml";

export type SkillFrontmatterErrorCode = "SKILL_FRONTMATTER_UNSUPPORTED_LANGUAGE" | "SKILL_FRONTMATTER_PARSE_ERROR";

export class SkillFrontmatterError extends Error {
  constructor(readonly code: SkillFrontmatterErrorCode) {
    super(code);
  }
}

// v3 safeLoad used a hybrid schema: YAML 1.1 numbers/dates/merge with only
// true/false booleans. The scalar grammar below retains that input contract;
// construction, tag validation, depth/merge limits stay with maintained js-yaml.
// Float grammar adapted from js-yaml v3 (MIT):
// https://github.com/nodeca/js-yaml/blob/3.15.2/lib/js-yaml/type/float.js
// License: vendor/security/skill-frontmatter/js-yaml-LICENSE
const legacyFloat = /^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const skillSchema = YAML11_SCHEMA.withTags(
  boolCoreTag,
  { ...intYaml11Tag, resolve(source, explicit, tag) {
    if (source.endsWith("_") || /^[-+]?0.*:/.test(source)) return NOT_RESOLVED;
    return intYaml11Tag.resolve(source, explicit, tag);
  } },
  { ...floatYaml11Tag, resolve(source, explicit, tag) {
    if (source.endsWith("_") || !legacyFloat.test(source)) return NOT_RESOLVED;
    const value = floatCoreTag.resolve(source.replace(/_/g, ""), explicit, tag);
    return value === NOT_RESOLVED ? floatYaml11Tag.resolve(source, explicit, tag) : value;
  } },
  // Keep the v3 Buffer/object representations used by existing String(value)
  // projection, including when these standard YAML types appear in arrays.
  { ...binaryTag, resolve(source, explicit, tag) {
    const value = binaryTag.resolve(source, explicit, tag);
    return value === NOT_RESOLVED ? value : Buffer.from(value);
  } },
  { ...mapTag, tagName: setTag.tagName, addPair(container, key, value) {
    return value === null ? mapTag.addPair(container, key, value) : "cannot resolve a set item";
  } },
);

function parseYaml(source: string): object {
  const data = load(source, { schema: skillSchema });
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export function parseSkillMatter(content: string): { data: Record<string, unknown>; content: string } {
  // Match the upstream opening delimiter and language grammar, including BOM.
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const engines: Record<string, (source: string) => object> = { yaml: parseYaml, json: JSON.parse };
  if (normalized.startsWith("---") && normalized[3] !== "-") {
    const declared = matter.language(normalized).name;
    const language = declared.toLowerCase();
    if (language && language !== "yaml" && language !== "yml" && language !== "json") {
      throw new SkillFrontmatterError("SKILL_FRONTMATTER_UNSUPPORTED_LANGUAGE");
    }
    if (declared) engines[declared] = language === "json" ? JSON.parse : parseYaml;
  }
  // Explicit engines avoid global engine mutation and upstream caching of
  // attacker-controlled document strings. No caller-supplied custom tags/engines.
  return matter(content, { engines });
}
