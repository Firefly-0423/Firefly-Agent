import { BrowserWindow } from "electron";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { createAbortError } from "../utils/abort-utils";
import { toastEvents } from "../toast/toast-events";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolContext } from "./tools/registry/tool-context";
import type {
  PopQuizCard,
  PopQuizGradedQuestion,
  PopQuizResolveResponse,
  PopQuizSubmission,
  PopQuizToolResult,
  PopQuizSettledPayload,
  QuizAnswerResult,
  QuizQuestionInput,
} from "../../shared/pop-quiz";

interface PrivateQuizQuestion {
  correctAnswer?: number | number[] | boolean;
  optionIndex: Map<string, number>;
  explanation: string;
  learningObjective: string;
  type: QuizQuestionInput["type"];
  questionId: string;
}
export interface PopQuizPublication { privateQuestions: PrivateQuizQuestion[]; card: PopQuizCard }

function parseSourceRef(value: unknown): { file: string; heading?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const file = typeof fields.file === "string" ? fields.file.trim() : "";
  if (!file) return undefined;
  const heading = typeof fields.heading === "string" && fields.heading.trim() ? fields.heading.trim() : undefined;
  return heading ? { file, heading } : { file };
}
function parseQuizQuestion(candidate: unknown, index: number): { question?: QuizQuestionInput; error?: string } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { error: `第 ${index + 1} 题必须是对象` };
  const fields = candidate as Record<string, unknown>;
  const text = typeof fields.question === "string" ? fields.question.trim() : "";
  const objective = typeof fields.learningObjective === "string" ? fields.learningObjective.trim() : "";
  const explanation = typeof fields.explanation === "string" ? fields.explanation.trim() : "";
  if (!text) return { error: `第 ${index + 1} 题的 question 不能为空` };
  if (!objective) return { error: `第 ${index + 1} 题必须声明 learningObjective（本题测的知识点）` };
  const source = parseSourceRef(fields.sourceRef);
  const common = { question: text, learningObjective: objective, explanation, ...(source ? { sourceRef: source } : {}) };
  const parseChoices = (): { options?: string[]; error?: string } => {
    if (!Array.isArray(fields.options) || fields.options.length === 0) return { error: `第 ${index + 1} 题的 options 必须是选项文本数组，如 ["选项一", "选项二"]` };
    const choices: string[] = [];
    for (const option of fields.options) {
      const label = typeof option === "string" ? option.trim() : option && typeof option === "object" && !Array.isArray(option)
        ? String((option as Record<string, unknown>).label ?? (option as Record<string, unknown>).text ?? (option as Record<string, unknown>).value ?? "").trim() : "";
      if (!label) return { error: `第 ${index + 1} 题的选项不能为空；options 必须是纯文本数组（如 ["选项一", "选项二"]），不要传对象` };
      choices.push(label);
    }
    if (choices.length < 2 || choices.length > 6) return { error: `第 ${index + 1} 题的选项数量必须在 2-6 之间` };
    return { options: choices };
  };
  const toIndex = (value: unknown): number | undefined => {
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
  };
  switch (fields.type) {
    case "choice": {
      const choices = parseChoices();
      if (choices.error || !choices.options) return { error: choices.error };
      const correct = toIndex(fields.correctIndex);
      if (correct === undefined || correct >= choices.options.length) return { error: `第 ${index + 1} 题 correctIndex 必须是有效选项下标（0 到 ${choices.options.length - 1} 的数字）` };
      return { question: { type: "choice", ...common, options: choices.options, correctIndex: correct } };
    }
    case "multi": {
      const choices = parseChoices();
      if (choices.error || !choices.options) return { error: choices.error };
      if (!Array.isArray(fields.correctIndexes) || fields.correctIndexes.length === 0) return { error: `第 ${index + 1} 题 correctIndexes 必须是非空数组` };
      const selected = new Set<number>();
      for (const raw of fields.correctIndexes) {
        const offset = toIndex(raw);
        if (offset === undefined || offset >= choices.options.length || selected.has(offset)) return { error: `第 ${index + 1} 题 correctIndexes 含无效或重复下标（必须是 0 到 ${choices.options.length - 1} 的数字）` };
        selected.add(offset);
      }
      return { question: { type: "multi", ...common, options: choices.options, correctIndexes: [...selected].sort((a, b) => a - b) } };
    }
    case "true_false": {
      const raw = fields.correct;
      const answer = typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : undefined;
      if (answer === undefined) return { error: `第 ${index + 1} 题 correct 必须是 boolean（true/false）` };
      return { question: { type: "true_false", ...common, correct: answer } };
    }
    case "short_answer": {
      const reference = typeof fields.referenceAnswer === "string" ? fields.referenceAnswer.trim() : "";
      if (!reference) return { error: `第 ${index + 1} 题必须提供 referenceAnswer 评分参考` };
      const raw = Array.isArray(fields.rubric) ? fields.rubric : typeof fields.rubric === "string" && fields.rubric.trim() ? [fields.rubric] : undefined;
      if (!raw) return { error: `第 ${index + 1} 题的 rubric 必须是数组（给分要点）` };
      const rubric = raw.map((point) => String(point ?? "").trim()).filter(Boolean);
      return { question: { type: "short_answer", ...common, referenceAnswer: reference, rubric } };
    }
    default: return { error: `第 ${index + 1} 题 type 必须是 choice / multi / true_false / short_answer` };
  }
}
export function parseQuizInput(raw: unknown): { questions?: QuizQuestionInput[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return { error: "questions 必须是包含 1-3 题的数组" };
  const parsedQuestions: QuizQuestionInput[] = [];
  for (const [position, item] of raw.entries()) {
    const parsed = parseQuizQuestion(item, position);
    if (parsed.error || !parsed.question) return { error: parsed.error };
    parsedQuestions.push(parsed.question);
  }
  return { questions: parsedQuestions };
}

export function buildPopQuizPublication(questions: QuizQuestionInput[], identity: { runId: string; quizId: string }): PopQuizPublication {
  const hidden: PrivateQuizQuestion[] = [];
  const visible: PopQuizCard["questions"] = questions.map((item, position) => {
    const id = `q${position + 1}`;
    const indexes = new Map<string, number>();
    const choices = item.type === "choice" || item.type === "multi" ? item.options.map((label, offset) => {
      const key = `${id}-opt-${offset + 1}`;
      indexes.set(key, offset);
      return { id: key, label };
    }) : [];
    const correct = item.type === "choice" ? item.correctIndex : item.type === "multi" ? [...item.correctIndexes].sort((a, b) => a - b) : item.type === "true_false" ? item.correct : undefined;
    hidden.push({ questionId: id, type: item.type, learningObjective: item.learningObjective, explanation: item.explanation, optionIndex: indexes, ...(correct !== undefined ? { correctAnswer: correct } : {}) });
    return { id, type: item.type, question: item.question, options: choices, learningObjective: item.learningObjective };
  });
  return { card: { quizId: identity.quizId, runId: identity.runId, intro: "突击抽查：答完这几题，看看刚才的内容掌握了没有。", questions: visible }, privateQuestions: hidden };
}
export function gradeQuizSubmission(publication: PopQuizPublication, submission: PopQuizSubmission): { results?: QuizAnswerResult[]; graded?: PopQuizGradedQuestion[]; error?: string } {
  const definitions = new Map(publication.privateQuestions.map((item) => [item.questionId, item]));
  if (!Array.isArray(submission.answers) || submission.answers.length !== publication.privateQuestions.length) return { error: "E_QUIZ_ANSWER_INCOMPLETE" };
  const visited = new Set<string>();
  for (const response of submission.answers) {
    if (!response || typeof response !== "object") return { error: "E_QUIZ_ANSWER_INVALID" };
    const id = response.questionId;
    if (typeof id !== "string" || visited.has(id)) return { error: "E_QUIZ_ANSWER_INVALID" };
    visited.add(id);
    if (!definitions.has(id)) return { error: "E_QUIZ_ANSWER_INVALID" };
  }
  const results: QuizAnswerResult[] = [], graded: PopQuizGradedQuestion[] = [];
  for (const definition of publication.privateQuestions) {
    const response = submission.answers.find((item) => item.questionId === definition.questionId);
    if (definition.type === "choice") {
      const selected = response?.optionId;
      if (typeof selected !== "string" || !definition.optionIndex.has(selected)) return { error: "E_QUIZ_ANSWER_INVALID" };
      const offset = definition.optionIndex.get(selected)!;
      const correct = offset === definition.correctAnswer;
      results.push({ questionId: definition.questionId, learningObjective: definition.learningObjective, userAnswer: offset, correctAnswer: definition.correctAnswer, grading: correct ? "correct" : "incorrect" });
    } else if (definition.type === "multi") {
      const selections = response?.optionIds;
      if (!Array.isArray(selections) || selections.length === 0) return { error: "E_QUIZ_ANSWER_INVALID" };
      const used = new Set<string>();
      const offsets: number[] = [];
      for (const selected of selections) {
        if (typeof selected !== "string" || !definition.optionIndex.has(selected) || used.has(selected)) return { error: "E_QUIZ_ANSWER_INVALID" };
        used.add(selected);
        offsets.push(definition.optionIndex.get(selected)!);
      }
      offsets.sort((a, b) => a - b);
      const expected = definition.correctAnswer as number[];
      const correct = offsets.length === expected.length && offsets.every((offset, position) => offset === expected[position]);
      results.push({ questionId: definition.questionId, learningObjective: definition.learningObjective, userAnswer: offsets, correctAnswer: expected, grading: correct ? "correct" : "incorrect" });
    } else if (definition.type === "true_false") {
      if (typeof response?.boolean !== "boolean") return { error: "E_QUIZ_ANSWER_INVALID" };
      const correct = response.boolean === definition.correctAnswer;
      results.push({ questionId: definition.questionId, learningObjective: definition.learningObjective, userAnswer: response.boolean, correctAnswer: definition.correctAnswer, grading: correct ? "correct" : "incorrect" });
    } else {
      const typed = response?.text;
      if (typeof typed !== "string" || !typed.trim()) return { error: "E_QUIZ_ANSWER_INVALID" };
      results.push({ questionId: definition.questionId, learningObjective: definition.learningObjective, userAnswer: typed.trim(), grading: "pending_model" });
    }
    const last = results[results.length - 1];
    graded.push({ questionId: definition.questionId, grading: last.grading, ...(last.correctAnswer !== undefined ? { correctAnswer: last.correctAnswer } : {}), explanation: definition.explanation });
  }
  return { results, graded };
}

interface PendingQuiz {
  runId: string; rebroadcastTimer: NodeJS.Timeout; reject: (err: Error) => void;
  resolve: (result: PopQuizToolResult) => void; publication: PopQuizPublication;
}
const awaiting = new Map<string, PendingQuiz>();
let sequence = 0;
const evidence = new Map<string, QuizAnswerResult[]>();
function broadcastToAllWindows(channel: string, payload: unknown): void { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload); }
export function takeQuizEvidenceForRun(runId: string): QuizAnswerResult[] { const taken = evidence.get(runId); evidence.delete(runId); return taken ?? []; }
function settlePendingQuiz(quizId: string, reason: PopQuizSettledPayload["reason"], settle: (pending: PendingQuiz) => void): void {
  const pending = awaiting.get(quizId);
  if (!pending) return;
  clearInterval(pending.rebroadcastTimer);
  awaiting.delete(quizId);
  broadcastToAllWindows(IPC.POP_QUIZ_SETTLED, { quizId, runId: pending.runId, reason } satisfies PopQuizSettledPayload);
  toastEvents.publishQuizSettled({ quizId, runId: pending.runId, reason });
  settle(pending);
}
export function requestPopQuiz(questions: QuizQuestionInput[], identity: { runId: string }): Promise<PopQuizToolResult> {
  return new Promise((complete, fail) => {
    if (BrowserWindow.getAllWindows().length === 0) { fail(new Error("E_QUIZ_NO_WINDOW")); return; }
    const id = "quiz-" + (++sequence) + "-" + Date.now();
    const published = buildPopQuizPublication(questions, { quizId: id, runId: identity.runId });
    const replay = setInterval(() => { broadcastToAllWindows(IPC.POP_QUIZ_REQUEST, published.card); }, 10_000);
    if (typeof replay.unref === "function") replay.unref();
    awaiting.set(id, { publication: published, resolve: complete, reject: fail, rebroadcastTimer: replay, runId: identity.runId });
    console.log("[PopQuiz]", "发送抽查卡片:", id, "题数:", questions.length);
    broadcastToAllWindows(IPC.POP_QUIZ_REQUEST, published.card);
    toastEvents.publishQuizPending({ quizId: id, runId: identity.runId, firstQuestion: published.card.questions[0]?.question ?? published.card.intro });
  });
}
export function registerPopQuizIpc(ipcOption?: IpcScope): void {
  const scope = ipcOption ?? createIpcScope();
  scope.handle(IPC.POP_QUIZ_RESOLVE, (_event, submission: unknown): PopQuizResolveResponse => {
    const payload = submission as PopQuizSubmission | null;
    const id = payload && typeof payload.quizId === "string" ? payload.quizId : "";
    const pending = id ? awaiting.get(id) : undefined;
    if (!pending || !payload) { console.warn("[PopQuiz]", "抽查提交未匹配到 pending:", id || "(无 quizId)"); return { ok: false, error: "E_QUIZ_NOT_FOUND" }; }
    const grading = gradeQuizSubmission(pending.publication, payload);
    if (grading.error || !grading.results || !grading.graded) { console.warn("[PopQuiz]", "抽查提交校验失败:", grading.error); return { ok: false, error: grading.error ?? "E_QUIZ_ANSWER_INVALID" }; }
    const answers = grading.results;
    settlePendingQuiz(id, "submitted", (open) => {
      const collected = evidence.get(open.runId) ?? [];
      collected.push(...answers);
      evidence.set(open.runId, collected);
      open.resolve({ quizId: id, status: "submitted", answers });
    });
    return { ok: true, graded: grading.graded };
  });
  scope.handle(IPC.POP_QUIZ_SKIP, (_event, payload: { quizId?: string }) => {
    const id = typeof payload?.quizId === "string" ? payload.quizId : "";
    const pending = awaiting.get(id);
    if (!pending) return { ok: false, error: "E_QUIZ_NOT_FOUND" };
    settlePendingQuiz(id, "skipped", (open) => open.resolve({ quizId: id, status: "skipped" }));
    return { ok: true };
  });
}
export function cancelPendingQuizzesForRun(runId: string): void {
  for (const [id, pending] of [...awaiting]) if (pending.runId === runId) {
    settlePendingQuiz(id, "cancelled", (open) => open.reject(createAbortError()));
    console.log("[PopQuiz]", "cancelPendingQuizzesForRun 清理:", id, "runId=", runId);
  }
}
function quizQuestionSchemaDescription(): string {
  const formats = ['单选题：type="choice"，options 2-6 项，correctIndex 指向正确项下标', '多选题：type="multi"，correctIndexes 数组（全对才对）',
    '判断题：type="true_false"，correct 为 true/false', '简答题：type="short_answer"，referenceAnswer 评分参考 + rubric 给分要点数组'];
  return formats.join("；");
}
export const POP_QUIZ_TOOL_ID = "pop_quiz";
export const popQuizTool: ToolDefinition = {
  id: POP_QUIZ_TOOL_ID, name: "突击抽查",
  description: [
    "测试**用户**对已学内容的掌握：出 1-3 道题，等用户作答后拿回判分结果，再针对性讲解错因。",
    "何时用：讲完一个知识点后想确认用户真的懂了；学习进度显示某知识点薄弱需要验证。",
    "不要用：向用户征求偏好、确认或补充信息（那是 ask_user 的职责，两者方向相反：pop_quiz 是你考用户，ask_user 是你问用户）。出题测试用户时必须用本工具，不要用 ask_user。",
    "题目要求：每题必须带 learningObjective（本题测的知识点，优先复用 outline/progress 里已有命名）、explanation（标准答案为什么对，批改后展示给用户）；对 vault 材料中的事实出题时必须先用 obsidian 工具读取材料再出题，sourceRef 只引用本轮实际读取过的材料。",
    "题型：" + quizQuestionSchemaDescription() + "。",
    "结果：选择/判断题由系统本地判分；简答题返回用户原文（grading=pending_model），由你自行批改讲评。用户也可以跳过整次抽查（status=skipped，不算答错）。",
  ].join("\n"),
  enabled: true, modes: ["work"], needsContext: true, effectKind: "read", verificationPolicy: "none",
  inputSchema: { type: "object", properties: { questions: { type: "array", description: "1-3 道题的数组", items: {
    type: "object", properties: {
      type: { type: "string", enum: ["choice", "multi", "true_false", "short_answer"], description: "题型：choice=单选；multi=多选；true_false=判断；short_answer=简答" },
      question: { type: "string", description: "题干文本" }, learningObjective: { type: "string", description: "本题测的知识点（优先复用 outline/progress 里已有命名）" },
      explanation: { type: "string", description: "标准答案为什么对（批改后展示给用户）" },
      sourceRef: { type: "object", description: "出题依据的材料引用（可选；只引用本轮实际读取过的材料）", properties: {
        file: { type: "string", description: "vault 内相对路径" }, heading: { type: "string", description: "具体章节标题（可选）" },
      }, required: ["file"] },
      options: { type: "array", description: "选项纯文本数组（choice/multi 必填；true_false/short_answer 不要传）。注意是字符串数组，不是对象", items: { type: "string" } },
      correctIndex: { type: "integer", description: "choice 专属：正确项下标（从 0 开始）" },
      correctIndexes: { type: "array", description: "multi 专属：全部正确项下标（全对才对）", items: { type: "integer" } },
      correct: { type: "boolean", description: "true_false 专属：标准答案 true/false" }, referenceAnswer: { type: "string", description: "short_answer 专属：评分参考答案" },
      rubric: { type: "array", description: "short_answer 专属：给分要点", items: { type: "string" } },
    }, required: ["type", "question", "learningObjective", "explanation"],
  } } }, required: ["questions"] },
  execute: async (arguments_, context?: ToolContext): Promise<string> => {
    const parsed = parseQuizInput(arguments_.questions);
    if (!parsed.questions) throw Object.assign(new Error("pop_quiz 参数无效：" + parsed.error), { code: "E_QUIZ_INPUT_INVALID" });
    const run = context?.runId;
    if (!run) throw Object.assign(new Error("pop_quiz 需要 run 上下文"), { code: "E_QUIZ_NO_RUN_CONTEXT" });
    const response = await requestPopQuiz(parsed.questions, { runId: run });
    return JSON.stringify(response);
  },
};
export function registerPopQuizTool(): void { toolRegistry.register(popQuizTool); }
