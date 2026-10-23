import {requestProviderIdentity} from "../orchestrator/vendors/request-provider-identity";
import { createHash } from "node:crypto";
import type { VendorConfig } from "../orchestrator/vendors/types";
import { resolveTransport } from "../orchestrator/vendors/transport-detector";
import { estimateTokens, DEFAULT_IMAGE_TOKEN_ESTIMATE } from "../orchestrator/context-manager";
import { freezeRequest } from "./token-budget";
import { contextFail, type JsonValue, type PreparedRequest, type TokenCounter } from "./context-contracts";

import { PRODUCTION_ESTIMATOR_VERSION } from "./model-counting-contract";
export { PRODUCTION_ESTIMATOR_VERSION } from "./model-counting-contract";
interface Options {
  /** Explicit Main policy for unverified model limits; never advertised as exact. */
  mode?: "estimate";
  /** Only wired to a verified official Responses counter by trusted Main composition. */
  exactCount?: (request: Readonly<PreparedRequest>, options?: { signal?: AbortSignal }) => Promise<number>;
  validateCurrent?: () => void;
}
function estimateBody(body: PreparedRequest["body"]): number {
  let images = 0;
  const visit = (value: JsonValue, kind: "body" | "message" | "content" | "ordinary" = "ordinary"): JsonValue => {
    if (Array.isArray(value)) return value.map(item => visit(item, kind));
    if (value && typeof value === "object") {
      if (kind === "content" && ((value.type === "input_image" && typeof value.image_url === "string")
        || (value.type === "image_url" && value.image_url && typeof value.image_url === "object")
        || (value.type === "image" && value.source && typeof value.source === "object"))) {
        images++;
        return { type: "estimated-image" };
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const childKind = kind === "body" && (key === "messages" || key === "input") ? "message"
          : key === "content" && (kind === "message" || kind === "content" && value.type === "tool_result") || kind === "message" && value.type === "function_call_output" && key === "output" ? "content" : "ordinary";
        return [key, visit(item, childKind)];
      }));
    }
    return value;
  };
  // This intentionally remains a labeled heuristic, not a mathematical token upper bound.
  return estimateTokens(JSON.stringify(visit(body, "body"))) + images * DEFAULT_IMAGE_TOKEN_ESTIMATE + 128;
}
/** A counter is scoped to detached model configuration and a Main-owned configuration revision. */
export function resolveMemoryCounter(config: VendorConfig, profileRevision: number, options: Options = {}): TokenCounter {
  if (!Number.isSafeInteger(profileRevision) || profileRevision < 1 || !config.model?.trim()) contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  const saved = structuredClone(config), transport = resolveTransport(saved);
  let url: URL;
  try { url = new URL(saved.baseUrl); } catch { return contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED"); }
  const normalizedBase = url!.origin + url!.pathname.replace(/\/+$/, "");
  const official = normalizedBase === "https://api.openai.com/v1" && !url!.search && !url!.hash && !url!.username && !url!.password;
  const exact = official && transport === "responses" && options.mode !== "estimate";
  if (exact && !options.exactCount) contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
  const providerId = requestProviderIdentity(saved.baseUrl);
  const framingVersion = `${exact ? "firefly-prepared-exact-v1" : PRODUCTION_ESTIMATOR_VERSION}:${transport}:${profileRevision}:` + createHash("sha256").update(JSON.stringify({ baseUrl: saved.baseUrl, model: saved.model, transport, reasoning: saved.reasoning })).digest("hex").slice(0, 16);
  const capability = Object.freeze({ providerId, model: saved.model, transport, framingVersion, mode: exact ? "exact" as const : "estimate" as const,
    inputTypes: Object.freeze(["text", "function-tools", "image"]) as unknown as string[] });
  return Object.freeze({ capability,
    async count(input: Readonly<PreparedRequest>, { signal }: { signal?: AbortSignal } = {}): Promise<number> {
      const current = () => { if (signal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED"); options.validateCurrent?.(); };
      current();
      const request = freezeRequest(input as PreparedRequest);
      if (["providerId", "model", "transport", "framingVersion"].some(key => request[key as keyof PreparedRequest] !== capability[key as keyof typeof capability]) || request.body.model !== capability.model) contextFail("MEMORY_CONTEXT_COUNTER_MISMATCH");
      if (request.inputTypes.some(type => !capability.inputTypes.includes(type))) contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
      let result: number;
      try { result = exact ? await options.exactCount!(request, { signal }) : estimateBody(request.body); }
      catch { current(); return contextFail("MEMORY_CONTEXT_COUNT_FAILED"); }
      current();
      if (!Number.isSafeInteger(result) || result < 0) contextFail("MEMORY_CONTEXT_COUNT_FAILED");
      return result;
    },
  });
}
