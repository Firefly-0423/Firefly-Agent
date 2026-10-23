import { expect, test } from "vitest";
import * as endpoint from "./custom-endpoint-state";

test("saved endpoint provider identifiers round-trip without conflating local and cloud", () => {
  const keys = endpoint.CUSTOM_ENDPOINT_PROVIDERS;
  expect(new Set(Object.values(keys)).size).toBe(2);
  for (const mode of ["local", "cloud"] as const) {
    const provider = endpoint.getCustomEndpointProvider(mode);
    expect(provider).toBe(keys[mode]);
    expect(endpoint.getCustomEndpointMode(provider)).toBe(mode);
  }
  expect(endpoint.getCustomEndpointMode("OpenAI")).toBeNull();
});

test.each([
  { mode: "cloud" as const, displayName: "自定义云端", apiKeyOptional: false, baseUrlPlaceholder: "https://your-provider.example/v1" },
  { mode: "local" as const, displayName: "本地模型", apiKeyOptional: true, baseUrlPlaceholder: "http://127.0.0.1:11434/v1" },
])("$mode form presents its own key policy and endpoint example", ({ mode, ...presentation }) => {
  expect(endpoint.getCustomEndpointPresentation(mode)).toMatchObject(presentation);
});

test("local inference accepts an empty key but the cloud form requires one", () => {
  const local = { model: "cedar:3b", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" };
  expect(endpoint.validateCustomEndpointConfig("local", local)).toBeNull();
  const cloud = { model: "cloud-chat-compact", apiKey: "", baseUrl: "https://relay.invalid/api" };
  expect(endpoint.validateCustomEndpointConfig("cloud", cloud)).toBe("请填写 API Key");
});

test.each([
  ["missing URL", "", "cedar:3b", "请填写 Base URL"],
  ["scheme missing", "localhost:8921", "cedar:3b", "Base URL 必须是完整的 HTTP(S) 地址"],
  ["unsupported scheme", "ftp://localhost/checkpoint", "cedar:3b", "Base URL 必须是完整的 HTTP(S) 地址"],
  ["missing model", "http://127.0.0.1:11434/v1", "", "请填写模型 ID"],
])("local endpoint validation reports %s", (_reason, baseUrl, model, expected) => {
  expect(endpoint.validateCustomEndpointConfig("local", { model, baseUrl, apiKey: "" })).toEqual(expected);
});
