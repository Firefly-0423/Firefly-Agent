import { describe, expect, it } from "vitest";
import { normalizeModelSettings, resolveModelSettingsProfile } from "./model-settings";

const profile = (id: string, contextWindowTokens?: number) => ({
  id, provider: "GLM（智谱）", baseUrl: `https://${id}.example.com`, apiKey: "k", model: "glm-5.2",
  ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
});

describe("context window settings", () => {
  it("defaults to 1M for settings and for profiles without their own value", () => {
    const settings = normalizeModelSettings({ provider: "GLM（智谱）", modelProfiles: [profile("a")] } as never);
    expect(settings.contextWindowTokens).toBe(1_000_000);
    expect(settings.modelProfiles?.[0].contextWindowTokens).toBeUndefined();
    expect(resolveModelSettingsProfile(settings, "a").contextWindowTokens).toBe(1_000_000);
  });

  it("migrates the 256000 older builds wrote into every saved profile, once", () => {
    const legacy = normalizeModelSettings({
      provider: "GLM（智谱）", contextWindowTokens: 256000,
      modelProfiles: [profile("fixed", 256000), profile("custom", 128000)],
    } as never);
    expect(legacy.contextWindowVersion).toBe(2);
    expect(legacy.contextWindowTokens).toBe(1_000_000);
    expect(legacy.modelProfiles?.find((p) => p.id === "fixed")?.contextWindowTokens).toBeUndefined();
    expect(legacy.modelProfiles?.find((p) => p.id === "custom")?.contextWindowTokens).toBe(128000);
    expect(resolveModelSettingsProfile(legacy, "fixed").contextWindowTokens).toBe(1_000_000);

    // 迁移后再次保存：用户这次手填的 256000 是有意的，原样保留。
    const saved = normalizeModelSettings({ ...legacy, modelProfiles: [profile("fixed", 256000)] } as never);
    expect(saved.modelProfiles?.[0].contextWindowTokens).toBe(256000);
    expect(normalizeModelSettings(saved).modelProfiles?.[0].contextWindowTokens).toBe(256000);
  });

  it("clamps to 1M and drops values below the minimum", () => {
    const settings = normalizeModelSettings({
      provider: "GLM（智谱）", contextWindowVersion: 2, contextWindowTokens: 5_000_000,
      modelProfiles: [profile("big", 2_000_000), profile("tiny", 1000)],
    } as never);
    expect(settings.contextWindowTokens).toBe(1_000_000);
    expect(settings.modelProfiles?.find((p) => p.id === "big")?.contextWindowTokens).toBe(1_000_000);
    expect(settings.modelProfiles?.find((p) => p.id === "tiny")?.contextWindowTokens).toBeUndefined();
  });
});
