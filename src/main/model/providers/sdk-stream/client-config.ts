export type OpenAIClientConfig = { maxRetries: 0; apiKey: string; baseURL: string };
export type AnthropicClientConfig = {
  fetch?: typeof fetch;
  maxRetries: 0;
  authToken?: string;
  apiKey?: string;
  baseURL: string;
};
const trimSlash = (source: string): string => source.replace(/\/+$/, "");
function sdkBase(address: string, ending: string): string | undefined {
  const parsed = new URL(address);
  const route = trimSlash(parsed.pathname);
  return route.endsWith(ending) ? trimSlash(parsed.origin + route.slice(0, -ending.length)) : undefined;
}
export function deriveOpenAIClientConfig(endpoint: string, apiKey: string): OpenAIClientConfig {
  const origin = sdkBase(endpoint, "/chat/completions");
  if (!origin) throw new Error("OpenAI SDK endpoint must end with /chat/completions");
  return { baseURL: origin, apiKey, maxRetries: 0 };
}
export function deriveResponsesClientConfig(endpoint: string, apiKey: string): OpenAIClientConfig {
  const origin = sdkBase(endpoint, "/responses");
  if (!origin) throw new Error("OpenAI SDK Responses endpoint must end with /responses");
  return { baseURL: origin, apiKey, maxRetries: 0 };
}
export function createEndpointPinnedFetch(endpoint: string, delegate: typeof fetch = fetch): typeof fetch {
  return async (resource, options) => {
    const request = new Request(resource, options);
    return delegate(new Request(endpoint, request));
  };
}
export function deriveAnthropicClientConfig(endpoint: string, apiKey: string,
  authStyle: "bearer" | "x-api-key", delegate: typeof fetch = fetch): AnthropicClientConfig {
  const standard = sdkBase(endpoint, "/v1/messages");
  const parsed = new URL(endpoint);
  const credentials = authStyle === "bearer" ? { authToken: apiKey } : { apiKey };
  return standard ? { baseURL: standard, ...credentials, maxRetries: 0 }
    : { baseURL: parsed.origin, ...credentials, maxRetries: 0, fetch: createEndpointPinnedFetch(endpoint, delegate) };
}
