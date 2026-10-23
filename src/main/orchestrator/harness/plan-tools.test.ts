import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlanReviewCard, buildPlanSupplementCard, executeEnterPlanMode, executeWritePlan, ENTER_PLAN_MODE_TOOL_ID, WRITE_PLAN_TOOL_ID } from "./plan-tools";
import { approvePlan, enterPlanDiscussing, getPlanPath, getPlanState, hasPlanWrittenThisRun, initPlanPaths, markPlanWritten, moveToReview, resetPlanSessionsForTest } from "../plan-mode";

let directory: string;
const manuscript = "# Workspace audit\n\n- [ ] Inventory exports\n- [ ] Verify contracts\n\n## Recovery\nRetain the last verified artifact.";
const call = (args: unknown, name: string = WRITE_PLAN_TOOL_ID) => ({ id: "plan-request-cyan", name, arguments: JSON.stringify(args) });
const context = () => ({ userQuery: "Prepare an implementation plan", conversationId: "dialog-cyan", resolvedWorkspaceRoot: directory });

beforeEach(() => {
  resetPlanSessionsForTest();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-contract-"));
  initPlanPaths(directory);
});
afterEach(() => { vi.restoreAllMocks(); resetPlanSessionsForTest(); fs.rmSync(directory, { recursive: true, force: true }); });

