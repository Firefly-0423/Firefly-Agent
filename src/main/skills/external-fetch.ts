import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ExternalSkillErrorCode, ExternalSkillSourceId } from "../../shared/external-skills";
import { EXTERNAL_LIMITS, EXTERNAL_SOURCES } from "./external-policy";

export interface ExternalTree {
  commit: string;
  entries: Array<{ path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number }>;
}
export interface ExternalRequestDiagnostic {
  sourceId: ExternalSkillSourceId;
  stage: "metadata" | "commit" | "tree" | "catalog" | "blob";
  status: number | null;
  contentType: "json" | "html" | "text" | "other" | "missing";
  bytes: number;
  errorClass: "ExternalFetchError" | "SyntaxError" | "TypeError" | "Error" | "Unknown";
  code?: ExternalSkillErrorCode;
  operation?: "list" | "detail" | "prepare" | "commit";
  /** Actual HTTP attempts; cache hits and local cooldown refusals count zero. */
  requestCount?: number;
  remaining?: number | null;
  /** Validated absolute milliseconds on the server clock (local clock when Date is absent). */
  retryAfter?: number | null;
  reset?: number | null;
  serverTime?: number | null;
  /** Local-clock deadline projected from validated server time when present. */
  retryAt?: number;
  deadlineSource?: "retry-after" | "reset" | "retry-after+reset" | "fallback";
}
export interface ExternalFetchOptions {
  now?: () => number;
  beforeRequest?: () => void;
  onDiagnostic?: (diagnostic: ExternalRequestDiagnostic, signal: AbortSignal) => void;
  onRequest?: (signal: AbortSignal) => void;
}
export interface ExternalFetcher {
  resolveCommit(sourceId: ExternalSkillSourceId, signal: AbortSignal): Promise<string>;
  readTree(sourceId: ExternalSkillSourceId, commit: string, signal: AbortSignal): Promise<ExternalTree>;
  readBlob(sourceId: ExternalSkillSourceId, blobSha1: string, decodedLimit: number, signal: AbortSignal, stage?: "catalog" | "blob"): Promise<Buffer>;
}
const messages: Partial<Record<ExternalSkillErrorCode, string>> = {
  SOURCE_INVALID: "External source is invalid.", CATALOG_INVALID: "External catalog is invalid.",
  NETWORK_FAILED: "External request failed.", RATE_LIMITED: "External source rate limit reached.",
  REQUEST_TIMEOUT: "External request timed out.", PREPARE_TIMEOUT: "External preparation timed out.",
  LIMIT_EXCEEDED: "External content exceeds a safety limit.", PATH_INVALID: "External path is invalid.",
  TREE_INVALID: "External repository tree is invalid.", BLOB_MISMATCH: "External blob identity does not match.",
  CANCELLED: "External operation was cancelled.",
};
/** Only fixed local messages are exposed, never upstream error bodies or filesystem paths. */
export class ExternalFetchError extends Error {
  readonly retryAt?: number;
  diagnostic?: ExternalRequestDiagnostic;
  constructor(readonly code: ExternalSkillErrorCode, readonly retryable = false, options: { retryAt?: number } = {}) {
    super(messages[code] ?? "External operation failed.");
    this.name = "ExternalFetchError"; this.retryAt = options.retryAt;
  }
}

// Independent path input bounds; these do not alter the approved content/transaction defaults.
const MAX_PATH_BYTES = 4096;
const MAX_PATH_SEGMENTS = 64;

/** Canonical repository-relative paths, suitable for later local containment checks. */
export function validateExternalPath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || /[\\%#?:\x00-\x1f\x7f]/.test(value) || value.startsWith("/")) {
    throw new ExternalFetchError("PATH_INVALID");
  }
  const parts = value.split("/");
  if (parts.length > MAX_PATH_SEGMENTS) throw new ExternalFetchError("PATH_INVALID");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) || /[<>"|*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new ExternalFetchError("PATH_INVALID");
    }
  }
  return value;
}

