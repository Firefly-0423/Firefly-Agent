import { describe, expect, it, vi } from "vitest";
import { askUserToolSpec, delegateAgentToolSpec, executeAskUser, executeConfirmUncertainEffect, executeDelegateAgent, executeUpdateTodo, formatAskUserPreview, getHarnessBuiltinToolSpecs, updateTodoToolSpec } from "./builtin-tools";
import type { AgentState } from "./types";

const invocation = (name: string, args: unknown) => ({ id: "builtin-request-jade", name, arguments: JSON.stringify(args) });
const pendingState = (): AgentState => ({ todoItems: [], uncertainEffects: [{
  id: "effect-jade", toolCallId: "previous-send-jade", fingerprint: "effect-digest-jade", toolName: "send_email", message: "Acknowledgement missing",
}] });
const questions = () => [
  { id: "delivery", question: "选择交付方式？", type: "single_select" as const, options: [{ label: "网页", value: "web" }, { label: "文档", value: "document" }] },
  { id: "chapters", question: "包含哪些章节？", type: "multi_select" as const, options: [{ label: "结论", value: "findings" }, { label: "证据", value: "evidence" }] },
  { id: "instruction", question: "补充要求？", type: "text" as const },
];

describe("Builtin tool contracts visible to the model", () => {
  it("lists only notebook and result-reader tools when interaction or delegation is unavailable", () => {
    for (const options of [{ includeInteractive: false }, { includeInteractive: false, includeAgent: false }]) {
      expect(getHarnessBuiltinToolSpecs(options).map(spec => spec.name)).toEqual(["update_todo", "read_tool_result"]);
    }
  });

  it("advertises bounded question types and mutable notebook guidance", () => {
    const definition = (askUserToolSpec.parameters as { properties: { questions: unknown } }).properties.questions;
    expect(definition).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
    for (const type of ["single_select", "multi_select", "text"]) expect(JSON.stringify(definition)).toContain(type);
    expect(askUserToolSpec.description).toContain("不要用最终回复向用户提问");
    for (const phrase of ["至少 2 个 execution step", "tool round", "可变工作笔记", "单次工具即可完成", "改变方向"]) expect(updateTodoToolSpec.description).toContain(phrase);
  });

  it("delegates only the exact agent and prompt fields without exposing prompt text in the preview", async () => {
    const execute = vi.fn(async () => ({ agentId: "auditor", sessionId: "child-jade", status: "completed" as const, text: "Audit evidence collected." }));
    const response = await executeDelegateAgent(invocation("delegate_agent", { agent_id: "auditor", prompt: "Inspect durable event order" }), execute);
    expect(delegateAgentToolSpec.name).toEqual("delegate_agent");
    expect(Object.keys(delegateAgentToolSpec.parameters.properties)).toEqual(["agent_id", "prompt"]);
    expect(delegateAgentToolSpec.parameters.required).not.toContain("companion_id");
    expect(delegateAgentToolSpec.description).not.toContain("黄金裔");
    expect(execute).toHaveBeenCalledExactlyOnceWith({ agentId: "auditor", prompt: "Inspect durable event order" });
    expect(response.output).toContain("child-jade");
    expect(response.message).not.toContain("Inspect durable");
    expect(response.message).not.toContain("Inspect durable event order");
  });

  it.each([{ agent_id: "auditor", prompt: "Inspect", companion_id: "Unknown display" }, { agent_id: "auditor", prompt: "" }])(
    "rejects invalid delegation before invoking the executor: %j", async args => {
      const execute = vi.fn();
      expect(await executeDelegateAgent(invocation("delegate_agent", args), execute)).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "four questions", list: Array.from({ length: 4 }, (_, index) => ({ id: `query-${index}`, question: "Additional requirement?", type: "text" })) },
    { label: "one single-select option", list: [{ ...questions()[0], options: [{ label: "Only choice", value: "only" }] }] },
    { label: "text with selection options", list: [{ ...questions()[2], options: [{ label: "First", value: "first" }, { label: "Second", value: "second" }] }] },
    { label: "an option without a label", list: [{ ...questions()[0], options: [{ label: "", value: "web" }, { label: "文档", value: "document" }] }] },
    { label: "repeated option values", list: [{ ...questions()[0], options: [{ label: "网页", value: "same" }, { label: "文档", value: "same" }] }] },
  ])("rejects $label before opening a card", async ({ list }) => {
    const request = vi.fn();
    expect(await executeAskUser(invocation("ask_user", { questions: list }), request)).toMatchObject({ outcome: "failure", category: "invalid_arguments", tool: "ask_user" });
    expect(request).not.toHaveBeenCalled();
  });

  it("numbers options the model left without a value instead of refusing the card", async () => {
    const request = vi.fn(async () => ({ answers: [{ field: "next", selectedValues: ["option-2"] }] }));
    const response = await executeAskUser(invocation("ask_user", { questions: [{ id: "next", question: "接下来怎么做？", type: "single_select",
      options: [{ label: "重新委托", description: "代价很小" }, { label: "先试一位" }] }] }), request);
    expect(request.mock.calls[0]).toEqual([expect.objectContaining({ questions: [expect.objectContaining({ options: [
      expect.objectContaining({ label: "重新委托", value: "option-1" }), expect.objectContaining({ label: "先试一位", value: "option-2" }),
    ] })] })]);
    expect(JSON.parse(response.output!)).toEqual({ answers: [{ questionId: "next", selectedValues: ["option-2"], selectedLabels: ["先试一位"] }] });
  });

  it("maps single, multiple and custom answers back in question order", async () => {
    const request = vi.fn(async () => ({ answers: [
      { field: "delivery", selectedValues: ["web"] }, { field: "chapters", selectedValues: ["findings", "evidence"] }, { field: "instruction", customText: "结束当前调查" },
    ] }));
    const response = await executeAskUser(invocation("ask_user", { questions: questions() }), request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([expect.objectContaining({ questions: [
      expect.objectContaining({ field: "delivery", type: "single_select", allowCustom: true }),
      expect.objectContaining({ field: "chapters", type: "multi_select", allowCustom: true }),
      expect.objectContaining({ field: "instruction", type: "text", allowCustom: true }),
    ] })]);
    expect(response).toMatchObject({ outcome: "success", tool: "ask_user" });
    expect(JSON.parse(response.output!)).toEqual({ answers: [
      { questionId: "delivery", selectedValues: ["web"], selectedLabels: ["网页"] },
      { questionId: "chapters", selectedValues: ["findings", "evidence"], selectedLabels: ["结论", "证据"] },
      { questionId: "instruction", customInput: "结束当前调查" },
    ] });
  });

  it("returns an explicit system timeout notice for empty answers", async () => {
    const response = await executeAskUser(invocation("ask_user", { questions: [questions()[2]] }), async () => ({ answers: [] }));
    expect(response).toMatchObject({ outcome: "success", tool: "ask_user", message: expect.stringContaining("系统提示：用户未在时限内回答问题") });
  });

  it("formats answer labels and custom text in order, marking omissions and preserving failure messages", () => {
    const parsed = { questions: questions().map(q => ({ ...q, options: q.options ?? [] })) };
    const observation = { outcome: "success" as const, tool: "ask_user", message: "Answered", output: JSON.stringify({ answers: [
      { questionId: "delivery", selectedValues: ["web"], selectedLabels: ["网页"] },
      { questionId: "chapters", selectedLabels: ["结论", "证据"] }, { questionId: "instruction", customInput: "先验证再交付" },
    ] }) };
    expect(formatAskUserPreview(parsed, observation)).toEqual(["选择交付方式？ → 网页", "包含哪些章节？ → 结论、证据", "补充要求？ → 先验证再交付"]);
    expect(formatAskUserPreview({ questions: [parsed.questions[0]] }, { ...observation, output: '{"answers":[]}' })).toEqual(["选择交付方式？ → 未回答"]);
    expect(formatAskUserPreview(parsed, { outcome: "failure", tool: "ask_user", message: "用户回答超时或失败：连接中断" })).toBe("用户回答超时或失败：连接中断");
  });

  it("accepts batch completion but corrects attempts to revive terminal todos", async () => {
    const state: AgentState = { todoItems: ["scan", "verify", "report"].map(id => ({ id, content: id, status: "pending" })), uncertainEffects: [] };
    const complete = state.todoItems.map(item => ({ ...item, status: "completed" }));
    const response = await executeUpdateTodo(invocation("update_todo", { todos: complete }), state);
    expect(response.outcome).toEqual("success");
    expect(state.todoItems.map(item => item.status)).toEqual(["completed", "completed", "completed"]);
    expect(response.message).toContain("所有 invariant 检查通过");
    const revised = await executeUpdateTodo(invocation("update_todo", { todos: [{ ...complete[0], status: "pending" }] }), state);
    expect(revised.outcome).toEqual("success");
    expect(state.todoItems[0].status).toEqual("completed");
    expect(revised.message).toContain("非法状态转移");
  });

  it("propagates cancellation from the clarification channel", async () => {
    const aborted = Object.assign(new Error("User stopped this run"), { name: "AbortError" });
    await expect(executeAskUser(invocation("ask_user", { questions: [questions()[0]] }), async () => { throw aborted; })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses runtime-owned ordered confirmation choices and clears only an authorized effect", async () => {
    const state = pendingState();
    const request = vi.fn(async () => ({ answers: [{ field: "decision", selectedValues: ["allow_repeat"] }] }));
    const response = await executeConfirmUncertainEffect(invocation("confirm_uncertain_effect", { effectId: "effect-jade", ignoredModelText: "Unsafe model suggestion" }), state, request);
    expect(request.mock.calls[0]).toEqual([expect.objectContaining({ questions: [
      expect.objectContaining({ field: "decision", allowCustom: false, options: [
        { value: "allow_repeat", label: "仍然允许一次" }, { value: "do_not_repeat", label: "不要重复执行" },
      ] }),
    ] })]);
    expect(response.outcome).toEqual("success");
    expect(state.uncertainEffects).toEqual([]);
  });

  it("keeps denied effects unresolved without granting repeat authorization", async () => {
    const state = pendingState();
    const response = await executeConfirmUncertainEffect(invocation("confirm_uncertain_effect", { effectId: "effect-jade" }), state, async () => ({ answers: [{ field: "decision", selectedValues: ["do_not_repeat"] }] }));
    expect(response.outcome).toEqual("success");
    expect(state.uncertainEffects).toHaveLength(1);
    expect(state.uncertainEffects[0].repeatAuthorization).toBeUndefined();
  });
});
