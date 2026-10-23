// pop_quiz 抽查：模型出题、用户作答、主进程判分的整条类型链。
// 各层信任边界不同：
//   1. 出题输入（模型）不含 id，id 由宿主生成
//   2. 渲染端卡片不含任何答案与讲解，避免提交前泄露
//   3. 提交内容只有选项 id 与自由文本
//   4. 回给模型的工具结果含判分、原始作答与 learningObjective
//   5. 结算广播供渲染端清卡

// ── 1. 模型输入 ──

/** 题目材料的出处：模型出题前确实读取过的 vault 材料 */
export interface QuizSourceRef {
  file: string;
  heading?: string;
}

/** 单选；correctIndex 是 options 的下标 */
export type QuizChoiceInput = {
  sourceRef?: QuizSourceRef;
  explanation: string;
  learningObjective: string;
  correctIndex: number;
  options: string[];
  question: string;
  type: "choice";
};

/** 多选；全部选对才算对 */
export type QuizMultiInput = {
  sourceRef?: QuizSourceRef;
  explanation: string;
  learningObjective: string;
  correctIndexes: number[];
  options: string[];
  question: string;
  type: "multi";
};

/** 判断题 */
export type QuizTrueFalseInput = {
  sourceRef?: QuizSourceRef;
  explanation: string;
  learningObjective: string;
  correct: boolean;
  question: string;
  type: "true_false";
};

/** 简答；本地不判分，由模型看过原文后讲评 */
export type QuizShortAnswerInput = {
  sourceRef?: QuizSourceRef;
  explanation: string;
  learningObjective: string;
  rubric: string[];
  referenceAnswer: string;
  question: string;
  type: "short_answer";
};

export type QuizQuestionInput =
  | QuizChoiceInput
  | QuizMultiInput
  | QuizTrueFalseInput
  | QuizShortAnswerInput;

// ── 2. 渲染端卡片（不含答案） ──

export type PopQuizQuestionType = "choice" | "multi" | "true_false" | "short_answer";

/** 卡片上的单题视图；选项 id 由宿主生成，提交时原样回传 */
export interface PopQuizQuestionView {
  id: string;
  type: PopQuizQuestionType;
  question: string;
  /** choice / multi 才有选项，其余为空 */
  options: Array<{ id: string; label: string }>;
  /** 本题考查的知识点，展示给用户 */
  learningObjective: string;
}

/** 主进程推给渲染端的卡片，不含 correctIndex / correct / referenceAnswer / explanation */
export type PopQuizCard = {
  questions: PopQuizQuestionView[];
  /** 卡片标题下的说明，如「复习一下刚才学的内容」 */
  intro: string;
  runId: string;
  quizId: string;
};

// ── 3. 提交 ──

/** 渲染端的单题作答，按题型填对应字段 */
export type PopQuizAnswerSubmission = {
  /** 简答的原文 */
  text?: string;
  /** 判断题的 true / false */
  boolean?: boolean;
  /** 多选的选项 id 数组 */
  optionIds?: string[];
  /** 单选的选项 id */
  optionId?: string;
  questionId: string;
};

export interface PopQuizSubmission {
  quizId: string;
  answers: PopQuizAnswerSubmission[];
}

// ── 4. 判分与工具结果 ──

export type QuizGrading = "correct" | "incorrect" | "pending_model";

/** 单题判分，保留原始作答，掌握度提取可据此看到「漏选了哪个」 */
export type QuizAnswerResult = {
  grading: QuizGrading;
  /** 标准答案；简答题没有（pending_model） */
  correctAnswer?: string | number | number[] | boolean;
  userAnswer: string | number | number[] | boolean;
  learningObjective: string;
  questionId: string;
};

/** pop_quiz 回给模型的完整工具结果 */
export type PopQuizToolResult =
  | { quizId: string; status: "submitted"; answers: QuizAnswerResult[] }
  | { quizId: string; status: "skipped" };

/** 判分后给渲染端展示态用：对错、讲解、标准答案 */
export type PopQuizGradedQuestion = {
  explanation: string;
  /** 主进程判分得出的标准答案，用于展示态高亮 */
  correctAnswer?: string | number | number[] | boolean;
  grading: QuizGrading;
  questionId: string;
};

/** POP_QUIZ_RESOLVE 的返回值，渲染端据此把卡片切到展示态 */
export type PopQuizResolveResponse = {
  /** 提交成功时的逐题判分 */
  graded?: PopQuizGradedQuestion[];
  error?: string;
  ok: boolean;
};

// ── 5. 结算广播 ──

export type PopQuizSettleReason = "submitted" | "skipped" | "cancelled";

/** POP_QUIZ_SETTLED 的载荷，渲染端据此清卡 */
export type PopQuizSettledPayload = {
  reason: PopQuizSettleReason;
  runId?: string;
  quizId: string;
};
