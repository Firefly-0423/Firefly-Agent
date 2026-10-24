import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const windows = vi.hoisted(() => ({ register: vi.fn(), broadcast: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: windows.register }, BrowserWindow: { getAllWindows: () => [{ webContents: { send: windows.broadcast } }] } }));
import { parseQuizInput, buildPopQuizPublication, gradeQuizSubmission, requestPopQuiz, registerPopQuizIpc, cancelPendingQuizzesForRun, takeQuizEvidenceForRun } from "./pop-quiz";
import { IPC } from "../../shared/ipc-channels";
import { isAbortError } from "../utils/abort-utils";
import type { QuizQuestionInput, PopQuizCard } from "../../shared/pop-quiz";

const choice = () => ({ type: "choice" as const, question: "How many days are in a week?", options: ["7", "8", "6"], correctIndex: 0, learningObjective: "Calendar week length", explanation: "A calendar week contains seven days." });
const multi = () => ({ type: "multi" as const, question: "Which are weekend days?", options: ["Saturday", "Monday", "Sunday"], correctIndexes: [0, 2], learningObjective: "Weekend days", explanation: "Saturday and Sunday form the weekend." });
const boolean = () => ({ type: "true_false" as const, question: "A week contains eight days.", correct: false, learningObjective: "Calendar week length", explanation: "A week contains seven days." });
const short = () => ({ type: "short_answer" as const, question: "Explain a leap year.", referenceAnswer: "A year with an extra calendar day", rubric: ["Mentions an extra day", "Mentions February"], learningObjective: "Leap years", explanation: "February receives an additional day." });
const identity = { quizId: "calendar-quiz", runId: "calendar-run" };
const card = () => windows.broadcast.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_REQUEST).at(-1)![1] as PopQuizCard;
function invoke(channel: string, payload: unknown): any { return windows.register.mock.calls.find(([name]) => name === channel)![1]({}, payload); }
beforeEach(() => { windows.register.mockClear(); windows.broadcast.mockClear(); });
afterEach(() => vi.restoreAllMocks());

describe("Quiz input admission and normalization", () => {
  it("accepts all question types and ignores incomplete source references", () => {
    const parsed = parseQuizInput([choice(), multi(), boolean()]);
    expect(parsed.questions).toHaveLength(3); expect(parsed.error).toBeUndefined();
    expect(parseQuizInput([{ ...choice(), sourceRef: { heading: "Calendar" } }]).questions?.[0].sourceRef).toBeUndefined();
    expect(parseQuizInput([short()]).error).toBeUndefined();
  });

  it.each([
    [[], undefined], [Array.from({ length: 4 }, choice), undefined],
    [[{ ...choice(), learningObjective: " " }], "learningObjective"],
    [[{ ...choice(), correctIndex: 5 }], "correctIndex"],
    [[{ ...choice(), options: ["7"] }], "选项数量"],
    [[{ ...short(), referenceAnswer: "", rubric: [] }], "referenceAnswer"],
    [[{ ...choice(), options: [{ label: "7" }, { unrelated: true }, "6"] }], "纯文本数组"],
  ] as const)("rejects invalid quiz input %j", (input, errorFragment) => {
    const parsed = parseQuizInput(input);
    expect(parsed.error).toBeTruthy();
    if (errorFragment) expect(parsed.error).toContain(errorFragment);
  });

  it("normalizes object options, numeric indexes, booleans and a single rubric string", () => {
    const parsed = parseQuizInput([{ ...choice(), options: [{ label: "7" }, { text: "8" }, { value: "6" }], correctIndex: "0" }]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.questions?.[0]).toMatchObject({ type: "choice", options: ["7", "8", "6"], correctIndex: 0 });
    expect(parseQuizInput([{ ...multi(), correctIndexes: ["0", "2"] }]).questions?.[0]).toMatchObject({ correctIndexes: [0, 2] });
    expect(parseQuizInput([{ ...boolean(), correct: "false" }]).questions?.[0]).toMatchObject({ correct: false });
    expect(parseQuizInput([{ ...short(), rubric: "Mentions February" }]).questions?.[0]).toMatchObject({ rubric: ["Mentions February"] });
  });
});

