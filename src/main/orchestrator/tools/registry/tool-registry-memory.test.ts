import { expect, it, describe } from "vitest";
import { toolRegistry, formatMemoryOverview, buildWriteCandidate } from "./tool-registry";

describe("memory tools exposed by the registry", () => {
  it("registers separate read and mutation capabilities with explicit-user guidance", () => {
    const reader = toolRegistry.getById("read_memory");
    const writer = toolRegistry.getById("write_memory");
    expect(reader).toBeTruthy();
    expect(writer).toBeTruthy();
    expect(reader!.effectKind).toEqual("read");
    expect(writer!.effectKind).toEqual("mutation");
    for (const instruction of ["仅限用户主动要求", "不要主动调用"]) expect(writer!.description).toContain(instruction);
  });
});

describe("memory overview visible to the model", () => {
  it("renders the exact empty three-layer overview", () => {
    expect(formatMemoryOverview({}, {}, [])).toEqual([
      "== 核心画像（L0）==", "- （空）", "", "== 近期状态（L1）==", "- （空）", "",
      "== 对话记忆（L2，共 0 条，列出最新 0 条）==", "- （空）", "", "带 id 参数可读取单条 L2 全文。",
    ].join("\n"));
  });
  it("omits blank profile fields and includes the pinned-profile explanation", () => {
    const result = formatMemoryOverview({ preferredName: "River", occupation: "", isPinned: true }, { recentGoals: "Study geometry" }, []);
    expect(result).toContain("- 称呼: River");
    expect(result).not.toContain("职业:");
    expect(result).toContain("- 近期目标: Study geometry");
    expect(result).toContain("（画像已被用户锁定，工具写入会被跳过）");
  });
  it("lists the newest conversation memory first and reports the full count", () => {
    const result = formatMemoryOverview({}, {}, [
      { id: "earlier-entry", title: "Earlier note", createdAt: Date.UTC(2025, 2, 3), status: "active" },
      { id: "later-entry", title: "Later note", createdAt: Date.UTC(2025, 2, 4), status: "active" },
    ]);
    expect(result).toContain("共 2 条");
    expect(result.split("\n").filter(line => line.startsWith("- ["))).toEqual([
      "- [later-entry] Later note · active · 2025-03-04", "- [earlier-entry] Earlier note · active · 2025-03-03",
    ]);
  });
});

describe("explicit memory write candidates", () => {
  it("normalizes the layer and trims L2 values while retaining attribution", () => {
    expect(buildWriteCandidate({
      layer: "l2", content: "  A conference is scheduled for Friday  ", slug: "  Conference  ",
      sourceQuote: " Remember the Friday conference ", triggerText: "Please keep this schedule",
    })).toEqual({
      layer: "L2", content: "A conference is scheduled for Friday", field: undefined, slug: "Conference",
      sourceQuote: "Remember the Friday conference", triggerText: "Please keep this schedule",
      confidence: 1, certainty: "explicit", attribution: "user_explicit", shouldWrite: true,
    });
  });
  it.each(["L0", "L1"])("discards L2-only metadata for %s", (layer) => {
    const candidate = buildWriteCandidate({ layer, field: "occupation", content: "Architect", slug: "discard title",
      sourceQuote: "discard quote", triggerText: "Remember my profession" });
    expect(candidate?.field).toBe("occupation");
    expect(candidate?.sourceQuote).toBeUndefined();
    expect(candidate?.slug).toBeUndefined();
  });
  it.each([{ layer: "L7", content: "A note" }, { layer: "L2", content: "   " }])("rejects unusable candidate %j", (args) => {
    expect(buildWriteCandidate({ ...args, triggerText: "Remember this" })).toBeNull();
  });
});
