import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import {
  buildAskSubmission, createAskDrafts, isAskComplete, selectAskOption, updateAskCustomText,
  type AskUserInteraction, type AskUserQuestion, type PermissionInteraction, type PopQuizInteraction,
} from "./run-presentation";
import type { PopQuizGradedQuestion, PopQuizSubmission } from "../../../../../shared/pop-quiz";
import { MarkdownContent } from "./ChatMessageList";
import "./RunExperience.css";

function PanelShell({ children, title }: { children: ReactNode; title: string }) {
  return <section aria-label={title} className="ff-interaction-panel">{children}</section>;
}

type PagerProps = { page: number; count: number; disabled: boolean; setPage: (page: number | ((page: number) => number)) => void };
function QuestionPager({ page, count, disabled, setPage }: PagerProps) {
  const { t } = useTranslation();
  return count > 1 && <nav aria-label={t("interaction.pagerAria")} className="ff-interaction-panel__pager">
    <button onClick={() => setPage(value => Math.max(0, value - 1))} disabled={disabled || page === 0}
      aria-label={t("interaction.prevQuestion")} type="button">‹</button>
    <span className="ff-interaction-panel__page">{page + 1} / {count}</span>
    <button onClick={() => setPage(value => Math.min(count - 1, value + 1))} disabled={disabled || page === count - 1}
      aria-label={t("interaction.nextQuestion")} type="button">›</button>
  </nav>;
}

function QuestionIndex({ questions, page, disabled, setPage, answered }: {
  questions: { id: string }[]; page: number; disabled: boolean; setPage: (index: number) => void;
  answered: (id: string, index: number) => boolean;
}) {
  const { t } = useTranslation();
  return questions.length > 1 && <div aria-label={t("interaction.questionProgressAria")} className="ff-interaction-panel__question-index">
    {questions.map((question, index) => <button onClick={() => setPage(index)} disabled={disabled}
      className={page === index ? "is-current" : ""} key={question.id} type="button">
      {answered(question.id, index) ? "✓" : "○"} {index + 1}
    </button>)}
  </div>;
}

type AskPanelProps = {
  interaction: AskUserInteraction; disabled?: boolean; onAnswer?: (answer: unknown) => void; onIgnore?: () => void;
};
export function AskUserPanel({ interaction, disabled = false, onAnswer }: AskPanelProps) {
  const { t } = useTranslation();
  const askQuestions: AskUserQuestion[] = interaction.questions ?? [{
    id: "choice", question: interaction.question, options: interaction.options, allowCustomInput: interaction.allowCustomInput,
  }];
  const [askPageIndex, changeAskPage] = useState(0);
  const [askAnswers, setAnswers] = useState(() => createAskDrafts(askQuestions));
  useEffect(() => {
    changeAskPage(0);
    setAnswers(createAskDrafts(askQuestions));
  }, [interaction.id]);
  const question = askQuestions[Math.min(askPageIndex, askQuestions.length - 1)];
  const draft = askAnswers[question.id] ?? { source: null, optionIds: [], customText: "" };
  const complete = isAskComplete(askQuestions, askAnswers);
  function submit() {
    if (!complete) return;
    switch (interaction.responseKind) {
      case "submission": onAnswer?.(buildAskSubmission(interaction, askAnswers)); return;
      case "clarification":
        onAnswer?.({ requestId: interaction.id, answers: askQuestions.map(item => {
          const answer = askAnswers[item.id];
          return answer.source === "custom"
            ? { field: item.id, customText: answer.customText.trim() }
            : { field: item.id, selectedValues: answer.optionIds };
        }) });
        return;
      default: onAnswer?.(draft.source === "custom" ? draft.customText.trim() : draft.optionIds[0]);
    }
  }
  return <PanelShell title={t("interaction.askingTitle")}>
    <div className="ff-interaction-panel__heading">
      <span className="ff-interaction-panel__status">{t("interaction.askingTitle")}</span>
      <QuestionPager page={askPageIndex} count={askQuestions.length} disabled={disabled} setPage={changeAskPage} />
    </div>
    {interaction.intro && <div className="ff-interaction-panel__intro"><MarkdownContent content={interaction.intro} /></div>}
    <div className="ff-interaction-panel__question"><MarkdownContent content={question.question} /></div>
    {question.options.length > 0 && <div aria-label={question.question} role={question.multiple ? "group" : "radiogroup"} className="ff-interaction-panel__options">
      {question.options.map((option, index) => <button onClick={() => setAnswers(values => selectAskOption(values, question, option.id))}
        disabled={disabled} aria-checked={draft.optionIds.includes(option.id)} role={question.multiple ? "checkbox" : "radio"}
        className={draft.optionIds.includes(option.id) ? "is-selected" : ""} key={option.id} type="button">
        <span className="ff-interaction-panel__option-index">{index + 1}.</span>
        <div className="ff-interaction-panel__option-body"><MarkdownContent content={option.label} />{option.description && <small>{option.description}</small>}</div>
      </button>)}
    </div>}
    {question.allowCustomInput !== false && <label className="ff-interaction-panel__custom-answer">
      <span>{t("interaction.customAnswerLabel")}</span>
      <input onChange={event => setAnswers(values => updateAskCustomText(values, question.id, event.target.value))}
        placeholder={question.freeTextPlaceholder ?? t("interaction.customAnswerPlaceholder")} disabled={disabled} value={draft.customText} />
    </label>}
    <QuestionIndex questions={askQuestions} page={askPageIndex} disabled={disabled} setPage={changeAskPage}
      answered={id => askAnswers[id]?.source === "option" || askAnswers[id]?.source === "custom"} />
    <div className="ff-interaction-panel__actions">
      <button onClick={submit} disabled={disabled || !complete} className="is-primary" type="button">
        {askQuestions.length > 1 ? t("interaction.submitAll") : t("interaction.submit")}
      </button>
    </div>
  </PanelShell>;
}

