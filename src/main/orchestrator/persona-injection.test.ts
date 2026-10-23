import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildModePrompt } from "./mode-prompt-profile";

// 用真实的 prompts/ 文件拼出每个模式的人格注入，检查人格只注入一次、没有旧版互相冲突的表述。
const promptsDir = path.resolve(__dirname, "../../../prompts");
const load = (name: string) => fs.readFileSync(path.join(promptsDir, name), "utf8").replace(/\r\n/g, "\n").trim();
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("Firefly persona injection", () => {
  it.each(["chat", "work", "code"] as const)("injects the persona core exactly once in %s mode", (mode) => {
    const prompt = buildModePrompt(mode, load);
    expect(count(prompt, "# 流萤 · 人格核心")).toBe(1);
    expect(count(prompt, "编号 AR-26710")).toBe(1);
    expect(prompt).toContain("表达校准");
  });

  it("keeps the honest AI-role identity and drops the old model-versus-persona framing", () => {
    for (const mode of ["chat", "work"] as const) {
      const prompt = buildModePrompt(mode, load);
      expect(prompt).toContain("以流萤为角色的 AI 对话");
      expect(prompt).not.toMatch(/认知引擎|动态情绪|不把底层语言模型直接等同于流萤/);
    }
  });

  it("keeps the product-specific chat rendering rules next to the persona", () => {
    const chat = buildModePrompt("chat", load);
    expect(chat).toContain("```mermaid");
    expect(chat).toContain("不复述桌宠（Live2D）已经执行的动作");
  });

  it("labels every expression sample as non-canonical so it cannot be read as an official line or shared history", () => {
    for (const file of ["canon_quotes.md", "canon_quotes_lite.md"]) {
      expect(load(file)).toContain("不是官方台词");
      expect(load(file)).toContain("没有相同上下文时，不直接复用");
    }
  });

  it("keeps the combat register out of everyday chat and keeps the punctuation habits in the tone rules", () => {
    const tone = load("tone-rules.md");
    expect(tone).toContain("战术通报式的简短口吻");
    expect(tone).toContain("只用于战斗场景或用户明确要求的角色扮演");
    expect(tone).toContain("日常回答不用感叹号");
    expect(tone).toContain("「啦」「吧」只在打招呼、道别这类轻松的场合偶尔用");
    expect(tone).toContain("不懂或不会时直接承认");
  });

  it("does not let the runtime tone reminder or any mode file restate a default address that contradicts the persona", () => {
    const tone = load("tone-rules.md");
    expect(tone).toContain("偶尔称「开拓者」");
    expect(tone).not.toContain("没有设置时称呼「开拓者」");
    for (const mode of ["chat", "work", "code"] as const) {
      expect(buildModePrompt(mode, load)).not.toContain("默认称呼用户为「开拓者」");
      expect(buildModePrompt(mode, load)).not.toContain("对外自然称呼用户为「开拓者」");
    }
  });
});
