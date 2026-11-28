/**
 * progress.md 的数据形状与初始模板。
 */

/** progress.md 的初始内容：frontmatter 之后只有一句“暂无记录”。 */
export function defaultProgressContent(): string {
  const stamp = new Date().toISOString();
  const lines = [
    "---",
    "schemaVersion: 1",
    `updatedAt: ${stamp}`,
    "topics: {}",
    "---",
    "",
    "# 学习进度",
    "",
    "暂无记录。",
    "",
  ];
  return lines.join("\n");
}

export type TopicStatus = "learning" | "reviewing" | "mastered";

/** 单个主题的进度记录。 */
export interface LearnTopicProgress {
  lastStudiedAt: string;
  mastery: number;
  status: TopicStatus;
  /** 未解决的问题列表。 */
  unresolvedQuestions: string[];
}

/** progress.md 解析后的完整结构。 */
export interface LearnProgress {
  currentSection?: string;
  currentTopic?: string;
  nextStep?: string;
  schemaVersion: 1;
  topics: Record<string, LearnTopicProgress>;
  updatedAt: string;
}

/** 模型结构化输出的增量更新。 */
export interface LearnProgressUpdate {
  hasMeaningfulChange: boolean;
  masteryDelta?: number;
  nextStep?: string;
  section?: string;
  status?: TopicStatus;
  topic?: string;
  unresolvedQuestionsAdded?: string[];
  unresolvedQuestionsResolved?: string[];
}