type PermissionPanelProps = { interaction: PermissionInteraction; disabled?: boolean; onDecision?: (allowed: boolean) => void };
export function PermissionPanel({ interaction, disabled = false, onDecision }: PermissionPanelProps) {
  const { t } = useTranslation();
  return <PanelShell title={t("interaction.permissionTitle")}>
    <div className="ff-interaction-panel__heading"><span className="ff-interaction-panel__status">{t("interaction.permissionTitle")}</span></div>
    <p className="ff-interaction-panel__question">{interaction.summary}</p>
    <dl className="ff-interaction-panel__metadata">
      {interaction.agentId && <><dt>{t("interaction.agentLabel")}</dt><dd title={interaction.agentId}>{interaction.agentId}</dd></>}
      {interaction.workspaceName && <><dt>{t("interaction.workspaceLabel")}</dt><dd>{interaction.workspaceName}</dd></>}
      {interaction.targetPath && <><dt>{t("interaction.targetLabel")}</dt><dd title={interaction.targetPath}>{interaction.targetPath}</dd></>}
    </dl>
    <div className="ff-interaction-panel__actions">
      <button onClick={() => onDecision?.(false)} disabled={disabled} type="button">{t("interaction.deny")}</button>
      <button onClick={() => onDecision?.(true)} disabled={disabled} className="is-primary" type="button">{t("interaction.allow")}</button>
    </div>
  </PanelShell>;
}

type QuizDraft = { optionId?: string; optionIds?: string[]; boolean?: boolean; text?: string };
type QuizDrafts = Record<string, QuizDraft>;
type QuizQuestion = PopQuizInteraction["questions"][number];

function isQuizQuestionAnswered(question: QuizQuestion, draft: QuizDraft | undefined): boolean {
  switch (question.type) {
    case "choice": return Boolean(draft?.optionId);
    case "multi": return (draft?.optionIds?.length ?? 0) > 0;
    case "true_false": return typeof draft?.boolean === "boolean";
    case "short_answer": return Boolean(draft?.text?.trim());
  }
}

function describeQuizAnswerValue(question: QuizQuestion, value: string | number | number[] | boolean | undefined,
  labels: { true: string; false: string }): string {
  if (value === undefined) return "—";
  if (question.type === "choice" || question.type === "multi") {
    const positions = Array.isArray(value) ? value : [value as number];
    return positions.map(position => question.options[position]?.label ?? String(position)).join("、");
  }
  return question.type === "true_false" ? (value === true ? labels.true : labels.false) : String(value);
}

function draftAnswerLabel(question: QuizQuestion, draft: QuizDraft | undefined, labels: { true: string; false: string }) {
  switch (question.type) {
    case "choice": return draft?.optionId && question.options.find(option => option.id === draft.optionId)?.label;
    case "multi": return (draft?.optionIds ?? []).map(id => question.options.find(option => option.id === id)?.label).filter(Boolean).join("、");
    case "true_false": return draft?.boolean === true ? labels.true : draft?.boolean === false ? labels.false : "—";
    default: return draft?.text?.trim() || "—";
  }
}