describe("Quiz publication and local grading", () => {
  it("keeps answers and explanations private while publishing stable option IDs", () => {
    const publication = buildPopQuizPublication([choice()], identity);
    const serialized = JSON.stringify(publication.card);
    expect(serialized).not.toContain("correctIndex"); expect(serialized).not.toContain("explanation");
    expect(publication.card.questions[0]).toMatchObject({ id: "q1", type: "choice", learningObjective: "Calendar week length" });
    expect(publication.card.questions[0].options).toHaveLength(3);
    expect(publication.privateQuestions[0].correctAnswer).toEqual(0);
    expect(publication.privateQuestions[0].optionIndex.get("q1-opt-1")).toEqual(0);
  });

  it("retains original choice and boolean answers and returns explanations after grading", () => {
    const publication = buildPopQuizPublication([choice(), boolean()], identity);
    const correct = gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-1" }, { questionId: "q2", boolean: false }] });
    expect(correct.results?.[0]).toMatchObject({ grading: "correct", userAnswer: 0, correctAnswer: 0 });
    expect(correct.graded?.[0].explanation).toContain("seven days");
    const wrong = gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-2" }, { questionId: "q2", boolean: true }] });
    expect(wrong.results?.[0]).toMatchObject({ grading: "incorrect", userAnswer: 1, correctAnswer: 0 });
    expect(wrong.results?.[1]).toMatchObject({ grading: "incorrect", userAnswer: true, correctAnswer: false });
  });

  it("requires every correct multi choice, sorts the answer, and defers short-answer grading", () => {
    const publication = buildPopQuizPublication([multi()], identity);
    expect(gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionIds: ["q1-opt-1"] }] }).results?.[0]).toMatchObject({ grading: "incorrect", userAnswer: [0], correctAnswer: [0, 2] });
    expect(gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionIds: ["q1-opt-3", "q1-opt-1"] }] }).results?.[0]).toMatchObject({ grading: "correct", userAnswer: [0, 2] });
    const subjective = gradeQuizSubmission(buildPopQuizPublication([short()], identity), { quizId: identity.quizId, answers: [{ questionId: "q1", text: "  February gets another day  " }] });
    expect(subjective.results?.[0]).toMatchObject({ grading: "pending_model", userAnswer: "February gets another day" });
    expect(subjective.results?.[0].correctAnswer).toBeUndefined();
  });

  it("rejects missing answers, repeated questions and invented option IDs", () => {
    const publication = buildPopQuizPublication([choice(), boolean()], identity);
    expect(gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-1" }] }).error).toEqual("E_QUIZ_ANSWER_INCOMPLETE");
    expect(gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-99" }, { questionId: "q2", boolean: false }] }).error).toBeTruthy();
    expect(gradeQuizSubmission(publication, { quizId: identity.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-1" }, { questionId: "q1", optionId: "q1-opt-2" }] }).error).toBeTruthy();
  });
});

describe("Quiz IPC lifecycle", () => {
  beforeEach(() => registerPopQuizIpc());
  function open(runId: string, questions: QuizQuestionInput[] = [choice()]) { const pending = requestPopQuiz(questions, { runId }); return { pending, published: card() }; }

  it("grades a submission, broadcasts settlement and exposes evidence exactly once", async () => {
    const { pending, published } = open("calendar-submit");
    expect(published.runId).toEqual("calendar-submit"); expect(published.questions[0].options).toHaveLength(3);
    const response = invoke(IPC.POP_QUIZ_RESOLVE, { quizId: published.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-1" }] });
    expect(response.ok).toEqual(true); expect(response.graded?.[0].grading).toEqual("correct");
    await expect(pending).resolves.toMatchObject({ quizId: published.quizId, status: "submitted", answers: [{ questionId: "q1", grading: "correct", learningObjective: expect.any(String) }] });
    expect(windows.broadcast.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_SETTLED).at(-1)?.[1]).toMatchObject({ quizId: published.quizId, runId: "calendar-submit", reason: "submitted" });
    const evidence = takeQuizEvidenceForRun("calendar-submit");
    expect(evidence).toHaveLength(1); expect(evidence[0].learningObjective).toContain("Calendar week");
    expect(takeQuizEvidenceForRun("calendar-submit")).toHaveLength(0);
  });

  it("skips without evidence and broadcasts the skipped settlement", async () => {
    const { pending, published } = open("calendar-skip");
    expect(invoke(IPC.POP_QUIZ_SKIP, { quizId: published.quizId }).ok).toEqual(true);
    await expect(pending).resolves.toMatchObject({ quizId: published.quizId, status: "skipped" });
    expect(takeQuizEvidenceForRun("calendar-skip")).toHaveLength(0);
    expect(windows.broadcast.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_SETTLED).at(-1)?.[1]).toMatchObject({ reason: "skipped" });
  });

  it("accepts only the first valid answer and lets invalid submissions be corrected", async () => {
    const first = open("calendar-once");
    const payload = { quizId: first.published.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-1" }] };
    expect(invoke(IPC.POP_QUIZ_RESOLVE, payload).ok).toEqual(true);
    expect(invoke(IPC.POP_QUIZ_RESOLVE, { ...payload, answers: [{ questionId: "q1", optionId: "q1-opt-2" }] }).ok).toEqual(false);
    await expect(first.pending).resolves.toMatchObject({ answers: [{ grading: "correct" }] });
    const retry = open("calendar-retry");
    expect(invoke(IPC.POP_QUIZ_RESOLVE, { quizId: retry.published.quizId, answers: [{ questionId: "q1", optionId: "absent-option" }] }).ok).toEqual(false);
    expect(invoke(IPC.POP_QUIZ_RESOLVE, { quizId: retry.published.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-2" }] }).ok).toEqual(true);
    await expect(retry.pending).resolves.toMatchObject({ answers: [{ grading: "incorrect" }] });
  });

  it("cancels pending work with AbortError and rejects late or unknown submissions", async () => {
    const { pending, published } = open("calendar-cancel");
    cancelPendingQuizzesForRun("calendar-cancel");
    await expect(pending).rejects.toSatisfy(isAbortError);
    expect(windows.broadcast.mock.calls.filter(([channel]) => channel === IPC.POP_QUIZ_SETTLED).at(-1)?.[1]).toMatchObject({ quizId: published.quizId, runId: "calendar-cancel", reason: "cancelled" });
    const late = invoke(IPC.POP_QUIZ_RESOLVE, { quizId: published.quizId, answers: [{ questionId: "q1", optionId: "q1-opt-1" }] });
    expect(late.ok).toEqual(false); expect(late.error).toEqual("E_QUIZ_NOT_FOUND");
    expect(invoke(IPC.POP_QUIZ_RESOLVE, { quizId: "absent-calendar", answers: [] }).ok).toEqual(false);
    expect(invoke(IPC.POP_QUIZ_SKIP, { quizId: "absent-calendar" }).ok).toEqual(false);
  });
});
