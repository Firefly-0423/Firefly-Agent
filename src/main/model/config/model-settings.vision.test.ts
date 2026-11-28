import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/firefly-test" } }));

import { normalizeModelSettings, resolveModelSettingsProfile } from "./model-settings";

describe("normalizeModelSettings 图片能力由显式声明与内置目录推断", () => {
  it("多模态跟随顶层厂商 + 型号，旧存档里的 multimodal / vision 字段被忽略", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [],
      provider: "ChatGPT（OpenAI）",
      model: "gpt-4o",
      multimodal: false,
      vision: { baseUrl: "https://vision.example.test", apiKey: "test-key", model: "vision-test" },
    } as Parameters<typeof normalizeModelSettings>[0]);

    expect(settings.multimodal).toBe(true);
    expect(settings).not.toHaveProperty("vision");
  });

  it("纯文本型号即使存档写了 multimodal: true 也判为不支持图片", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [],
      provider: "GLM（智谱）",
      model: "glm-5.2",
      multimodal: true,
    } as Parameters<typeof normalizeModelSettings>[0]);

    expect(settings.multimodal).toBe(false);
  });

  it("档案展开时按该档案的厂商与型号重新判定，不读取档案里的旧 multimodal 字段", () => {
    const settings = normalizeModelSettings({
      schemaVersion: 2,
      modelProfiles: [{
        id: "claude-profile",
        provider: "Claude（Anthropic）",
        model: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "test-key",
        multimodal: false,
      }],
      defaultModelProfileId: "claude-profile",
    } as Parameters<typeof normalizeModelSettings>[0]);

    expect(resolveModelSettingsProfile(settings, "claude-profile").multimodal).toBe(true);
    expect(resolveModelSettingsProfile(settings, "claude-profile")).not.toHaveProperty("vision");
  });
});

describe("输入模态声明：档案覆盖内置目录，展开与顶层镜像一致", () => {
  it("档案里的显式声明压过内置目录，并带上来源", () => {
    const settings = normalizeModelSettings({
      modelProfiles: [{
        id: "p-text",
        provider: "ChatGPT（OpenAI）",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "gpt-4o",
        inputModalities: ["text"],
        inputModalitiesSource: "user",
      }],
      defaultModelProfileId: "p-text",
    });

    expect(resolveModelSettingsProfile(settings, "p-text")).toMatchObject({
      multimodal: false,
      inputModalities: ["text"],
      inputModalitiesSource: "user",
    });
  });

  it("厂商接口记录能让目录未知的型号直发图片；来源非法的声明记为用户覆盖", () => {
    const settings = normalizeModelSettings({
      modelProfiles: [
        { id: "p-vendor", provider: "自定义", baseUrl: "https://gw.example/v1", apiKey: "test-key", model: "brand-new", inputModalities: ["text", "image"], inputModalitiesSource: "vendor-api" },
        { id: "p-bad-source", provider: "自定义", baseUrl: "https://gw.example/v1", apiKey: "test-key", model: "other", inputModalities: ["image"], inputModalitiesSource: "catalog" },
      ],
      defaultModelProfileId: "p-vendor",
    } as Parameters<typeof normalizeModelSettings>[0]);

    expect(resolveModelSettingsProfile(settings, "p-vendor")).toMatchObject({ multimodal: true, inputModalitiesSource: "vendor-api" });
    expect(resolveModelSettingsProfile(settings, "p-bad-source")).toMatchObject({ multimodal: true, inputModalitiesSource: "user" });
  });

  it("非法或缺失的声明回落为未声明：不写入字段，目录照常生效", () => {
    const settings = normalizeModelSettings({
      modelProfiles: [
        { id: "p-junk", provider: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key", model: "claude-sonnet-4-6", inputModalities: ["audio"], inputModalitiesSource: "vendor-api" },
        { id: "p-missing", provider: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key", model: "claude-sonnet-4-6" },
      ],
      defaultModelProfileId: "p-junk",
    } as Parameters<typeof normalizeModelSettings>[0]);

    const junk = settings.modelProfiles!.find((item) => item.id === "p-junk")!;
    expect(junk).not.toHaveProperty("inputModalities");
    expect(junk).not.toHaveProperty("inputModalitiesSource");
    expect(resolveModelSettingsProfile(settings, "p-junk")).toMatchObject({ multimodal: true, inputModalitiesSource: undefined });
    expect(resolveModelSettingsProfile(settings, "p-missing").multimodal).toBe(true);
  });

  it("顶层镜像跟随当前厂商的声明，与档案展开结果一致", () => {
    const settings = normalizeModelSettings({
      provider: "自定义",
      perProvider: {
        "自定义": { baseUrl: "https://gw.example/v1", model: "brand-new", apiKey: "test-key", inputModalities: ["text", "image"], inputModalitiesSource: "user" },
      },
    } as Parameters<typeof normalizeModelSettings>[0]);

    expect(settings).toMatchObject({ multimodal: true, inputModalities: ["text", "image"], inputModalitiesSource: "user" });
  });
});