describe("Plan mode tool behavior", () => {
  it("enters discussion with a single event and allocates a workspace-local dated plan path", async () => {
    const emit = vi.fn();
    expect(await executeEnterPlanMode(call({}, ENTER_PLAN_MODE_TOOL_ID), context(), emit)).toMatchObject({ outcome: "success", tool: ENTER_PLAN_MODE_TOOL_ID });
    expect(getPlanState("dialog-cyan")).toEqual("PLAN_DISCUSSING");
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "plan_mode_changed", state: "PLAN_DISCUSSING" });
    const relative = path.posix.relative(directory.replace(/\\/g, "/"), getPlanPath("dialog-cyan"));
    expect(relative).toMatch(/^\.firefly\/docs\/plan-\d{8}-\d{6}\.md$/);
  });

  it.each([
    ["discussion", "已在计划模式中"], ["review", "计划待审批"], ["execution", "计划执行中"],
  ])("rejects reentry during %s without another event", async (phase, message) => {
    enterPlanDiscussing("dialog-cyan", directory);
    if (phase !== "discussion") { markPlanWritten("dialog-cyan"); expect(moveToReview("dialog-cyan")).toBe(true); }
    if (phase === "execution") approvePlan("dialog-cyan");
    const emit = vi.fn();
    expect(await executeEnterPlanMode(call({}, ENTER_PLAN_MODE_TOOL_ID), context(), emit)).toMatchObject({ outcome: "failure", category: "runtime_safety", message: expect.stringContaining(message) });
    expect(emit).not.toHaveBeenCalled();
  });

  it("uses the default conversation when no context is supplied", async () => {
    expect((await executeEnterPlanMode(call({}, ENTER_PLAN_MODE_TOOL_ID), undefined)).outcome).toEqual("success");
    expect(getPlanState("default")).toEqual("PLAN_DISCUSSING");
  });

  it("refuses plan writes outside discussion", async () => {
    expect(await executeWritePlan(call({ content: manuscript }), context())).toMatchObject({
      outcome: "failure", category: "runtime_safety", message: "write_plan 仅在计划讨论状态可用",
    });
  });

  it.each(["{}", '{"content":98}', '{"content":"  \\n\\t "}', "{broken-json", "null", "[]"])(
    "rejects invalid plan content in %s", async argumentsText => {
      enterPlanDiscussing("dialog-cyan", directory);
      expect(await executeWritePlan({ ...call({}), arguments: argumentsText }, context())).toMatchObject({
        outcome: "failure", category: "invalid_arguments", message: "content 必须是非空的计划 Markdown",
      });
    },
  );

  it("writes trimmed content, announces the real path and records that a plan was written", async () => {
    enterPlanDiscussing("dialog-cyan", directory);
    const emit = vi.fn();
    const result = await executeWritePlan(call({ content: ` \n${manuscript} \t` }), context(), emit);
    expect(result).toMatchObject({ outcome: "success", tool: WRITE_PLAN_TOOL_ID, target: expect.stringMatching(/\.firefly\/docs\/plan-\d{8}-\d{6}\.md$/) });
    expect(result.message).toContain(result.target!);
    expect(await fs.promises.readFile(getPlanPath("dialog-cyan"), "utf8")).toEqual(manuscript);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "plan_written", planPath: result.target });
    expect(hasPlanWrittenThisRun("dialog-cyan")).toEqual(true);
  });

  it.each(["node_modules\n", "node_modules\n.cache/\n"])("preserves existing ignore entries and adds metadata exclusion only once: %j", async initial => {
    fs.writeFileSync(path.join(directory, ".gitignore"), initial);
    enterPlanDiscussing("dialog-cyan", directory);
    await executeWritePlan(call({ content: manuscript }), context());
    const revised = manuscript + "\n\nAdditional acceptance criteria.";
    expect((await executeWritePlan(call({ content: revised }), context())).outcome).toEqual("success");
    const ignored = fs.readFileSync(path.join(directory, ".gitignore"), "utf8");
    expect(ignored.startsWith(initial)).toBe(true);
    expect(ignored).toContain("# Firefly agent");
    expect(ignored.match(/\.firefly\//g)).toHaveLength(1);
    if (initial.includes(".cache/")) expect(ignored.match(/\.cache\//g)).toHaveLength(1);
    expect(fs.readFileSync(getPlanPath("dialog-cyan"), "utf8")).toEqual(revised);
  });

  it("writes into the initialized profile fallback without creating a workspace ignore file", async () => {
    enterPlanDiscussing("fallback-cyan");
    const result = await executeWritePlan(call({ content: manuscript }), { userQuery: "Plan", conversationId: "fallback-cyan" });
    const expected = directory.replace(/\\/g, "/") + "/plans/fallback-cyan/plan.md";
    expect(result).toMatchObject({ outcome: "success", target: expected });
    expect(fs.readFileSync(expected, "utf8")).toEqual(manuscript);
    expect(fs.existsSync(path.join(directory, ".gitignore"))).toBe(false);
  });

  it("reports write errors without emitting success or marking the plan written", async () => {
    enterPlanDiscussing("dialog-cyan", directory);
    const write = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation((...args) => String(args[0]) === getPlanPath("dialog-cyan")
      ? Promise.reject(new Error("EACCES: fixture write refused")) : write(...args));
    const emit = vi.fn();
    expect(await executeWritePlan(call({ content: manuscript }), context(), emit)).toMatchObject({
      outcome: "failure", category: "runtime_safety", message: "计划文件写入失败：EACCES: fixture write refused",
    });
    expect(emit).not.toHaveBeenCalled();
    expect(hasPlanWrittenThisRun("dialog-cyan")).toBe(false);
  });

  it("offers the exact ordered approval choices and an independent text supplement card", () => {
    expect(buildPlanReviewCard("D:/project/.firefly/docs/plan-20261020-091500.md")).toEqual({
      mode: "semantic_clarification", intro: "计划已生成，请审阅右侧计划内容后决定", planPath: "D:/project/.firefly/docs/plan-20261020-091500.md",
      questions: [{ field: "plan_decision", question: "是否批准此计划？", type: "single_select",
        options: [{ label: "批准计划，开始执行", value: "approve" }, { label: "我要修改 / 补充", value: "supplement" }], allowCustom: false, freeTextPlaceholder: "" }],
      deferredFields: [],
    });
    const supplement = buildPlanSupplementCard();
    expect(supplement).toEqual({
      mode: "semantic_clarification", intro: "请在下方描述你想补充或修改的内容，我会更新计划后再次提交",
      questions: [{ field: "plan_supplement", question: "请描述你的补充：", type: "text", options: [], allowCustom: true, freeTextPlaceholder: "例如：第三步改成先写测试；补充一个回滚方案…" }], deferredFields: [],
    });
    expect(supplement.questions[0].freeTextPlaceholder).not.toBe("");
  });
});
