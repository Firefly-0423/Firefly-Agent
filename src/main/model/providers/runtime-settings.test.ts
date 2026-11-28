import { afterEach, describe, it, expect } from "vitest";
import { CUSTOM_ENDPOINT_PROVIDERS as endpoints } from "../../../shared/custom-endpoint-state";
import { resolveVendorRuntimeSettings as resolve, setVendorRuntimeSettingsGetter as install, getVendorRuntimeSettings as read, type VendorRuntimeSettings } from "./runtime-settings";

afterEach(() => install(() => ({})));

describe("Runtime overrides admitted by endpoint class", () => {
  it.each([
    [endpoints.local, -1], [endpoints.cloud, 1],
  ] as const)("retains custom endpoint settings for %s", (provider, thinkingOverride) => {
    expect(resolve({ provider, thinkingOverride, disableMaxToken: true })).toStrictEqual({ thinkingOverride, disableMaxToken: true });
  });

  it("preserves missing custom values as undefined", () => {
    expect(resolve({ provider: endpoints.cloud })).toStrictEqual({ disableMaxToken: undefined, thinkingOverride: undefined });
  });

  it.each([
    ["Claude（Anthropic）", -1, true], ["MiniMax（稀宇科技）", 1, true],
    ["Kimi（月之暗面）", 1, true], ["DeepSeek（深度求索）", -1, true],
    ["Qwen（通义千问）", -1, true], ["ChatGPT（OpenAI）", 1, true],
    ["MiMo（小米）", 1, false], ["GLM（智谱）", 1, true],
    ["unknown-calendar-gateway", 1, true], ["", 1, true],
  ] as const)("disables endpoint overrides for %s", (provider, thinkingOverride, disableMaxToken) => {
    expect(resolve({ provider, thinkingOverride, disableMaxToken })).toEqual({ thinkingOverride: 0, disableMaxToken: false });
  });

  it("guards preset settings even if only one legacy field is populated", () => {
    expect(resolve({ provider: "Claude（Anthropic）", disableMaxToken: true }).disableMaxToken).toBe(false);
    expect(resolve({ provider: "DeepSeek（深度求索）", thinkingOverride: 1 }).thinkingOverride).toBe(0);
    expect(resolve({ provider: "Qwen（通义千问）", thinkingOverride: -1 }).thinkingOverride).toBe(0);
  });
});

describe("Live runtime settings supplier", () => {
  it("reads every new snapshot instead of caching the installed getter's first value", () => {
    install(() => ({}));
    expect(read()).toStrictEqual({});
    let current: VendorRuntimeSettings = { disableMaxToken: true, thinkingOverride: 1 };
    install(() => current);
    expect(read()).toStrictEqual({ disableMaxToken: true, thinkingOverride: 1 });
    current = { disableMaxToken: false, thinkingOverride: 0 };
    expect(read()).toStrictEqual({ disableMaxToken: false, thinkingOverride: 0 });
  });

  it("applies endpoint resolution when supplied by the application", () => {
    install(() => resolve({ provider: endpoints.local, disableMaxToken: true, thinkingOverride: -1 }));
    expect(read()).toStrictEqual({ disableMaxToken: true, thinkingOverride: -1 });
    install(() => resolve({ provider: "Claude（Anthropic）", disableMaxToken: true, thinkingOverride: 1 }));
    expect(read()).toStrictEqual({ disableMaxToken: false, thinkingOverride: 0 });
  });
});
