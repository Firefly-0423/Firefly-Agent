import { describe, expect, it } from "vitest";
import {
  addModelProfile as append, updateModelProfile as replace,
  resolveDefaultModelProfile as choose, sameModelCredential,
  type SavedModelProfile,
} from "./model-catalog";
import {
  normalizeModelSettings as normalize, getPublicModelConfig, getDefaultModelProfile,
  resolveModelSettingsProfile as expand,
} from "./model-settings";
import { resolveCaptionVisionConfig } from "../orchestrator/image-router";

function account(id: string, changes: Partial<SavedModelProfile> = {}): SavedModelProfile {
  return {
    id, provider: "ChatGPT（OpenAI）", baseUrl: "https://inference.firefly.test/v1",
    apiKey: "local-catalog-secret", model: "catalog-model", explicitTransport: "openai",
    ...changes,
  };
}

describe("Saved account collection", () => {
  it("appends without changing the previous collection and defaults to the first account", () => {
    const original: SavedModelProfile[] = [];
    const first = account("primary-endpoint", { displayName: "Everyday" });
    const result = append(original, first);
    expect(result).toEqual({ added: true, profiles: [first] });
    expect(original).toEqual([]);
    expect(choose(result.profiles, undefined)).toEqual(first);
    const second = account("backup-endpoint", { apiKey: "backup-secret" });
    const pair = append(result.profiles, second);
    expect(pair.profiles).toEqual([first, second]);
    expect(choose(pair.profiles, "backup-endpoint")).toEqual(second);
    expect(choose(pair.profiles, "deleted-endpoint")).toEqual(first);
    expect(choose([], undefined)).toBeUndefined();
  });

  it("rejects duplicate credentials regardless of labels, identifiers and surrounding whitespace", () => {
    const saved = account("studio");
    for (const candidate of [
      account("studio-copy", { displayName: "Alternate label" }),
      account("trimmed-copy", {
        apiKey: " local-catalog-secret ", model: " catalog-model ",
        baseUrl: " https://inference.firefly.test/v1 ",
      }),
    ]) {
      expect(sameModelCredential(saved, candidate)).toBe(true);
      expect(append([saved], candidate)).toEqual({ added: false, profiles: [saved] });
    }
  });

  it.each([
    { baseUrl: "https://relay.firefly.test/v2" },
    { apiKey: "different-credential" },
    { model: "catalog-model-two" },
  ])("keeps distinct credential tuples: %j", (difference) => {
    const saved = account("direct");
    const alternative = account("alternative", difference);
    expect(sameModelCredential(saved, alternative)).toBe(false);
    expect(append([saved], alternative)).toEqual({ added: true, profiles: [saved, alternative] });
  });

  it("replaces only the selected ID even if the replacement duplicates another account", () => {
    const before = [account("left"), account("right", { apiKey: "previous-secret" })];
    const revision = account("right", {
      displayName: "Reviewed endpoint", contextWindowTokens: 128000, apiKey: "local-catalog-secret",
    });
    expect(replace(before, revision)).toEqual([before[0], revision]);
    expect(before[1].apiKey).toBe("previous-secret");
    expect(replace(before, account("absent"))).toBeNull();
  });
});

describe("Normalization does not create catalog records", () => {
  it("round-trips explicit agent routes and uses an empty mapping when absent", () => {
    const routes = { coding: "editor-account", research: "reader-account" };
    const saved = normalize({ agentModelProfiles: routes });
    expect(saved.agentModelProfiles).toEqual(routes);
    expect(normalize(saved).agentModelProfiles).toEqual(routes);
    expect(normalize({}).agentModelProfiles).toEqual({});
  });

  it("does not treat a saved secret as a verified connection", () => {
    const saved = normalize({
      provider: "ChatGPT（OpenAI）", apiKey: "", model: "",
      modelProfiles: [account("untested-account")],
    });
    expect(getPublicModelConfig(saved).connected).toBe(false);
  });

  it("requires explicit saved profiles even when the provider mirror has credentials", () => {
    const saved = normalize({
      provider: "ChatGPT（OpenAI）", apiKey: "mirror-secret", model: "mirror-model",
      baseUrl: "https://mirror.firefly.test/v1",
    });
    expect(getDefaultModelProfile(saved)).toBeUndefined();
    expect(saved.modelProfiles).toEqual([]);
  });

  it("retains provider caches across normalization and an explicitly cleared catalog", () => {
    const cache = {
      "GLM（智谱）": { baseUrl: "https://glm.firefly.test/v4", apiKey: "glm-cache", model: "glm-4.7" },
      "DeepSeek（深度求索）": { baseUrl: "https://ds.firefly.test", apiKey: "ds-cache", model: "deepseek-chat" },
      "Kimi（月之暗面）": { baseUrl: "https://kimi.firefly.test/v1", apiKey: "", model: "kimi-k2" },
    };
    const saved = normalize({ provider: "GLM（智谱）", perProvider: cache });
    const again = normalize(saved);
    const cleared = normalize({ ...again, modelProfiles: [] });
    for (const view of [saved, again, cleared]) {
      expect(view.modelProfiles).toEqual([]);
      for (const [provider, credentials] of Object.entries(cache)) {
        expect(view.perProvider[provider]).toMatchObject(credentials);
      }
    }
  });
});

