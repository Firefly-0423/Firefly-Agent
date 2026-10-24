import { expect, test } from "vitest";
import { buildAskSubmission, createAskDrafts, describePermissionRequest, describeRunStage, isAskComplete,
  normalizeChoiceInteraction, normalizeDeferredPlanChoice, normalizePopQuizCard, normalizeTaskPlanPresentation,
  resolveComposerSlot, selectAskOption, shouldDismissAsk, updateAskCustomText } from "./run-presentation";

const choices = [{ id: "html", label: "网页" }, { id: "text", label: "纯文本" }];
const publicCard = () => ({
  interactionId: "format-question", runId: "report-run", revision: 6, mode: "semantic_clarification",
  intro: "选择交付形式", questions: [{ id: "format", prompt: "交付格式？", required: true, multiple: false,
    options: choices, customInput: { enabled: true, placeholder: "输入自定义格式" } }],
});

test("normalizes public, legacy and structured questions into their respective response contracts", () => {
  const expectedOptions = choices.map(option => ({ ...option, description: undefined }));
  const interaction = normalizeChoiceInteraction(publicCard())!;
  expect(interaction).toStrictEqual({
    kind: "ask", id: "format-question", runId: "report-run", revision: 6, intro: "选择交付形式",
    responseKind: "submission", question: "交付格式？", options: expectedOptions,
    questions: [{ id: "format", question: "交付格式？", options: expectedOptions,
      allowCustomInput: true, freeTextPlaceholder: "输入自定义格式", multiple: false }],
  });
  expect(resolveComposerSlot(interaction)).toBe("ask");
  expect(normalizeChoiceInteraction({ id: "legacy-format", question: "交付格式？",
    options: [{ value: "html", label: "网页", description: "可在线阅读" }] })).toMatchObject({
    kind: "ask", id: "legacy-format", responseKind: "choice", options: [{ id: "html", label: "网页" }],
  });
  expect(normalizeChoiceInteraction({ id: "structured-format", questions: [{
    field: "delivery", question: "交付格式？", type: "single_select", allowCustom: false,
    freeTextPlaceholder: "", options: [{ value: "text", label: "纯文本" }],
  }] })).toMatchObject({ kind: "ask", id: "structured-format", responseKind: "clarification",
    questions: [{ id: "delivery", options: [{ id: "text", label: "纯文本" }] }] });
  expect(resolveComposerSlot(undefined)).toBe("composer");
  expect(resolveComposerSlot({ kind: "permission", id: "report-access", toolName: "write_word", summary: "生成报告" })).toBe("permission");
});

test.each([
  ["understanding", "流萤正在理解需求…"], ["planning", "流萤正在规划任务…"],
  ["waiting_permission", "流萤正在获取审批…"], ["waiting_user", "流萤正在询问…"], ["responding", "流萤正在组织回复…"],
] as const)("keeps %s stage text user-facing", (kind, expected) => expect(describeRunStage({ kind })).toBe(expected));

test("describes executable actions using the relevant argument and exact display wording", () => {
  const requests = [
    { toolId: "weather", toolName: "天气工具", args: { city: "杭州" }, output: "查询杭州天气" },
    { toolId: "web_search", toolName: "搜索工具", args: { query: "桌面应用设计" }, output: "搜索“桌面应用设计”" },
    { toolId: "write_word", toolName: "文档工具", args: { filename: "周报.docx" }, output: "创建 Word 文档：周报.docx" },
    { toolId: "custom_step", toolName: "归档资料", args: {}, output: "执行「归档资料」" },
  ];
  for (const request of requests) expect(describePermissionRequest(request)).toBe(request.output);
  expect(describeRunStage({ kind: "executing", detail: "查询杭州天气" })).toBe("流萤正在执行：查询杭州天气…");
});

test("routes a deferred approval only to the session which owns the card", () => {
  const card = { ...publicCard(), sessionId: "report-session" };
  expect(normalizeDeferredPlanChoice(card, "report-session")).toMatchObject({ kind: "ask", id: "format-question", question: "交付格式？" });
  expect(normalizeDeferredPlanChoice(card, "another-session")).toBeUndefined();
  expect(normalizeDeferredPlanChoice({ ...card, sessionId: undefined }, "report-session")).toBeUndefined();
});

