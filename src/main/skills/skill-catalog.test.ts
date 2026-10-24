import { describe, expect, it, vi } from "vitest";
import {
  buildSkillCatalog as catalog, buildAutoInjectedSkillContext as instructions,
  buildAutoInjectedSoulContext as replyPolicy,
} from "./skill-catalog";
import type { SkillEntry } from "./types";

function capability(id: string, attributes: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id, description: "Prepare a careful response", name: "Response assistant",
    source: "user", enabled: true, dirPath: "/capabilities/" + id,
    bodyPath: "/capabilities/" + id + "/SKILL.md", references: [], ...attributes,
  };
}

function automatic(id: string, attributes: Partial<SkillEntry> = {}) {
  return capability(id, {
    manifest: { id, version: "3.2.0", entry: "activate.ts", dependencies: [], defaultEnabled: true, autoInject: true },
    ...attributes,
  });
}

describe("Model-facing skill selection text", () => {
  it.each([
    { entries: [] },
    { entries: [capability("archived", { enabled: false })] },
  ])("omits a catalog with no enabled entries: $entries", ({ entries }) => {
    expect(catalog(entries)).toBe("");
  });

  it("prints the complete selection procedure and ordered rows with tools before the injection notice", () => {
    const entries = [
      capability("summarize-notes", { description: "Summarize a notebook", tools: ["notes_read", "notes_outline"] }),
      capability("archived", { enabled: false }),
      automatic("conversation-tone", { description: "保持简洁", tools: ["tone_lookup"] }),
      capability("plain-policy", { description: "Use clear language" }),
    ];
    expect(catalog(entries)).toBe([
      "## Skill 选择",
      "以下 Skill 均为用户当前明确启用的能力。",
      "",
      "在选择基础工具或直接回复用户之前，必须先执行 Skill 匹配判断：",
      "",
      "1. 逐项检查下方 Skill 的 description。",
      "2. 判断该 Skill 描述的能力是否适用于完成当前用户任务。",
      "3. 如果一个或多个 Skill 适用，必须先调用 invoke_skill(skill_id) 加载对应完整规则，再继续任务。",
      "4. 不要仅因为你自己已经知道如何完成任务，就跳过适用的 Skill。",
      "5. 如果没有任何 Skill 适用，则正常使用基础工具或直接回复。",
      "",
      "Skill 清单：",
      "- summarize-notes: Summarize a notebook [tools: notes_read, notes_outline]",
      "- conversation-tone: 保持简洁 [tools: tone_lookup] [自动注入：无需再次调用 invoke_skill]",
      "- plain-policy: Use clear language",
    ].join("\n"));
    expect(catalog(entries)).not.toContain("- archived:");
  });

  it.each([{ tools: undefined }, { tools: [] }])("omits the tool annotation when tools are $tools", ({ tools }) => {
    const output = catalog([capability("reply-style", { tools, description: "Be concise" })]);
    expect(output.endsWith("- reply-style: Be concise")).toBe(true);
    expect(output).not.toContain("[tools:");
  });
});

describe("Automatic instruction assembly", () => {
  it("reads only eligible bodies and preserves their order with surrounding whitespace removed", () => {
    const read = vi.fn((id: string) => ({
      "voice-policy": "  # Voice\nRespect the user's language.\n ",
      "privacy-policy": "\nNever repeat a secret. ",
    }[id] ?? "This entry must remain unrequested"));
    const output = instructions([
      automatic("voice-policy"), capability("manual-workflow"),
      automatic("inactive-policy", { enabled: false }), automatic("privacy-policy"),
    ], read);
    expect(read.mock.calls).toEqual([["voice-policy"], ["privacy-policy"]]);
    expect(output).toBe([
      "## 自动激活 Skill 指令",
      "以下 Skill 已通过能力门控，当前对话必须直接遵循其完整规则，无需再次调用 invoke_skill。",
      "",
      "### voice-policy\n# Voice\nRespect the user's language.",
      "### privacy-policy\nNever repeat a secret.",
    ].join("\n"));
    expect(output).not.toContain("This entry must remain unrequested");
  });

  it("skips missing or blank bodies, and never reads disabled or manual skills", () => {
    const read = vi.fn((id: string) => id === "missing-body" ? null : " \n\t ");
    expect(instructions([
      automatic("inactive", { enabled: false }), capability("manual"),
      automatic("missing-body"), automatic("blank-body"),
    ], read)).toBe("");
    expect(read.mock.calls).toEqual([["missing-body"], ["blank-body"]]);
  });
});

describe("Reply-only policy extraction", () => {
  it.each(["\n## Tool workflow\nCall private_service now.", ""])(
    "extracts the complete Soul section ending with %j", (ending) => {
      const read = vi.fn(() => "# Dialogue rules\nIgnore this introduction.\n## Soul 回复策略\n先回应用户的感受。\n再简短说明下一步。\n" + ending);
      const output = replyPolicy([automatic("dialogue-policy")], read);
      expect(output).toBe([
        "## 自动激活 Skill 回复策略",
        "以下内容只约束自然语言回复；当前阶段没有工具能力，不得输出工具名、调用标记或工具协议。",
        "",
        "### dialogue-policy\n先回应用户的感受。\n再简短说明下一步。",
      ].join("\n"));
      expect(output).not.toContain("private_service");
      expect(output).not.toContain("Ignore this introduction");
    },
  );

  it("returns no policy for an absent heading, unreadable body or ineligible entry", () => {
    const read = vi.fn((id: string) => id === "unreadable" ? null : "# Generic rules");
    expect(replyPolicy([
      capability("manual"), automatic("off", { enabled: false }),
      automatic("unreadable"), automatic("no-section"),
    ], read)).toBe("");
    expect(read.mock.calls).toEqual([["unreadable"], ["no-section"]]);
  });
});
