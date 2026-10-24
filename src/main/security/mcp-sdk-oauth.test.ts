import { describe, expect, it } from "vitest";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// Public fixtures only. The fetch substitute keeps even the vulnerable SDK's
// credential-bearing requests entirely in this process.
const trustedIssuer = "https://auth.example.test";
const mcpUrl = "https://mcp.example.test";

function fixture(issuer: string) {
  const requests: Array<{ url: string; body: string }> = [];
  let savedTokens: OAuthTokens | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://localhost/callback",
    clientMetadata: { redirect_uris: ["http://localhost/callback"] },
    clientInformation: () => ({
      client_id: "public-fixture-client",
      client_secret: "public-fixture-secret",
      issuer: trustedIssuer,
    }),
    tokens: () => ({
      access_token: "public-fixture-access",
      token_type: "Bearer",
      refresh_token: "public-fixture-refresh",
      issuer: trustedIssuer,
    }),
    saveTokens: tokens => { savedTokens = tokens; },
    redirectToAuthorization: () => { throw new Error("Unexpected interactive authorization"); },
    saveCodeVerifier: () => {},
    codeVerifier: () => "public-fixture-verifier",
    discoveryState: () => ({
      authorizationServerUrl: issuer,
      resourceMetadata: { resource: mcpUrl, authorization_servers: [issuer] },
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      },
    }),
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url !== `${issuer}/token`) throw new Error(`Unexpected fixture request: ${url}`);
    requests.push({ url, body: String(init?.body) });
    return Response.json({
      access_token: "public-fixture-renewed",
      token_type: "Bearer",
      refresh_token: "public-fixture-renewed-refresh",
      // A token response must not control the issuer stamped on credentials.
      issuer: "https://response-controlled.example.test",
    });
  };
  return { provider, fetchFn, requests, savedTokens: () => savedTokens };
}

describe("MCP SDK OAuth credential issuer binding", () => {
  it("refuses a stored client secret and refresh token at a different authorization server", async () => {
    const context = fixture("https://other-auth.example.test");
    await expect(auth(context.provider, { serverUrl: mcpUrl, fetchFn: context.fetchFn }))
      .rejects.toThrow(/bound to authorization server/);
    expect(context.requests).toEqual([]);
    expect(context.savedTokens()).toBeUndefined();
  });

  it("refreshes at the bound issuer and saves that issuer instead of response-supplied metadata", async () => {
    const context = fixture(trustedIssuer);
    expect(await auth(context.provider, { serverUrl: mcpUrl, fetchFn: context.fetchFn })).toBe("AUTHORIZED");
    expect(context.requests).toHaveLength(1);
    expect(context.requests[0].url).toBe("https://auth.example.test/token");
    const body = new URLSearchParams(context.requests[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("public-fixture-refresh");
    expect(body.get("client_secret")).toBe("public-fixture-secret");
    expect(context.savedTokens()).toMatchObject({
      access_token: "public-fixture-renewed",
      issuer: "https://auth.example.test",
    });
  });
});
