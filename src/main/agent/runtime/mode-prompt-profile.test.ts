import { describe, expect, it } from "vitest";
import { buildModePrompt } from "./mode-prompt-profile";

const marker = (name: string) => `[${name}]`;
const load = (name: string) => marker(name);

describe("buildModePrompt", () => {
  it("rejects retired Learn prompt requests", () => {
    expect(() => buildModePrompt("learn" as never, load)).toThrow("INVALID_CONVERSATION_MODE");
  });
  it("retains workspace hygiene in the Work protocol rather than an optional Skill", () => {
    expect(buildModePrompt("work", load)).toContain(marker("workflow-support/work-hygiene.md"));
    expect(buildModePrompt("chat", load)).not.toContain(marker("workflow-support/work-hygiene.md"));
  });
  it("does not permanently inject expression samples or add a scene classifier", () => {
    for (const name of ["greeting", "gratitude", "farewell", "praised", "playful", "encourage", "concern", "comfort", "boundary"]) {
      const reference = marker(`persona-support/references/${name}.md`);
      expect(buildModePrompt("chat", load)).not.toContain(reference);
      expect(buildModePrompt("code", load)).not.toContain(reference);
    }
  });
  it.each([
    ["chat", ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"], ["firefly_harness.md", "work_system.md", "learn_system.md", "code_system.md"]],
    ["work", ["work_system.md", "work_identity.md", "soul.md", "work_remark.md", "canon_quotes_lite.md"], ["chat_system.md", "learn_system.md", "code_system.md"]],
    ["code", ["code_system.md", "code_identity.md", "soul.md", "code_remark.md", "canon_quotes_lite.md"], ["chat_system.md", "work_system.md", "learn_system.md"]],
  ] as const)("isolates %s prompt files", (mode, included, excluded) => {
    const prompt = buildModePrompt(mode, load);
    for (const file of included) expect(prompt).toContain(marker(file));
    for (const file of excluded) expect(prompt).not.toContain(marker(file));
  });

  it("limits supplied display characters to work and code modes", () => {
    for (const mode of ["chat"] as const) {
      expect(buildModePrompt(mode, load)).not.toContain("当前模式的专业 Agent");
    }
    for (const mode of ["work", "code"] as const) {
      expect(buildModePrompt(mode, load)).toContain("当前模式的专业 Agent");
      expect(buildModePrompt(mode, load)).not.toContain("黄金裔");
    }
    expect(buildModePrompt("work", load)).toContain("documents-data（知更鸟）");
    expect(buildModePrompt("code", load)).not.toContain("documents-data（知更鸟）");
    expect(buildModePrompt("work", load)).not.toMatch(/subagent_type|companion_id/);
  });
});
