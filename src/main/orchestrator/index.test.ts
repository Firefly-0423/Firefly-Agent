import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ updateWorldbookActivation: vi.fn(), getPermanentWorldbookEntries: vi.fn(), getActiveWorldbookEntries: vi.fn(), getCascadeWorldbookEntries: vi.fn(), searchMemory: vi.fn(), getL0: vi.fn(), getL1: vi.fn(), getAllL2: vi.fn(), search: vi.fn(), record: vi.fn(), getActiveL2ForPrompt: vi.fn() }));
vi.mock("../rag", () => ({ ...deps, INJECTION_HEADER: "header", INJECTION_PREAMBLE: "preamble" }));
vi.mock("../memory/memory-store", () => ({ memoryStore: deps }));
vi.mock("../memory/entity-graph", () => ({ entityGraph: { search: deps.search } }));
vi.mock("../memory/recent-injected-memory", () => ({ recordRecentMemoryInjection: deps.record }));
vi.mock("../memory/l2-dmae-manager", () => ({ l2DmaeManager: deps }));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: () => [] } }));
vi.mock("./context-builder", () => ({ scheduleMemoryWrite: vi.fn() }));
vi.mock("./tone-injector", () => ({ buildToneInjection: vi.fn() }));
import { buildAlwaysOnContext, buildMemoryInjection, buildWorldbookContext } from "./index";
beforeEach(() => { vi.resetAllMocks(); for (const fn of [deps.getPermanentWorldbookEntries, deps.getActiveWorldbookEntries, deps.getCascadeWorldbookEntries]) fn.mockReturnValue([]); deps.searchMemory.mockResolvedValue([]); deps.getAllL2.mockResolvedValue([]); deps.getActiveL2ForPrompt.mockResolvedValue([]); deps.getL0.mockResolvedValue({}); deps.getL1.mockResolvedValue({}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
it("returns empty context for empty sources and records an empty injection", async () => { expect(await buildMemoryInjection("query")).toBe(""); expect(deps.record).toHaveBeenCalledWith([]); expect(deps.searchMemory).toHaveBeenCalledWith("query", "imported_doc", 2); });
it("orders memories, documents and relationships and annotates conflicts/quotes", async () => {
  deps.getActiveL2ForPrompt.mockResolvedValue([{ id: "a", content: "fact", sourceQuote: "source", conflictWith: ["old"] }, { id: "b", content: "fallback", triggerText: "trigger" }, { id: "c", content: "plain" }]); deps.searchMemory.mockResolvedValue(["doc1", "doc2"]); deps.search.mockReturnValue("relation");
  expect(await buildMemoryInjection("query")).toBe("【相关记忆】\n· fact ⚠️（该信息可能存在矛盾记录）（原文：source）\n· fallback（原文：trigger）\n· plain\n\n【相关文档】\n· doc1\n· doc2\n\n【人物关系】\nrelation"); expect(deps.record).toHaveBeenCalledWith(["a", "b", "c"]);
});
it.each([false, true])("isolates retrieval errors and surfaces dimension mismatch=%s", async mismatch => {
  const error = Error(mismatch ? "Dimension mismatch" : "offline"); deps.getAllL2.mockRejectedValue(error); deps.searchMemory.mockRejectedValue(error); deps.search.mockImplementation(() => { throw error; });
  const result = await buildMemoryInjection("query"); if (mismatch) { expect(result).toContain("【记忆系统】"); expect(result).toContain("【文档检索】"); } else expect(result).toBe("");
});
it.each(["【本轮文件】", "【文档内容】", "【图片视觉信息】", "【图片附件】"])("excludes appended %s context from activation", async marker => {
  await buildWorldbookContext(`  query ${marker} appended 【本轮文件】 later`, [{ role: "assistant", content: "old" }, { role: "user", content: "u" }, { role: "assistant", content: "latest" }]); expect(deps.updateWorldbookActivation).toHaveBeenCalledWith("query", "latest"); expect(deps.getL0).not.toHaveBeenCalled();
});
it.each([[[], []], [["active"], []], [[], ["cascade"]], [["active"], ["cascade"]]])("builds worldbook sections for active=%j cascade=%j", async (active, cascade) => {
  deps.getPermanentWorldbookEntries.mockReturnValue(["permanent"]); deps.getActiveWorldbookEntries.mockReturnValue(active); deps.getCascadeWorldbookEntries.mockReturnValue(cascade);
  const expected = "【常驻背景】\npermanent" + (active.length || cascade.length ? "\n\nheader\npreamble\n\n" + [...active, ...cascade].join("\n\n") : "");
  expect(await buildWorldbookContext(" query ", [])).toBe(expected); expect(deps.updateWorldbookActivation).toHaveBeenCalledWith("query", "");
});
it("preserves permanent background when activation fails", async () => {
  deps.getPermanentWorldbookEntries.mockReturnValue(["permanent"]); deps.updateWorldbookActivation.mockImplementation(() => { throw Error("activation"); }); expect(await buildWorldbookContext("", [])).toBe("【常驻背景】\npermanent");
});
it("formats all legacy profile fields after background", async () => {
  deps.getPermanentWorldbookEntries.mockReturnValue(["background"]); deps.getL0.mockResolvedValue({ preferredName: "N", occupation: "O", longTermInterests: "I", language: "L", permanentNote: "P" }); deps.getL1.mockResolvedValue({ recentGoals: "G", recentPreferences: "R", currentProject: "C" });
  expect(await buildAlwaysOnContext("", [])).toBe("【常驻背景】\nbackground\n\n[用户画像]\n称呼：N\n职业：O\n长期兴趣：I\n常用语言：L\n备注：P\n\n[近期状态]\n最近目标：G\n近期偏好：R\n当前项目：C");
});
it("omits empty profile sections and tolerates profile errors", async () => {
  expect(await buildAlwaysOnContext("", [])).toBe(""); deps.getL0.mockRejectedValue(Error("store")); expect(await buildAlwaysOnContext("", [])).toBe("");
});
