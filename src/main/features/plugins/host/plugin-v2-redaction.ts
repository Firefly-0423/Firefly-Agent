import os from "node:os";
import path from "node:path";
import { within } from "../../../base/identity/runtime-profile";
import { GENERAL_CREDENTIAL_FIELDS } from "../../../platform/settings/credential-storage";
import type { ServiceContext } from "../../../../plugins/v2/services";

export interface RedactionSettingsSource {
  loadModelSettings?: () => {
    apiKey?: unknown;
    perProvider?: Record<string, { apiKey?: unknown } | undefined>;
    modelProfiles?: Array<{ apiKey?: unknown }>;
  };
  loadGeneralSettings?: () => Record<string, unknown>;
  protectedRoots?: readonly string[];
  extraSecrets?: readonly string[];
}

const LOCAL_NO_AUTH_SENTINEL = "__FIREFLY_LOCAL_NO_AUTH__";
const MIN_SECRET_LENGTH = 4;

const WINDOWS_PATH_REGEX = /(^|[\s"'`(=,;])([A-Za-z]:[\\/][^\s"'`<>|)\],;]*)/g;
const UNC_PATH_REGEX = /\\\\[^\s"'`<>|)\],;]+(?:\\[^\s"'`<>|)\],;]*)*/g;
const POSIX_ROOT_PATH_REGEX = /(^|[\s"'`(=,:])(\/(?:Users|home|etc|var|tmp|opt|root|mnt|Volumes|private|System|Library)\b[^\s"'`<>|)\],;]*)/g;

const TRAILING_PATH_DELIMITERS = /[\s"'`<>|)\],;]/;
/** Characters the path patterns also accept right before a path, inside a token. */
const PATH_PREFIX_CHARS = /[=(:]/;
const POSIX_ROOT_NAMES = [
  "/Users", "/home", "/etc", "/var", "/tmp", "/opt",
  "/root", "/mnt", "/Volumes", "/private", "/System", "/Library",
];

function pushSecret(target: Set<string>, candidate: unknown): void {
  if (typeof candidate !== "string") return;
  const trimmed = candidate.trim();
  if (trimmed.length < MIN_SECRET_LENGTH || trimmed === LOCAL_NO_AUTH_SENTINEL) return;
  target.add(trimmed);
}

/** Collects real host credentials from model and general settings, sorted longest-first. */
export function collectHostSecrets(source: RedactionSettingsSource): string[] {
  const secrets = new Set<string>();
  try {
    const model = source.loadModelSettings?.();
    if (model) {
      pushSecret(secrets, model.apiKey);
      if (model.perProvider && typeof model.perProvider === "object") {
        for (const entry of Object.values(model.perProvider)) {
          pushSecret(secrets, entry?.apiKey);
        }
      }
      if (Array.isArray(model.modelProfiles)) {
        for (const profile of model.modelProfiles) {
          pushSecret(secrets, profile?.apiKey);
        }
      }
    }
  } catch {
    // Settings unavailability must not crash redaction; other sources still apply.
  }
  try {
    const general = source.loadGeneralSettings?.();
    if (general) {
      for (const field of GENERAL_CREDENTIAL_FIELDS) {
        pushSecret(secrets, general[field]);
      }
    }
  } catch {
    // Ignore unreadable general settings; model/extra secrets still apply.
  }
  for (const extra of source.extraSecrets ?? []) {
    pushSecret(secrets, extra);
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function defaultProtectedRoots(): string[] {
  const roots = new Set<string>();
  const home = os.homedir();
  if (home) roots.add(home);
  return [...roots];
}

function isInsideWorkspace(candidate: string, workspaceRoot: string | null): boolean {
  if (!workspaceRoot) return false;
  try {
    const resolvedWorkspace = path.resolve(workspaceRoot);
    const resolvedCandidate = path.resolve(candidate);
    if (process.platform === "win32") {
      return within(resolvedWorkspace.toLowerCase(), resolvedCandidate.toLowerCase());
    }
    return within(resolvedWorkspace, resolvedCandidate);
  } catch {
    return false;
  }
}

function redactForeignPathMatch(candidate: string, workspaceRoot: string | null): string {
  return isInsideWorkspace(candidate, workspaceRoot) ? candidate : "[REDACTED_PATH]";
}

/** Redacts real host secrets and filesystem paths outside `context.workspaceRoot`. */
export function redactPluginText(
  text: string,
  context: Pick<ServiceContext, "workspaceRoot">,
  source: RedactionSettingsSource,
): string {
  if (!text) return text;
  let result = text;

  const secrets = collectHostSecrets(source);
  for (const secret of secrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join("[REDACTED]");
    }
  }

  const protectedRoots = [...new Set([...(source.protectedRoots ?? []), ...defaultProtectedRoots()])]
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .sort((a, b) => b.length - a.length);

  for (const root of protectedRoots) {
    if (!result.includes(root)) continue;
    if (isInsideWorkspace(root, context.workspaceRoot)) continue;
    result = result.split(root).join("[REDACTED_PATH]");
  }

  result = result.replace(UNC_PATH_REGEX, (match) => redactForeignPathMatch(match, context.workspaceRoot));
  result = result.replace(
    WINDOWS_PATH_REGEX,
    (_full, prefix: string, match: string) => `${prefix}${redactForeignPathMatch(match, context.workspaceRoot)}`,
  );
  result = result.replace(
    POSIX_ROOT_PATH_REGEX,
    (_full, prefix: string, match: string) => `${prefix}${redactForeignPathMatch(match, context.workspaceRoot)}`,
  );
  return result;
}

function trailingSecretPrefixLength(buffer: string, secrets: readonly string[]): number {
  let maxHold = 0;
  for (const secret of secrets) {
    const upper = Math.min(secret.length - 1, buffer.length);
    for (let len = upper; len > maxHold; len--) {
      if (buffer.endsWith(secret.slice(0, len))) {
        maxHold = len;
        break;
      }
    }
  }
  return maxHold;
}

function trailingPathStartIndex(buffer: string, protectedRoots: readonly string[]): number {
  let holdFrom = buffer.length;

  // Locate the last token since the most recent delimiter that could grow into a path.
  let tokenStart = buffer.length;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (TRAILING_PATH_DELIMITERS.test(buffer[i])) break;
    tokenStart = i;
  }
  // A path can begin at the token start or right after a prefix the full-text patterns accept
  // (`file=/home/...`, `open(E:\...`), so test each such start, earliest first.
  for (let start = tokenStart; start < buffer.length; start++) {
    if (start > tokenStart && !PATH_PREFIX_CHARS.test(buffer[start - 1]) && buffer[start] !== "\\") continue;
    const candidate = buffer.slice(start);
    const looksWindowsDrive = /^[A-Za-z](?::(?:[\\/].*)?)?$/.test(candidate);
    const looksUnc = /^\\+(?:.*)?$/.test(candidate);
    const looksPosixRoot = candidate.startsWith("/") && POSIX_ROOT_NAMES.some((root) =>
      root.startsWith(candidate) || candidate.startsWith(root),
    );
    if (looksWindowsDrive || looksUnc || looksPosixRoot) {
      holdFrom = Math.min(holdFrom, start);
      break;
    }
  }

  // Also hold a partial prefix of any known host protected root (e.g. split across chunks).
  for (const root of protectedRoots) {
    const upper = Math.min(root.length - 1, buffer.length);
    for (let len = upper; len >= 1; len--) {
      if (buffer.endsWith(root.slice(0, len))) {
        holdFrom = Math.min(holdFrom, buffer.length - len);
        break;
      }
    }
  }

  return holdFrom;
}

/** Moves a cut point back to the start of any complete sensitive value it would otherwise split. */
function avoidSplittingMatches(buffer: string, cut: number, values: readonly string[]): number {
  let adjusted = cut;
  let moved = true;
  while (moved) {
    moved = false;
    for (const value of values) {
      if (!value) continue;
      for (let at = buffer.indexOf(value); at !== -1 && at < adjusted; at = buffer.indexOf(value, at + 1)) {
        if (at + value.length > adjusted) {
          adjusted = at;
          moved = true;
        }
      }
    }
  }
  return adjusted;
}

/**
 * Stateful per-stream redactor that retains undecidable trailing suffixes across chunks
 * so split secrets or foreign paths are never emitted before full evaluation.
 */
export function createPluginStreamRedactor(
  context: Pick<ServiceContext, "workspaceRoot">,
  source: RedactionSettingsSource,
): { push(text: string): string; finish(): string } {
  let buffer = "";
  const protectedRoots = [...new Set([...(source.protectedRoots ?? []), ...defaultProtectedRoots()])]
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0);

  return {
    push(text: string): string {
      if (!text) return "";
      buffer += text;
      const secrets = collectHostSecrets(source);
      const secretHold = trailingSecretPrefixLength(buffer, secrets);
      const holdFrom = avoidSplittingMatches(
        buffer,
        Math.min(buffer.length - secretHold, trailingPathStartIndex(buffer, protectedRoots)),
        [...secrets, ...protectedRoots],
      );
      if (holdFrom <= 0) return "";
      const safe = buffer.slice(0, holdFrom);
      buffer = buffer.slice(holdFrom);
      return redactPluginText(safe, context, source);
    },
    finish(): string {
      if (!buffer) return "";
      const tail = buffer;
      buffer = "";
      return redactPluginText(tail, context, source);
    },
  };
}
