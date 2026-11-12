// image-router 路由判定表回归测试：
// 图片能力由显式声明 / 内置目录判定（multimodal），不再有独立视觉模型回退。
// 全部组合（multimodal × 协议）都必须有确定结果；不支持图片时必须是 reject，不能返回注定失败的配置。

import { describe, it, expect } from "vitest";
import { resolveImageRoute, resolveCaptionVisionConfig, IMAGE_UNSUPPORTED_REASON, type ImageRouteSettings } from "./image-router";

function makeSettings(overrides: Partial<ImageRouteSettings>): ImageRouteSettings {
  return {
    multimodal: true,
    explicitTransport: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o",
    ...overrides,
  };
}

describe("resolveImageRoute 统一路由", () => {
  it("支持图片的型号 → 直发（不管协议）", () => {
    expect(resolveImageRoute("attachment", makeSettings({ multimodal: true, explicitTransport: "anthropic" })))
      .toEqual({ mode: "direct" });
    expect(resolveImageRoute("channel", makeSettings({ multimodal: true, explicitTransport: "responses" })))
      .toEqual({ mode: "direct" });
  });

  it("不支持图片的型号 → reject，提示说明型号不支持（不再提视觉模型配置）", () => {
    const route = resolveImageRoute("attachment", makeSettings({ multimodal: false }));
    expect(route).toEqual({ mode: "reject", reason: IMAGE_UNSUPPORTED_REASON });
    expect(route.mode === "reject" && route.reason).not.toContain("视觉模型");
    // 拒绝提示给出手动修正的入口（与 DSH 的排错提示对应）
    expect(IMAGE_UNSUPPORTED_REASON).toContain("API 设置 → 该模型 → 高级 → 输入类型");
  });

  it("多模态状态未传 → 按不支持处理（保守）", () => {
    expect(resolveImageRoute("tool", makeSettings({ multimodal: undefined })).mode).toBe("reject");
  });
});

describe("resolveCaptionVisionConfig 图片转述", () => {
  it("支持图片 + OpenAI 兼容 → 主模型自己看图", () => {
    const result = resolveCaptionVisionConfig(makeSettings({ multimodal: true }));
    expect(result).toEqual({
      ok: true,
      config: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4o" },
    });
  });

  it("支持图片 + Anthropic → 显式拒绝（视觉链路只拼 /chat/completions，原为必然 404）", () => {
    const result = resolveCaptionVisionConfig(makeSettings({ multimodal: true, explicitTransport: "anthropic" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Anthropic");
    }
  });

  it("不支持图片 → 拒绝并给出型号提示", () => {
    const result = resolveCaptionVisionConfig(makeSettings({ multimodal: false, model: "glm-5.2" }));
    expect(result).toEqual({ ok: false, error: IMAGE_UNSUPPORTED_REASON });
  });
});
