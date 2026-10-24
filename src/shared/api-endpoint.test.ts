import { it, expect, describe } from "vitest";
import { resolveApiEndpoint, type ApiTransport } from "./api-endpoint";

describe("URLs used by model transports", () => {
  it.each<[ApiTransport, string, string, string | null]>([
    ["responses", "https://inference.invalid/v1/responses/", "https://inference.invalid/v1/responses", null],
    ["openai", "https://inference.invalid/chat/completions/", "https://inference.invalid/chat/completions", null],
    ["anthropic", "https://inference.invalid/v1/messages", "https://inference.invalid/v1/messages", null],
    ["responses", "https://inference.invalid/api/v3", "https://inference.invalid/api/v3/responses", "/responses"],
    ["responses", "https://inference.invalid/v1", "https://inference.invalid/v1/responses", "/responses"],
    ["responses", "https://inference.invalid", "https://inference.invalid/responses", "/responses"],
    ["anthropic", "https://inference.invalid/compat", "https://inference.invalid/compat/v1/messages", "/v1/messages"],
    ["anthropic", "https://inference.invalid/v1", "https://inference.invalid/v1/messages", "/messages"],
    ["openai", "https://inference.invalid", "https://inference.invalid/chat/completions", "/chat/completions"],
  ])("resolves %s at %s", (transport, input, url, appendedSuffix) => {
    expect(resolveApiEndpoint(input, transport)).toStrictEqual({ url, appendedSuffix });
  });

  it("removes surrounding whitespace and all trailing separators", () => {
    expect(resolveApiEndpoint("  https://inference.invalid/v1///  ", "anthropic")).toStrictEqual({
      url: "https://inference.invalid/v1/messages", appendedSuffix: "/messages",
    });
  });
});