test.each([true, false])("supports text-only and fixed-choice cards; textOnly=%s", (textOnly) => {
  const card = publicCard();
  card.questions[0].options = textOnly ? [] : choices;
  card.questions[0].customInput.enabled = textOnly;
  expect(normalizeChoiceInteraction(card)).toMatchObject({
    id: "format-question", kind: "ask", responseKind: "submission",
    questions: [{ id: "format", options: textOnly ? [] : choices, allowCustomInput: textOnly, multiple: false }],
  });
});

test("collects out-of-order drafts with exclusive custom/option answers and emits question order", () => {
  const card = publicCard();
  card.questions.push({ ...card.questions[0], id: "tone", prompt: "表达方式？" });
  const interaction = normalizeChoiceInteraction(card)!;
  const questions = interaction.questions!;
  let drafts = createAskDrafts(questions);
  drafts = updateAskCustomText(drafts, "tone", "  简洁一些  ");
  expect(isAskComplete(questions, drafts)).toBe(false);
  expect(() => buildAskSubmission(interaction, drafts)).toThrow("E_ASK_SUBMISSION_INCOMPLETE");
  drafts = selectAskOption(drafts, questions[0], "html");
  drafts = selectAskOption(drafts, questions[1], "text");
  expect(drafts.tone).toStrictEqual({ source: "option", optionIds: ["text"], customText: "" });
  expect(isAskComplete(questions, drafts)).toBe(true);
  drafts = updateAskCustomText(drafts, "tone", "  简洁一些  ");
  expect(drafts.tone).toStrictEqual({ source: "custom", optionIds: [], customText: "  简洁一些  " });
  expect(buildAskSubmission(interaction, drafts)).toStrictEqual({
    interactionId: "format-question", runId: "report-run", revision: 6,
    answers: [{ questionId: "format", source: "option", optionId: "html" },
      { questionId: "tone", source: "custom", text: "简洁一些" }],
  });
});

test("dismisses only the matching interaction, run and revision", () => {
  const interaction = normalizeChoiceInteraction(publicCard())!;
  const event = { id: interaction.id, runId: interaction.runId, revision: interaction.revision, reason: "timeout" };
  expect(shouldDismissAsk(interaction, event)).toBe(true);
  for (const change of [{ runId: "obsolete-run" }, { revision: 5 }, { id: "obsolete-card" }]) {
    expect(shouldDismissAsk(interaction, { ...event, ...change })).toBe(false);
  }
});

test("translates a plan snapshot without losing steps or their ordering", () => {
  expect(normalizeTaskPlanPresentation({ goal: "交付资料", steps: [
    { stepId: "gather", objective: "收集资料", status: "completed" },
    { stepId: "compose", objective: "编写报告", status: "running" },
    { stepId: "archive", objective: "归档旧稿", status: "superseded" },
  ] })).toStrictEqual({ title: "交付资料", steps: [
    { id: "gather", title: "收集资料", status: "completed" }, { id: "compose", title: "编写报告", status: "running" },
    { id: "archive", title: "归档旧稿", status: "pending" },
  ] });
});

const quiz = () => ({
  quizId: "review-quiz", runId: "study-run", intro: "检查理解",
  questions: [
    { id: "sum", type: "choice", question: "2 + 3 等于多少？", options: [{ id: "five", label: "5" }, { id: "six", label: "6" }], learningObjective: "整数加法" },
    { id: "explain", type: "short_answer", question: "解释计算过程", options: [], learningObjective: "描述思路" },
  ],
});
test("preserves quiz questions and opens the quiz composer slot", () => {
  const card = quiz();
  const interaction = normalizePopQuizCard(card);
  expect(interaction).toStrictEqual({ kind: "quiz", id: card.quizId, runId: card.runId, intro: card.intro, questions: card.questions });
  expect(resolveComposerSlot(interaction)).toBe("quiz");
  expect(normalizePopQuizCard({ ...card, questions: [{ id: "truth", type: "true_false", question: "3 > 2", options: [], learningObjective: "" }] })).toBeDefined();
});

test("rejects malformed quiz cards as a whole instead of silently dropping questions", () => {
  const card = quiz();
  const badQuestion = { ...card.questions[0], question: "", options: [] };
  for (const invalid of [{ ...card, quizId: "" }, { ...card, runId: "" }, { ...card, questions: "wrong" },
    { ...card, questions: [{ ...card.questions[0], type: "fill_blank" }] },
    { ...card, questions: [{ ...card.questions[0], options: [card.questions[0].options[0]] }] },
    { ...card, questions: [card.questions[0], badQuestion] }]) expect(normalizePopQuizCard(invalid)).toBeUndefined();
});
