import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

vi.mock("../external-content-paths", () => ({ findPromptPath: vi.fn() }));
import { findPromptPath } from "../external-content-paths";
import { buildToneInjection } from "./tone-injector";

afterEach(() => vi.resetAllMocks());

describe("Firefly tone injection", () => {
  it("uses the same Firefly rules when the external prompt is missing", () => {
    vi.mocked(findPromptPath).mockReturnValue(null);
    const rules = fs.readFileSync(path.resolve(__dirname, "../../../prompts/tone-rules.md"), "utf8").replace(/\r\n/g, "\n").trim();
    expect(buildToneInjection()).toBe("## 语气规则\n\n" + rules);
    expect(rules).toContain("共同经历只能依据当前对话或有效用户记忆");
    expect(rules).toContain("可以分点、解释和总结");
    expect(rules).toContain("用户明确设置的称呼优先");
    expect(rules).not.toContain("Learn");
  });

  it("loads the prompt from the existing resolver without another persona parser", () => {
    vi.mocked(findPromptPath).mockReturnValue(path.resolve(__dirname, "../../../prompts/tone-rules.md"));
    expect(buildToneInjection()).toContain("## 流萤的表达");
    expect(findPromptPath).toHaveBeenCalledWith("tone-rules.md");
  });

  it("falls back to Firefly rather than the old character after a read error", () => {
    vi.mocked(findPromptPath).mockReturnValue(path.resolve(__dirname, "tone-rules-does-not-exist.md"));
    expect(buildToneInjection()).toContain("自称「我」");
    expect(buildToneInjection()).not.toContain("不要教用户什么事该怎么做");
  });
});