/** Reject malformed text and bound all JSON containers, including ignored metadata. */
export function parseExternalJson(bytes: Buffer): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ExternalFetchError("CATALOG_INVALID"); }
  const pending = [{ value, depth: 1 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.value === null || typeof item.value !== "object") continue;
    if (item.depth > EXTERNAL_LIMITS.jsonDepth) throw new ExternalFetchError("LIMIT_EXCEEDED");
    for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return value;
}
function object(value: unknown, code: ExternalSkillErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ExternalFetchError(code);
  return value as Record<string, unknown>;
}
function sha(value: unknown, code: ExternalSkillErrorCode): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new ExternalFetchError(code);
  return value;
}
function repository(sourceId: ExternalSkillSourceId): string {
  if (typeof sourceId !== "string" || !Object.hasOwn(EXTERNAL_SOURCES, sourceId)) throw new ExternalFetchError("SOURCE_INVALID");
  const source = EXTERNAL_SOURCES[sourceId];
  return `https://api.github.com/repos/${source.owner}/${source.repo}`;
}

export function createExternalFetcher(fetchImpl: typeof globalThis.fetch, options: ExternalFetchOptions = {}): ExternalFetcher {
  // Numeric fields only. Never retain raw headers, URLs, bodies or native profile paths.
  const maxEpoch = 253402300799999;
  const epoch = (value: number): number | null => Number.isSafeInteger(value) && value >= 0 && value <= maxEpoch ? value : null;
  const integer = (value: string | null): number | null => value !== null && /^\d{1,12}$/.test(value.trim()) ? Number(value.trim()) : null;
  function httpDate(value: string | null): number | null {
    if (!value || value.length > 128 || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
    const parsed = epoch(Date.parse(value));
    return parsed !== null && new Date(parsed).toUTCString() === value ? parsed : null;
  }
  function rateValues(headers: Headers, now: number) {
    const serverTime = httpDate(headers.get("date")), basis = serverTime ?? now;
    const retry = headers.get("retry-after")?.trim() ?? null, seconds = integer(retry);
    const resetSeconds = integer(headers.get("x-ratelimit-reset"));
    return {
      remaining: integer(headers.get("x-ratelimit-remaining")),
      retryAfter: seconds === null ? httpDate(retry) : epoch(basis + seconds * 1000),
      reset: resetSeconds === null ? null : epoch(resetSeconds * 1000),
      serverTime,
    };
  }
  function rateDeadline(context: ExternalRequestDiagnostic, now: number): number {
    if (epoch(now) === null) throw new ExternalFetchError("STATE_INVALID");
    const basis = context.serverTime ?? now, deadlines: number[] = [];
    const future = (value: number | null | undefined) => {
      if (value !== null && value !== undefined && value > basis) {
        const projected = epoch(now + value - basis); if (projected !== null) deadlines.push(projected);
      }
    };
    future(context.retryAfter);
    const hasRetry = deadlines.length > 0;
    if (!(context.remaining !== null && context.remaining !== undefined && context.remaining > 0)) future(context.reset);
    const hasReset = deadlines.length > (hasRetry ? 1 : 0);
    context.deadlineSource = hasRetry ? hasReset ? "retry-after+reset" : "retry-after" : hasReset ? "reset" : "fallback";
    const fallback = epoch(now + 60000); if (fallback === null) throw new ExternalFetchError("STATE_INVALID");
    context.retryAt = deadlines.length ? Math.max(...deadlines) : fallback;
    return context.retryAt;
  }
  async function stage<T>(sourceId: ExternalSkillSourceId, name: ExternalRequestDiagnostic["stage"], signal: AbortSignal, work: (context: ExternalRequestDiagnostic) => Promise<T>): Promise<T> {
    const context: ExternalRequestDiagnostic = { sourceId, stage: name, status: null, contentType: "missing", bytes: 0, errorClass: "Unknown" };
    try { return await work(context); } catch (error) {
      context.errorClass = error instanceof ExternalFetchError ? "ExternalFetchError" : error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "Unknown";
      if (error instanceof ExternalFetchError) { context.code = error.code; if (error.retryAt !== undefined) context.retryAt = error.retryAt; error.diagnostic = { ...context }; }
      try { options.onDiagnostic?.({ ...context }, signal); } catch { /* Diagnostics never change request results. */ }
      throw error;
    }
  }
  async function json(url: string, limit: number, parentSignal: AbortSignal, context: ExternalRequestDiagnostic): Promise<unknown> {
    if (parentSignal.aborted) throw new ExternalFetchError("CANCELLED");
    const controller = new AbortController();
    let abortError: ExternalFetchError | undefined;
    let rejectAbort!: (error: ExternalFetchError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = (error: ExternalFetchError) => {
      if (abortError) return;
      abortError = error; controller.abort(); rejectAbort(error);
    };
    const onCancel = () => abort(new ExternalFetchError("CANCELLED"));
    parentSignal.addEventListener("abort", onCancel, { once: true });
    const timeout = setTimeout(() => abort(new ExternalFetchError("REQUEST_TIMEOUT", true)), EXTERNAL_LIMITS.requestMs);
    const work = async () => {
      let response: Response;
      options.beforeRequest?.();
      try { options.onRequest?.(parentSignal); } catch { /* Observers cannot change requests. */ }
      try {
        response = await fetchImpl(url, { method: "GET", credentials: "omit", redirect: "manual", headers: { Accept: "application/vnd.github+json" }, signal: controller.signal });
      } catch { throw abortError ?? new ExternalFetchError("NETWORK_FAILED", true); }
      context.status = response.status;
      const now = (options.now ?? Date.now)();
      Object.assign(context, rateValues(response.headers, now));
      const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      context.contentType = !mime ? "missing" : mime === "application/json" || mime === "application/vnd.github+json" ? "json" : mime === "text/html" ? "html" : mime.startsWith("text/") ? "text" : "other";
      function rejectResponse(error: ExternalFetchError): never {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      if (abortError) rejectResponse(abortError);
      if (response.redirected || (response.url && response.url !== url)) rejectResponse(new ExternalFetchError("NETWORK_FAILED", true));
      if (response.status === 429 || (response.status === 403 && (context.remaining === 0 || response.headers.has("retry-after")))) rejectResponse(new ExternalFetchError("RATE_LIMITED", true, { retryAt: rateDeadline(context, now) }));
      if (!response.ok || (response.status >= 300 && response.status < 400)) rejectResponse(new ExternalFetchError("NETWORK_FAILED", true));
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) rejectResponse(new ExternalFetchError("LIMIT_EXCEEDED"));
      if (!response.body) throw new ExternalFetchError("CATALOG_INVALID");
      const reader = response.body.getReader(), chunks: Buffer[] = [];
      let total = 0, completed = false;
      const cancelBody = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancelBody, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (abortError) throw abortError;
          if (done) { completed = true; break; }
          total += value.byteLength; context.bytes = total;
          if (total > limit) throw new ExternalFetchError("LIMIT_EXCEEDED");
          chunks.push(Buffer.from(value));
        }
        return parseExternalJson(Buffer.concat(chunks, total));
      } catch (error) {
        if (error instanceof ExternalFetchError) throw error;
        throw abortError ?? new ExternalFetchError("NETWORK_FAILED", true);
      } finally {
        controller.signal.removeEventListener("abort", cancelBody);
        if (!completed) cancelBody();
        reader.releaseLock();
      }
    };
    try { return await Promise.race([work(), aborted]); }
    finally { clearTimeout(timeout); parentSignal.removeEventListener("abort", onCancel); }
  }
  return {
    async resolveCommit(sourceId, signal) {
      const base = repository(sourceId);
      const branch = await stage(sourceId, "metadata", signal, async context => {
        const metadata = object(await json(base, EXTERNAL_LIMITS.catalogBytes, signal, context), "CATALOG_INVALID");
        const branch = metadata.default_branch;
        if (typeof branch !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(branch) || branch.includes("..") || branch.endsWith(".")) throw new ExternalFetchError("CATALOG_INVALID");
        return branch;
      });
      return stage(sourceId, "commit", signal, async context => {
        const resolved = object(await json(base + "/commits/" + encodeURIComponent(branch), EXTERNAL_LIMITS.catalogBytes, signal, context), "CATALOG_INVALID");
        return sha(resolved.sha, "CATALOG_INVALID");
      });
    },
    async readTree(sourceId, commit, signal) {
      return stage(sourceId, "tree", signal, async context => {
      const base = repository(sourceId); sha(commit, "TREE_INVALID");
      const resolved = object(await json(base + "/git/commits/" + commit, EXTERNAL_LIMITS.catalogBytes, signal, context), "TREE_INVALID");
      if (sha(resolved.sha, "TREE_INVALID") !== commit) throw new ExternalFetchError("TREE_INVALID");
      const treeSha = sha(object(resolved.tree, "TREE_INVALID").sha, "TREE_INVALID");
      const tree = object(await json(base + "/git/trees/" + treeSha + "?recursive=1", EXTERNAL_LIMITS.treeBytes, signal, context), "TREE_INVALID");
      if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new ExternalFetchError("TREE_INVALID");
      if (tree.tree.length > EXTERNAL_LIMITS.treeEntries) throw new ExternalFetchError("LIMIT_EXCEEDED");
      const entries: ExternalTree["entries"] = tree.tree.map(raw => {
        const entry = object(raw, "TREE_INVALID"), path = validateExternalPath(entry.path);
        const blob = entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
        const directory = entry.type === "tree" && entry.mode === "040000";
        if (!blob && !directory) throw new ExternalFetchError("TREE_INVALID");
        const hash = sha(entry.sha, "TREE_INVALID");
        if (blob && (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new ExternalFetchError("TREE_INVALID");
        return { path, mode: entry.mode as string, type: entry.type as "blob" | "tree", sha: hash, ...(blob ? { size: entry.size as number } : {}) };
      });
      // Segment-order sorting groups every ancestor directly before its descendants.
      // A NUL separator sorts before any allowed segment character. Retain one key per
      // entry, never every full prefix: memory is linear in bounded input path bytes.
      const ordered = entries.map(entry => ({ entry, key: entry.path.toLowerCase().replaceAll("/", "\0") }))
        .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      for (let i = 1; i < ordered.length; i++) {
        const previous = ordered[i - 1], current = ordered[i];
        if (previous.key === current.key) throw new ExternalFetchError("TREE_INVALID");
        if (previous.entry.type === "blob" && current.key.startsWith(previous.key) && current.key[previous.key.length] === "\0") throw new ExternalFetchError("TREE_INVALID");
        // Every case variant of a shared parent occurs at an adjacent group boundary.
        const left = previous.entry.path.split("/"), right = current.entry.path.split("/");
        for (let part = 0; part < Math.min(left.length, right.length); part++) {
          if (left[part].toLowerCase() !== right[part].toLowerCase()) break;
          if (left[part] !== right[part]) throw new ExternalFetchError("TREE_INVALID");
        }
      }
      return { commit, entries };
      });
    },
    async readBlob(sourceId, blobSha1, decodedLimit, signal, requestStage = "blob") {
      return stage(sourceId, requestStage, signal, async context => {
      const base = repository(sourceId); sha(blobSha1, "BLOB_MISMATCH");
      if (!Number.isSafeInteger(decodedLimit) || decodedLimit < 0 || decodedLimit > EXTERNAL_LIMITS.fileBytes) throw new ExternalFetchError("LIMIT_EXCEEDED");
      const budget = Math.ceil(decodedLimit / 3) * 4 + 65536;
      const payload = object(await json(base + "/git/blobs/" + blobSha1, budget, signal, context), "BLOB_MISMATCH");
      if (payload.encoding !== "base64" || typeof payload.content !== "string" || typeof payload.size !== "number" || !Number.isSafeInteger(payload.size) || payload.size < 0) throw new ExternalFetchError("BLOB_MISMATCH");
      if (payload.size > decodedLimit) throw new ExternalFetchError("LIMIT_EXCEEDED");
      // GitHub wraps base64 with newlines; all other whitespace, padding ambiguity and invalid bits fail.
      const encoded = payload.content.replace(/\r?\n/g, "");
      if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new ExternalFetchError("BLOB_MISMATCH");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > decodedLimit) throw new ExternalFetchError("LIMIT_EXCEEDED");
      if (bytes.toString("base64") !== encoded || payload.size !== bytes.length || payload.sha !== blobSha1) throw new ExternalFetchError("BLOB_MISMATCH");
      const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (actual !== blobSha1) throw new ExternalFetchError("BLOB_MISMATCH");
      return bytes;
      });
    },
  };
}
