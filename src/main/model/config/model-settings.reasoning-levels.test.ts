import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/firefly-test" } }));

import { normalizeModelSettings, resolveModelSettingsProfile } from "./model-settings";

const profile = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: "自定义",
  model: `model-${id}`,
  baseUrl: "https://proxy.example.test/v1",
  apiKey: `key-${id}`,
  explicitTransport: "openai" as const,
  ...extra,
});

describe("per-profile reasoning levels", () => {
  it("keeps a declared level set on the saved profile and sanitises it", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [
        profile("a", { reasoningLevels: { efforts: ["high", "low", "bogus"], allowOff: true } }),
        profile("b"),
        profile("c", { reasoningLevels: "not-an-object" }),
      ],
    });
    const byId = Object.fromEntries((settings.modelProfiles ?? []).map((item) => [item.id, item]));
    expect(byId.a.reasoningLevels).toEqual({ efforts: ["low", "high"], allowOff: true });
    expect(byId.b.reasoningLevels).toBeUndefined();
    expect(byId.c.reasoningLevels).toBeUndefined();
  });

  it("hands the chosen profile's levels to the request layer, and none from a profile without them", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [profile("a", { reasoningLevels: { efforts: ["low", "high"] } }), profile("b")],
    });
    expect(resolveModelSettingsProfile(settings, "a").reasoningLevels).toEqual({ efforts: ["low", "high"] });
    expect(resolveModelSettingsProfile(settings, "b").reasoningLevels).toBeUndefined();
  });

  it("an empty declaration (on/off only) is kept, not mistaken for 'undeclared'", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [profile("a", { reasoningLevels: { efforts: [], allowOff: true } })],
    });
    expect(settings.modelProfiles?.[0].reasoningLevels).toEqual({ efforts: [], allowOff: true });
  });
});

describe("OpenRouter profile", () => {
  it("keeps the provider, Chat Completions transport, effort and declared levels through normalization", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [
        profile("or", {
          provider: "OpenRouter",
          model: "openai/gpt-5.6",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-v1-test",
          explicitTransport: "openai",
          reasoning: { mode: "on", effort: "max" },
          reasoningLevels: { efforts: ["high", "max", "bogus"], allowOff: true },
        }),
      ],
    });
    expect(resolveModelSettingsProfile(settings, "or")).toMatchObject({
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.6",
      explicitTransport: "openai",
      reasoning: { mode: "on", effort: "max" },
      reasoningLevels: { efforts: ["high", "max"], allowOff: true },
    });
  });
});
