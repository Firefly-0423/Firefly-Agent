import { describe, it, expect } from "vitest";
import { authHeaderFor } from "./auth";
import type { ProviderCapability } from "./types";

const gateway: ProviderCapability = {
  id: "calendar-gateway", displayName: "Calendar Gateway", transport: "openai", baseUrl: "https://calendar.invalid/v1",
  authStyle: "bearer", defaultModel: "agenda-model", supportsTools: true, supportsThinking: false,
  thinkingField: null, cacheStrategy: "none", testStrategy: "text",
};

describe("Vendor credential headers", () => {
  it.each([
    ["bearer", { Authorization: "Bearer credential-agenda-84" }],
    ["x-api-key", { "x-api-key": "credential-agenda-84" }],
  ] as const)("serializes %s authentication with no extra secret fields", (authStyle, expected) => {
    const headers = authHeaderFor({ ...gateway, authStyle }, "credential-agenda-84");
    expect(headers).toStrictEqual(expected);
    const serialized = JSON.stringify(headers);
    expect(serialized).toContain("credential-agenda-84");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token=");
  });

  it("selects the Anthropic override only for that transport", () => {
    const dual = { ...gateway, anthropicAuthStyle: "x-api-key" as const };
    expect(authHeaderFor(dual, "agenda-key", "anthropic")).toStrictEqual({ "x-api-key": "agenda-key" });
    expect(authHeaderFor(dual, "agenda-key", "openai")).toStrictEqual({ Authorization: "Bearer agenda-key" });
  });

  it.each([undefined, "unrecognized"])("rejects the invalid style %s without disclosing credentials", (invalid) => {
    const misconfigured = { ...gateway, displayName: "MiMo（小米）", authStyle: invalid as "bearer" };
    const attempt = () => authHeaderFor(misconfigured, "private-agenda-key");
    expect(attempt).toThrow(/MiMo（小米）/);
    expect(attempt).toThrow(/invalid authStyle/);
    try { attempt(); } catch (failure) { expect((failure as Error).message).not.toContain("private-agenda-key"); }
  });
});
