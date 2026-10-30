// Firefly's own Skill metadata: the values the scanner accepts from a built-in Skill's frontmatter, and the same rules
// applied to a reviewed Firefly-native market Skill. Electron-free.
import type { ExternalNativeMetadata } from "../../shared/external-skills";
import type { SkillMode } from "./types";

export const KNOWN_SKILL_EFFECTS: ReadonlySet<string> = new Set(["read", "mutation", "verification", "external_side_effect"]);
export const KNOWN_SKILL_MODES: ReadonlySet<SkillMode> = new Set<SkillMode>(["work", "code"]);

/** Reviewed Firefly metadata of a market Skill. Labels and visibility only: it never grants a tool or permission. */
export type FireflyNativeMetadata = ExternalNativeMetadata;
export const FIREFLY_NATIVE_KEYS = ["modes", "effectKind", "tools"] as const;
const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** Strict reading of the Firefly fields: anything malformed is refused rather than dropped. */
export function readFireflyNative(data: Record<string, unknown>): FireflyNativeMetadata | undefined {
  const native: FireflyNativeMetadata = {};
  if (data.modes !== undefined) {
    if (!Array.isArray(data.modes) || !data.modes.length || data.modes.length > KNOWN_SKILL_MODES.size) return undefined;
    if (!data.modes.every(mode => typeof mode === "string" && KNOWN_SKILL_MODES.has(mode as SkillMode))) return undefined;
    if (new Set(data.modes).size !== data.modes.length) return undefined;
    native.modes = [...data.modes] as SkillMode[];
  }
  if (data.effectKind !== undefined) {
    if (typeof data.effectKind !== "string" || !KNOWN_SKILL_EFFECTS.has(data.effectKind)) return undefined;
    native.effectKind = data.effectKind as NonNullable<FireflyNativeMetadata["effectKind"]>;
  }
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || !data.tools.length || data.tools.length > 32) return undefined;
    if (!data.tools.every(tool => typeof tool === "string" && TOOL_ID.test(tool)) || new Set(data.tools).size !== data.tools.length) return undefined;
    native.tools = [...data.tools] as string[];
  }
  return native;
}

/** Same metadata, compared field by field in a fixed order. */
export function sameFireflyNative(left: FireflyNativeMetadata | undefined, right: FireflyNativeMetadata | undefined): boolean {
  const canonical = (value: FireflyNativeMetadata | undefined) => JSON.stringify(value ? [value.modes ?? null, value.effectKind ?? null, value.tools ?? null] : null);
  return canonical(left) === canonical(right);
}
