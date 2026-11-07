import type { VendorConfig } from "./types";

type VendorConfigSource = Pick<VendorConfig, "provider" | "baseUrl" | "model" | "apiKey" | "explicitTransport" | "reasoning" | "reasoningLevels">;

/**
 * The model config every request path sends. The memory runtime binds this same shape from the
 * saved profile and refuses a call whose config differs (MEMORY_CONTEXT_REQUEST_CHANGED), so all
 * callers build it here instead of listing fields themselves.
 */
export function vendorConfigFromSettings(source: VendorConfigSource): VendorConfig {
  return {
    provider: source.provider, baseUrl: source.baseUrl, model: source.model, apiKey: source.apiKey,
    ...(source.explicitTransport ? { explicitTransport: source.explicitTransport } : {}),
    ...(source.reasoning ? { reasoning: structuredClone(source.reasoning) } : {}),
    ...(source.reasoningLevels ? { reasoningLevels: structuredClone(source.reasoningLevels) } : {}),
  };
}
