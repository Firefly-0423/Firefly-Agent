import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const mocks = vi.hoisted(() => ({
  buildModePrompt: vi.fn((mode: string) => `MODE_PROMPT:${mode}`),
}));
vi.mock("./mode-prompt-profile", () => ({ buildModePrompt: mocks.buildModePrompt }));

import {
  buildSoulSystemBasePrompt,
  buildSystemPrompt,
  buildToolSystemPrompt,
} from "./system-prompt-builder";

beforeEach(() => {
  mocks.buildModePrompt.mockClear();
});

function tool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "id">): ToolDefinition {
  return {
    description: "",
    inputSchema: {},
    ...overrides,
  } as ToolDefinition;
}

describe("buildSystemPrompt", () => {
  it.each([
    ["chat_system", "chat"],
    ["chat_identity", "chat"],
    ["talk_whatever", "chat"],
    ["work_system", "work"],
    ["code_system", "work"],
    ["soul", "work"],
    ["", "work"],
  ])("maps %j to the %s mode prompt", (name, mode) => {
    expect(buildSystemPrompt(name)).toBe(`MODE_PROMPT:${mode}`);
    expect(mocks.buildModePrompt).toHaveBeenLastCalledWith(mode);
  });

  it("matches prefixes case-sensitively", () => {
    expect(buildSystemPrompt("Chat_system")).toBe("MODE_PROMPT:work");
  });

  it("delegates the soul base prompt to the same mapping", () => {
    expect(buildSoulSystemBasePrompt("talk_identity")).toBe("MODE_PROMPT:chat");
    expect(buildSoulSystemBasePrompt("work_identity")).toBe("MODE_PROMPT:work");
  });
});

describe("buildToolSystemPrompt", () => {
  it("returns the catalog placeholder when no tools are enabled", () => {
    expect(buildToolSystemPrompt("work", [])).toBe("## 当前可用工具\n\n（当前没有可用工具）");
  });

  it("renders id, purpose and risk in input order", () => {
    const text = buildToolSystemPrompt("chat", [
      tool({ id: "alpha", description: "first line\nsecond line", risk: "safe" }),
      tool({ id: "beta", description: "ignored", catalogHint: "  hinted purpose  " }),
    ]);
    expect(text).toBe(
      [
        "## 当前可用工具",
        "- alpha\n  用途：first line\n  风险：safe\n- beta\n  用途：hinted purpose\n  风险：safe",
      ].join("\n\n"),
    );
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
  });

  it("defaults to safe and falls back to the full description", () => {
    const text = buildToolSystemPrompt("work", [tool({ id: "gamma", description: "  full description  " })]);
    expect(text).toContain("- gamma\n  用途：full description\n  风险：safe");
  });

  it("ignores the conversation mode when building the tool catalog", () => {
    const tools = [tool({ id: "one", description: "same" })];
    expect(buildToolSystemPrompt("chat", tools)).toBe(buildToolSystemPrompt("work", tools));
  });
});