describe("Profile expansion for conversations and image tools", () => {
  const vision = account("illustration", {
    provider: "GLM（智谱）", model: "glm-5v-turbo",
    baseUrl: "https://vision.firefly.test/v4", apiKey: "vision-secret", contextWindowTokens: 128000,
  });
  const text = account("editor", {
    provider: "GLM（智谱）", model: "glm-5.2", baseUrl: "https://text.firefly.test/v4",
  });

  it("uses account-specific capacity and capabilities, inheriting only an unspecified capacity", () => {
    const saved = normalize({
      provider: "GLM（智谱）", contextWindowTokens: 256000, contextWindowVersion: 2,
      modelProfiles: [vision, text],
    });
    expect(expand(saved, vision.id)).toMatchObject({
      contextWindowTokens: 128000, multimodal: true, baseUrl: vision.baseUrl,
    });
    expect(expand(saved, text.id)).toMatchObject({ contextWindowTokens: 256000, multimodal: false });
    expect(expand(saved, undefined)).toMatchObject({
      contextWindowTokens: 128000, multimodal: true, baseUrl: "https://vision.firefly.test/v4",
    });
    expect(expand(saved, "missing-profile")).toBe(saved);
  });

  it("derives image capability from the model rather than a stale saved boolean", () => {
    expect(normalize({ provider: "GLM（智谱）", model: "glm-5.2", multimodal: true }).multimodal).toBe(false);
  });

  it("routes caption requests through the default vision account despite an empty provider mirror", () => {
    const saved = normalize({
      provider: "MiniMax", baseUrl: "", apiKey: "", model: "",
      modelProfiles: [vision], defaultModelProfileId: vision.id,
    });
    expect(resolveCaptionVisionConfig(expand(saved))).toEqual({
      ok: true,
      config: { baseUrl: "https://vision.firefly.test/v4", apiKey: "vision-secret", model: "glm-5v-turbo" },
    });
  });

  it("rejects captioning after expanding a text-only default account", () => {
    const saved = normalize({
      provider: "MiniMax",
      modelProfiles: [account("text-default", {
        provider: "MiniMax", model: "MiniMax-M2.7", baseUrl: "https://minimax.firefly.test/v1",
      })],
      defaultModelProfileId: "text-default",
    });
    expect(resolveCaptionVisionConfig(expand(saved))).toEqual({
      ok: false,
      error: "当前模型不支持查看图片。请在「设置 → API 设置」中切换到支持图片的型号（例如 gpt-4o、claude、gemini、qwen-vl、glm-5v 系列）。可在 API 设置 → 该模型 → 高级 → 输入类型 中手动设置。",
    });
  });

  it.each([
    [100, undefined], [4095, undefined], [4096, 4096], [1_000_000, 1_000_000], [1_000_001, 1_000_000],
  ])("normalizes the capacity boundary %s to %s and removes obsolete profile flags", (capacity, expected) => {
    const saved = normalize({
      provider: "GLM（智谱）", contextWindowVersion: 2,
      modelProfiles: [{ ...text, contextWindowTokens: capacity, multimodal: "enabled" } as never],
    });
    expect(saved.modelProfiles?.[0].contextWindowTokens).toBe(expected);
    expect(saved.modelProfiles?.[0]).not.toHaveProperty("multimodal");
  });
});