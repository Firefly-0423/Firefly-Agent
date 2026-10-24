import { describe, expect, it } from "vitest";
import {
  CUSTOM_ENDPOINT_PROVIDERS,
  getCustomEndpointMode,
  getCustomEndpointPresentation,
  getCustomEndpointProvider,
} from "./custom-endpoint-state";

describe("custom endpoint providers", () => {
  it("maps each mode to a distinct persisted provider string", () => {
    expect(getCustomEndpointProvider("cloud")).toBe(CUSTOM_ENDPOINT_PROVIDERS.cloud);
    expect(getCustomEndpointProvider("local")).toBe(CUSTOM_ENDPOINT_PROVIDERS.local);
    expect(CUSTOM_ENDPOINT_PROVIDERS.cloud).not.toBe(CUSTOM_ENDPOINT_PROVIDERS.local);
  });

  it("round-trips cloud and local provider strings", () => {
    expect(getCustomEndpointMode(getCustomEndpointProvider("cloud"))).toBe("cloud");
    expect(getCustomEndpointMode(getCustomEndpointProvider("local"))).toBe("local");
  });

  it.each([
    "MiniMax（稀宇科技）",
    "自定义端点",
    "custom",
    "",
    " ",
    CUSTOM_ENDPOINT_PROVIDERS.cloud + " ",
  ])("returns null for non-custom provider %j", (provider) => {
    expect(getCustomEndpointMode(provider)).toBeNull();
  });
});

describe("custom endpoint presentation", () => {
  it("presents cloud endpoints as API-key based with an HTTPS placeholder", () => {
    expect(getCustomEndpointPresentation("cloud")).toEqual({
      displayName: "自定义云端",
      apiKeyOptional: false,
      baseUrlPlaceholder: "https://your-provider.example/v1",
    });
  });

  it("presents local endpoints with an optional key and a localhost placeholder", () => {
    expect(getCustomEndpointPresentation("local")).toEqual({
      displayName: "本地模型",
      apiKeyOptional: true,
      baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
    });
  });
});
