import { beforeEach, describe, it, expect, vi } from "vitest";
import { clearRecentMemoryInjections, wasRecentlyInjectedMemory } from "../memory/recent-injected-memory";

const services = vi.hoisted(() => ({
  rag: { searchMemory: vi.fn(), searchMemoryEntries: vi.fn(), updateWorldbookActivation: vi.fn(), getPermanentWorldbookEntries: vi.fn(), getActiveWorldbookEntries: vi.fn(), getCascadeWorldbookEntries: vi.fn(), INJECTION_HEADER: "WORLD_GUIDANCE", INJECTION_PREAMBLE: "REFERENCE_ONLY" },
  store: { getAllL2: vi.fn(), getL0: vi.fn(), getL1: vi.fn() },
  graph: { search: vi.fn() }, dmae: { getActiveL2ForPrompt: vi.fn() },
}));
vi.mock("../memory/l2-dmae-manager", () => ({ l2DmaeManager: services.dmae }));
vi.mock("../memory/entity-graph", () => ({ entityGraph: services.graph }));
vi.mock("../memory/memory-store", () => ({ memoryStore: services.store }));
vi.mock("../rag", () => services.rag);
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledToolsForMode: () => [], getEnabledTools: () => [] } }));

beforeEach(() => {
  vi.resetAllMocks();
  clearRecentMemoryInjections();
  services.rag.searchMemory.mockResolvedValue([]);
  services.store.getAllL2.mockResolvedValue([]);
  services.store.getL0.mockResolvedValue({});
  services.store.getL1.mockResolvedValue({});
  services.dmae.getActiveL2ForPrompt.mockResolvedValue([]);
  services.graph.search.mockReturnValue("");
  services.rag.getPermanentWorldbookEntries.mockReturnValue([]);
  services.rag.getActiveWorldbookEntries.mockReturnValue([]);
  services.rag.getCascadeWorldbookEntries.mockReturnValue([]);
});

describe("Memory text admitted to the prompt", () => {
  it("marks only active memories as injected and annotates original quotes before trigger fallbacks", async () => {
    const active = [
      { id: "memory-calendar", content: "用户习惯提前安排日程", triggerText: "我要提前安排", sourceQuote: "我会在周日安排下周日程" },
      { id: "memory-export", content: "用户偏好日历格式", triggerText: "请导出成日历格式" },
    ];
    services.store.getAllL2.mockResolvedValue(active);
    services.dmae.getActiveL2ForPrompt.mockResolvedValue(active);
    const { buildMemoryInjection } = await import("./index");
    const text = await buildMemoryInjection("下周日程");
    expect(text).toContain("用户习惯提前安排日程");
    expect(text).toContain("· 用户习惯提前安排日程（原文：我会在周日安排下周日程）");
    expect(text).toContain("· 用户偏好日历格式（原文：请导出成日历格式）");
    expect(wasRecentlyInjectedMemory("memory-calendar")).toEqual(true);
    expect(services.dmae.getActiveL2ForPrompt).toHaveBeenCalledWith(expect.any(Array), 4);
  });

  it("does not inject or mark an inactive memory", async () => {
    services.store.getAllL2.mockResolvedValue([{ id: "memory-inactive", content: "用户偏好上午", triggerText: "上午" }]);
    const { buildMemoryInjection } = await import("./index");
    expect(await buildMemoryInjection("明天")).toEqual("");
    expect(wasRecentlyInjectedMemory("memory-inactive")).toEqual(false);
  });
});

describe("Worldbook and legacy profile boundaries", () => {
  it("excludes document text from activation while allowing an explicit legacy profile request", async () => {
    const { buildAlwaysOnContext } = await import("./index");
    await buildAlwaysOnContext("整理日程\n\n【文档内容】\n附件包含世界书触发词", []);
    expect(services.rag.updateWorldbookActivation).toHaveBeenCalledWith("整理日程", "");
    services.rag.getPermanentWorldbookEntries.mockReturnValue(["日历世界设定"]);
    services.store.getL0.mockResolvedValue({ preferredName: "日程伙伴" });
    services.store.getL1.mockResolvedValue({ currentProject: "季度安排" });
    services.store.getL0.mockClear(); services.store.getL1.mockClear();
    expect(await buildAlwaysOnContext("准备日程", [])).toEqual("【常驻背景】\n日历世界设定\n\n[用户画像]\n称呼：日程伙伴\n\n[近期状态]\n当前项目：季度安排");
    expect(services.store.getL0).toHaveBeenCalledTimes(1);
    expect(services.store.getL1).toHaveBeenCalledTimes(1);
  });

  it("builds the exact worldbook text without consulting personal memory services", async () => {
    services.rag.getPermanentWorldbookEntries.mockReturnValue(["固定日历背景"]);
    services.rag.getActiveWorldbookEntries.mockReturnValue(["本轮日历背景"]);
    services.rag.getCascadeWorldbookEntries.mockReturnValue(["关联日历背景"]);
    const { buildWorldbookContext } = await import("./index");
    expect(await buildWorldbookContext("日历主题\n\n【文档内容】\n附件触发词", [{ role: "assistant", content: "已找到空闲时间" }, { role: "user", content: "日历主题" }])).toEqual("【常驻背景】\n固定日历背景\n\nWORLD_GUIDANCE\nREFERENCE_ONLY\n\n本轮日历背景\n\n关联日历背景");
    expect(services.rag.updateWorldbookActivation).toHaveBeenCalledWith("日历主题", "已找到空闲时间");
    for (const reader of [services.store.getL0, services.store.getL1, services.store.getAllL2, services.graph.search, services.dmae.getActiveL2ForPrompt]) expect(reader).not.toHaveBeenCalled();
  });

  it("reports worldbook failure without falling back to personal profiles", async () => {
    services.rag.getPermanentWorldbookEntries.mockImplementation(() => { throw new Error("Calendar worldbook unavailable"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { buildWorldbookContext } = await import("./index");
      expect(await buildWorldbookContext("准备日历", [])).toEqual("");
      expect(services.store.getL0).not.toHaveBeenCalled();
      expect(services.store.getL1).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith("[Orchestrator] worldbook dmae failed:", expect.any(Error));
    } finally { warning.mockRestore(); }
  });
});
