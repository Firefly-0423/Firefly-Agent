import { describe, it, expect } from "vitest";
import { resolveInputModalities } from "./multimodal";
import { MODEL_MODALITY_CATALOG } from "./model-modalities.catalog";

const image = (provider: string, model: string) => resolveInputModalities({ provider, model }).image;

describe("resolveInputModalities 内置目录回落", () => {
  it.each([
    ["MiniMax（稀宇科技）", "MiniMax-M3"],
    ["DeepSeek（深度求索）", "deepseek-flash"],
    ["DeepSeek（深度求索）", "deepseek-v4-flash-vision-exp"],
    ["GLM（智谱）", "glm-5v-turbo"],
    ["Kimi（月之暗面）", "kimi-k2.7-code"],
    ["Kimi（月之暗面）", "kimi-k2.5"],
    ["Qwen（通义千问）", "qwen-vl-max"],
    ["ChatGPT（OpenAI）", "gpt-4o"],
    ["ChatGPT（OpenAI）", "gpt-4o-mini"],
    ["ChatGPT（OpenAI）", "gpt-4.1-mini"],
    ["ChatGPT（OpenAI）", "gpt-5.6-terra"],
    ["ChatGPT（OpenAI）", "gpt-6-astra"],
    ["Claude（Anthropic）", "claude-sonnet-4-6"],
    ["小米 MiMo", "mimo-v2.5"],
  ])("%s / %s 支持图片", (provider, model) => {
    expect(image(provider, model)).toBe(true);
  });

  it.each([
    ["DeepSeek（深度求索）", "deepseek-v4-pro"],
    ["MiniMax（稀宇科技）", "MiniMax-M2.7"],
    ["GLM（智谱）", "glm-5.2"],
    ["Qwen（通义千问）", "qwen-max"],
    ["Kimi（月之暗面）", "kimi-k2-thinking"],
    ["ChatGPT（OpenAI）", "o3"],
    ["小米 MiMo", "mimo-v2.5-pro"],
    ["自定义", "some-local-model"],
    ["自定义", ""],
  ])("%s / %s 不支持图片（保守默认）", (provider, model) => {
    expect(image(provider, model)).toBe(false);
  });

  it("名字里的视觉标记跨厂商生效（自定义端点托管的视觉型号）", () => {
    expect(image("自定义", "llava-vision-7b")).toBe(true);
    expect(image("自定义", "gemini-2.5-pro")).toBe(true);
  });

  it("OpenRouter 风格的 \"厂商/型号\" 按裸型号名匹配", () => {
    expect(image("OpenRouter", "openai/gpt-6-luna")).toBe(true);
    expect(image("OpenRouter", "anthropic/claude-sonnet-5-5")).toBe(true);
    expect(image("OpenRouter", "google/gemini-2.5-pro")).toBe(true);
    expect(image("OpenRouter", "meta/llama-3-8b")).toBe(false);
  });

  it("厂商限定的规则不会跨厂商误判", () => {
    // "flash" 只在 DeepSeek 下视为视觉型号，其他厂商的同名型号不算
    expect(image("GLM（智谱）", "flash-lite")).toBe(false);
  });

  it("目录命中时依据是 catalog，未命中是 unknown（都不是显式声明）", () => {
    expect(resolveInputModalities({ provider: "Claude（Anthropic）", model: "claude-sonnet-4-6" }))
      .toEqual({ image: true, source: "catalog" });
    expect(resolveInputModalities({ provider: "自定义", model: "some-local-model" }))
      .toEqual({ image: false, source: "unknown" });
    expect(resolveInputModalities({ provider: "自定义", model: "" }))
      .toEqual({ image: false, source: "unknown" });
  });

  it("目录每条规则都能编译成正则，且都声明了输入模态", () => {
    for (const entry of MODEL_MODALITY_CATALOG) {
      expect(() => new RegExp(entry.pattern, "i")).not.toThrow();
      expect(entry.input.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveInputModalities 显式声明优先级", () => {
  it("用户覆盖压过目录：支持图片的型号被手动设为仅文本", () => {
    expect(resolveInputModalities({
      provider: "ChatGPT（OpenAI）", model: "gpt-4o", declared: ["text"], declaredSource: "user",
    })).toEqual({ image: false, source: "declared-user" });
  });

  it("用户覆盖压过未知：目录没有的型号被手动设为图片", () => {
    expect(resolveInputModalities({
      provider: "自定义", model: "my-gateway-model", declared: ["text", "image"], declaredSource: "user",
    })).toEqual({ image: true, source: "declared-user" });
  });

  it("厂商接口记录压过目录：目录说支持图片，厂商明确说不支持，以厂商为准", () => {
    expect(resolveInputModalities({
      provider: "Claude（Anthropic）", model: "claude-sonnet-4-6", declared: ["text"], declaredSource: "vendor-api",
    })).toEqual({ image: false, source: "declared-vendor-api" });
  });

  it("厂商接口记录能让目录未知的型号支持图片", () => {
    expect(resolveInputModalities({
      provider: "自定义", model: "brand-new-model", declared: ["text", "image"], declaredSource: "vendor-api",
    })).toEqual({ image: true, source: "declared-vendor-api" });
  });

  it("没有来源的声明按用户覆盖对待", () => {
    expect(resolveInputModalities({ provider: "自定义", model: "x", declared: ["image"] }))
      .toEqual({ image: true, source: "declared-user" });
  });

  it("空的声明等同于未声明，继续走目录", () => {
    expect(resolveInputModalities({ provider: "Claude（Anthropic）", model: "claude-sonnet-4-6", declared: [], declaredSource: "user" }))
      .toEqual({ image: true, source: "catalog" });
  });
});