function renderGradedQuiz({ questions, drafts, graded, t }: {
  questions: QuizQuestion[]; drafts: QuizDrafts; graded: PopQuizGradedQuestion[]; t: ReturnType<typeof useTranslation>["t"];
}) {
  const byId = new Map(graded.map(item => [item.questionId, item]));
  return <PanelShell title={t("interaction.quizTitle")}>
    <div className="ff-interaction-panel__heading"><span className="ff-interaction-panel__status">{t("interaction.quizGradedTitle")}</span></div>
    <div className="ff-quiz-graded">{questions.map(question => {
      const result = byId.get(question.id);
      const grading = result?.grading ?? "pending_model";
      const labels = { true: t("interaction.quizTrueLabel"), false: t("interaction.quizFalseLabel") };
      const answer = draftAnswerLabel(question, drafts[question.id], labels);
      return <div className={`ff-quiz-graded__item is-${grading}`} key={question.id}>
        <div className="ff-interaction-panel__question"><MarkdownContent content={question.question} /></div>
        <div className="ff-quiz-graded__meta">
          <span className={`ff-quiz-badge is-${grading}`}>
            {grading === "correct" ? t("interaction.quizGradedCorrect") : grading === "incorrect" ? t("interaction.quizGradedIncorrect") : t("interaction.quizGradedPending")}
          </span>
          <div className="ff-quiz-graded__answer">{t("interaction.quizYourAnswer")}：<MarkdownContent content={answer ?? ""} /></div>
          {result?.correctAnswer !== undefined && <div className="ff-quiz-graded__answer">
            {t("interaction.quizCorrectAnswer")}：<MarkdownContent content={describeQuizAnswerValue(question, result.correctAnswer, labels)} />
          </div>}
        </div>
        {result?.explanation && grading !== "pending_model" && <div className="ff-quiz-graded__explanation"><MarkdownContent content={result.explanation} /></div>}
        {grading === "pending_model" && <p className="ff-quiz-graded__pending">{t("interaction.quizPendingHint")}</p>}
      </div>;
    })}</div>
  </PanelShell>;
}

function selectQuizOption(values: QuizDrafts, question: QuizQuestion, optionId: string): QuizDrafts {
  const previous = values[question.id] ?? {};
  if (question.type === "choice") return { ...values, [question.id]: { ...previous, optionId } };
  const ids = previous.optionIds ?? [];
  const optionIds = ids.includes(optionId) ? ids.filter(id => id !== optionId) : [...ids, optionId];
  return { ...values, [question.id]: { ...previous, optionIds } };
}

