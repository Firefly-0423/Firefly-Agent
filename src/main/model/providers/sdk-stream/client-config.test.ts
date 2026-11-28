import { describe, it, expect, vi } from "vitest";
import { createEndpointPinnedFetch, deriveAnthropicClientConfig, deriveOpenAIClientConfig } from "./client-config";

describe("SDK endpoint and credential configuration", () => {
  it.each([
    ["https://calendar.invalid/v1/chat/completions", "https://calendar.invalid/v1"],
    ["https://calendar.invalid/proxy/openai/chat/completions", "https://calendar.invalid/proxy/openai"],
  ])("removes only the completions suffix from %s", (endpoint, baseURL) => {
    expect(deriveOpenAIClientConfig(endpoint, "agenda-sdk-key")).toStrictEqual({ baseURL, apiKey: "agenda-sdk-key", maxRetries: 0 });
  });

  it("derives Anthropic roots and selects API-key or bearer credentials", () => {
    expect(deriveAnthropicClientConfig("https://calendar.invalid/proxy/v1/messages", "agenda-sdk-key", "x-api-key")).toEqual({ baseURL: "https://calendar.invalid/proxy", apiKey: "agenda-sdk-key", maxRetries: 0 });
    expect(deriveAnthropicClientConfig("https://calendar.invalid/v1/messages", "agenda-sdk-token", "bearer")).toEqual({ baseURL: "https://calendar.invalid", authToken: "agenda-sdk-token", maxRetries: 0 });
  });

  it("pins a custom endpoint while preserving method, headers, body and cancellation", async () => {
    const abort = new AbortController(), transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("accepted"));
    const pinned = createEndpointPinnedFetch("https://calendar.invalid/agent/messages", transport);
    await pinned(new Request("https://calendar.invalid/v1/messages", { method: "POST", headers: { "x-agenda": "preserved" }, body: "calendar payload", signal: abort.signal }));
    expect(transport).toHaveBeenCalledOnce();
    const outgoing = transport.mock.calls[0][0];
    expect(outgoing).toBeInstanceOf(Request);
    const request = outgoing as Request;
    expect(request.url).toEqual("https://calendar.invalid/agent/messages");
    expect(request.method).toEqual("POST");
    expect(request.headers.get("x-agenda")).toEqual("preserved");
    expect(await request.text()).toEqual("calendar payload");
    abort.abort();
    expect(request.signal.aborted).toEqual(true);
  });

  it("attaches an endpoint wrapper only when the Anthropic path is nonstandard", () => {
    const transport = vi.fn<typeof fetch>();
    expect(deriveAnthropicClientConfig("https://calendar.invalid/v1/messages", "agenda-key", "x-api-key", transport).fetch).toBeUndefined();
    const custom = deriveAnthropicClientConfig("https://calendar.invalid/agent/messages", "agenda-key", "x-api-key", transport);
    expect(custom.baseURL).toEqual("https://calendar.invalid");
    expect(custom.fetch).toBeTypeOf("function");
  });
});