type QuizPanelProps = {
  interaction: PopQuizInteraction; disabled?: boolean;
  onSubmit?: (submission: PopQuizSubmission) => Promise<{ ok: boolean; error?: string; graded?: PopQuizGradedQuestion[] }>;
  onSkip?: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
};
export function PopQuizPanel({ interaction, disabled = false, onSubmit, onSkip }: QuizPanelProps) {
  const { t } = useTranslation();
  const { questions: quizQuestions } = interaction;
  const [quizPageIndex, changeQuizPage] = useState(0);
  const [quizAnswers, setAnswers] = useState<QuizDrafts>({});
  const [quizPhase, setQuizPhase] = useState<"answering" | "submitting" | "graded">("answering");
  const [gradingResults, setGradingResults] = useState<PopQuizGradedQuestion[]>([]);
  const [quizError, setQuizError] = useState<string | null>(null);
  useEffect(() => {
    changeQuizPage(0);
    setAnswers({});
    setQuizPhase("answering");
    setGradingResults([]);
    setQuizError(null);
  }, [interaction.id]);
  const activeQuestion = quizQuestions[Math.min(quizPageIndex, quizQuestions.length - 1)];
  const quizComplete = quizQuestions.every(question => isQuizQuestionAnswered(question, quizAnswers[question.id]));
  async function submit() {
    if (!quizComplete || quizPhase !== "answering" || !onSubmit) return;
    setQuizPhase("submitting");
    setQuizError(null);
    try {
      const result = await onSubmit({ quizId: interaction.id, answers: quizQuestions.map(question => ({
        questionId: question.id, ...quizAnswers[question.id],
      })) });
      if (result.ok && result.graded) {
        setGradingResults(result.graded);
        setQuizPhase("graded");
        return;
      }
      const errorKey = result.error === "E_QUIZ_ANSWER_INCOMPLETE" ? "interaction.quizIncompleteError"
        : result.error === "E_QUIZ_NOT_FOUND" ? "interaction.quizNotFoundError" : "interaction.quizInvalidError";
      setQuizError(t(errorKey));
      setQuizPhase("answering");
    } catch {
      setQuizError(t("interaction.quizInvalidError"));
      setQuizPhase("answering");
    }
  }
  async function skip() {
    if (!onSkip || quizPhase === "submitting") return;
    await onSkip(interaction.id).catch(() => undefined);
  }
  const trueFalseOptions = [{ value: true, label: t("interaction.quizTrueLabel") }, { value: false, label: t("interaction.quizFalseLabel") }];
  if (quizPhase === "graded") return renderGradedQuiz({ questions: quizQuestions, drafts: quizAnswers, graded: gradingResults, t });
  const locked = disabled || quizPhase === "submitting";
  return <PanelShell title={t("interaction.quizTitle")}>
    <div className="ff-interaction-panel__heading">
      <span className="ff-interaction-panel__status">{t("interaction.quizTitle")}</span>
      <QuestionPager page={quizPageIndex} count={quizQuestions.length} disabled={locked} setPage={changeQuizPage} />
    </div>
    {interaction.intro && <p className="ff-interaction-panel__intro">{interaction.intro}</p>}
    <div className="ff-interaction-panel__question"><MarkdownContent content={activeQuestion.question} /></div>
    {activeQuestion.learningObjective && <div className="ff-quiz-objective">{t("interaction.quizObjectiveLabel")}：<MarkdownContent content={activeQuestion.learningObjective} /></div>}
    {(activeQuestion.type === "choice" || activeQuestion.type === "multi") && <div aria-label={activeQuestion.question}
      role={activeQuestion.type === "multi" ? "group" : "radiogroup"} className="ff-interaction-panel__options">
      {activeQuestion.options.map((option, index) => {
        const selected = activeQuestion.type === "choice" ? quizAnswers[activeQuestion.id]?.optionId === option.id : (quizAnswers[activeQuestion.id]?.optionIds ?? []).includes(option.id);
        return <button onClick={() => setAnswers(values => selectQuizOption(values, activeQuestion, option.id))} disabled={locked}
          aria-checked={selected} role={activeQuestion.type === "multi" ? "checkbox" : "radio"} className={selected ? "is-selected" : ""} key={option.id} type="button">
          <span className="ff-interaction-panel__option-index">{index + 1}.</span>
          <div className="ff-interaction-panel__option-body"><MarkdownContent content={option.label} /></div>
        </button>;
      })}
    </div>}
    {activeQuestion.type === "true_false" && <div aria-label={activeQuestion.question} role="radiogroup" className="ff-interaction-panel__options">
      {trueFalseOptions.map(option => <button onClick={() => setAnswers(values => ({ ...values, [activeQuestion.id]: { ...values[activeQuestion.id], boolean: option.value } }))}
        disabled={locked} aria-checked={quizAnswers[activeQuestion.id]?.boolean === option.value} role="radio"
        className={quizAnswers[activeQuestion.id]?.boolean === option.value ? "is-selected" : ""} key={String(option.value)} type="button">
        <span className="ff-interaction-panel__option-index">◦</span><span><strong>{option.label}</strong></span>
      </button>)}
    </div>}
    {activeQuestion.type === "short_answer" && <label className="ff-interaction-panel__custom-answer">
      <span>{t("interaction.quizShortAnswerLabel")}</span>
      <textarea onChange={event => setAnswers(values => ({ ...values, [activeQuestion.id]: { ...values[activeQuestion.id], text: event.target.value } }))}
        rows={3} placeholder={t("interaction.quizShortAnswerPlaceholder")} disabled={locked} value={quizAnswers[activeQuestion.id]?.text ?? ""} className="ff-quiz-short-answer" />
    </label>}
    <QuestionIndex questions={quizQuestions} page={quizPageIndex} disabled={locked} setPage={changeQuizPage}
      answered={(_, index) => isQuizQuestionAnswered(quizQuestions[index], quizAnswers[quizQuestions[index].id])} />
    {quizError && <p role="alert" className="ff-quiz-error">{quizError}</p>}
    <div className="ff-interaction-panel__actions">
      <button onClick={() => void skip()} disabled={locked} className="ff-quiz-skip" type="button">{t("interaction.quizSkip")}</button>
      <button onClick={() => void submit()} disabled={locked || !quizComplete} className="is-primary" type="button">
        {quizPhase === "submitting" ? t("interaction.quizSubmitting") : t("interaction.quizSubmit")}
      </button>
    </div>
  </PanelShell>;
}
