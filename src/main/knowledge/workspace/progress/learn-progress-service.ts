/**
 * Learn 进度存取：读取、合并与保存 learn/progress.md。
 *
 * 所有文件读写都经由 ObsidianWorkspaceService 完成。progress.md 的 frontmatter 保存结构化数据，正文则给人看。
 */

import type { ObsidianWorkspaceService } from "../obsidian/obsidian-workspace-service";
import type { LearnProgress, LearnProgressUpdate, LearnTopicProgress } from "./learn-progress-types";
import * as yaml from "yaml";

const PROGRESS_PATH = "learn/progress.md";
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---/;
const TOPIC_STATUSES = ["learning", "reviewing", "mastered"] as const;

function emptyProgress(): LearnProgress {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), topics: {} };
}

function clampMastery(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 把 frontmatter 中的 topics 映射逐项还原成类型化结构，缺失或非法的字段使用安全默认值。 */
function readTopics(raw: unknown): Record<string, LearnTopicProgress> {
  const result: Record<string, LearnTopicProgress> = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const fields = entry as Record<string, unknown>;
    const status = TOPIC_STATUSES.includes(String(fields.status) as (typeof TOPIC_STATUSES)[number])
      ? (fields.status as LearnTopicProgress["status"])
      : "learning";
    result[name] = {
      status,
      mastery: typeof fields.mastery === "number" ? clampMastery(fields.mastery) : 0,
      unresolvedQuestions: Array.isArray(fields.unresolvedQuestions)
        ? fields.unresolvedQuestions.filter((item) => typeof item === "string")
        : [],
      lastStudiedAt: typeof fields.lastStudiedAt === "string" ? fields.lastStudiedAt : new Date().toISOString(),
    };
  }
  return result;
}

/** 解析 progress.md 的 frontmatter。没有 frontmatter 或 YAML 不合法时返回空进度。 */
function parseProgressDocument(content: string): LearnProgress {
  const hit = FRONTMATTER_PATTERN.exec(content);
  if (!hit) {
    return emptyProgress();
  }
  try {
    const meta = yaml.parse(hit[1]);
    if (!meta || typeof meta !== "object") {
      throw new Error("invalid yaml");
    }
    const pick = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    return {
      schemaVersion: 1,
      currentTopic: pick(meta.currentTopic),
      currentSection: pick(meta.currentSection),
      topics: readTopics(meta.topics),
      nextStep: pick(meta.nextStep),
      updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptyProgress();
  }
}

/** 读取 learn/progress.md。文件缺失或读取失败时返回空进度。 */
export async function loadProgress(obsidianWorkspace: ObsidianWorkspaceService): Promise<LearnProgress> {
  try {
    const file = await obsidianWorkspace.readFile({ path: PROGRESS_PATH });
    return parseProgressDocument(file.content);
  } catch {
    return emptyProgress();
  }
}

/**
 * 保存进度。已有文件的覆盖必须携带 expectedContentHash，所以每次都先读出当前哈希，再整文件替换。
 * 文件不存在时不创建，返回 false。
 */
export async function saveProgress(progress: LearnProgress, obsidianWorkspace: ObsidianWorkspaceService): Promise<boolean> {
  try {
    const document = renderProgressDocument(progress);
    const current = await obsidianWorkspace.readFile({ path: PROGRESS_PATH }).catch(() => null);
    if (!current) {
      return false;
    }
    await obsidianWorkspace.edit({
      operation: "replace_file",
      path: PROGRESS_PATH,
      content: document,
      expectedContentHash: current.contentHash,
    });
    return true;
  } catch (err) {
    console.warn("[LearnProgress] 保存进度失败：", err);
    return false;
  }
}

/** 状态图标：未知状态按“学习中”显示。 */
function iconFor(status: LearnTopicProgress["status"]): string {
  if (status === "mastered") { return "✅"; }
  if (status === "reviewing") { return "🔄"; }
  return "📖";
}

/** 状态文字：未知状态按“学习中”显示。 */
function labelFor(status: LearnTopicProgress["status"]): string {
  if (status === "mastered") { return "(已掌握)"; }
  if (status === "reviewing") { return "(复习中)"; }
  return "(学习中)";
}

/** 渲染 progress.md：frontmatter 放结构化字段，正文列出当前主题、各主题掌握度与下一步。 */
function renderProgressDocument(progress: LearnProgress): string {
  const meta: Record<string, unknown> = { schemaVersion: 1, updatedAt: new Date().toISOString() };
  if (progress.currentTopic) {
    meta.currentTopic = progress.currentTopic;
  }
  if (progress.currentSection) {
    meta.currentSection = progress.currentSection;
  }
  if (progress.nextStep) {
    meta.nextStep = progress.nextStep;
  }

  const names = Object.keys(progress.topics).sort();
  if (names.length > 0) {
    const serialized: Record<string, unknown> = {};
    for (const name of names) {
      const topic = progress.topics[name];
      serialized[name] = {
        status: topic.status,
        mastery: topic.mastery,
        unresolvedQuestions: topic.unresolvedQuestions,
        lastStudiedAt: topic.lastStudiedAt,
      };
    }
    meta.topics = serialized;
  }

  const frontmatter = yaml.stringify(meta).trim();
  const parts: string[] = ["# 学习进度\n\n"];

  if (progress.currentTopic) {
    const section = progress.currentSection ? ` > ${progress.currentSection}` : "";
    parts.push(`**当前主题**：${progress.currentTopic}${section}\n\n`);
  }

  if (names.length > 0) {
    parts.push("## 主题掌握度\n\n");
    for (const name of names) {
      const topic = progress.topics[name];
      parts.push(`- ${iconFor(topic.status)} **${name}** — ${topic.mastery}% ${labelFor(topic.status)}\n`);
      if (topic.unresolvedQuestions.length > 0) {
        parts.push("  - 待解决的问题：\n");
        for (const question of topic.unresolvedQuestions) {
          parts.push(`    - [ ] ${question}\n`);
        }
      }
    }
    parts.push("\n");
  }

  if (progress.nextStep) {
    parts.push(`## 下一步\n\n${progress.nextStep}\n`);
  }

  return `---\n${frontmatter}\n---\n\n${parts.join("")}`;
}

/**
 * 把一次增量更新套用到现有进度上。注意：与历史行为保持一致，topics 对象与其中的
 * 未解决问题数组会被原地修改，新的副本只浅拷贝了外层。
 */
export function applyUpdate(progress: LearnProgress, update: LearnProgressUpdate): LearnProgress {
  if (!update.hasMeaningfulChange) {
    return progress;
  }
  const stamp = new Date().toISOString();
  const next: LearnProgress = { ...progress, updatedAt: stamp };

  if (update.topic) {
    const name = update.topic;
    next.currentTopic = name;
    if (!next.topics[name]) {
      next.topics[name] = { status: "learning", mastery: 0, unresolvedQuestions: [], lastStudiedAt: stamp };
    }

    const topic: LearnTopicProgress = { ...next.topics[name], lastStudiedAt: stamp };
    if (update.status) {
      topic.status = update.status;
    }
    if (typeof update.masteryDelta === "number") {
      topic.mastery = clampMastery(topic.mastery + update.masteryDelta);
    }
    if (topic.mastery >= 90 && !update.status) {
      topic.status = "mastered";
    } else if (topic.mastery >= 50 && topic.status === "learning" && !update.status) {
      topic.status = "reviewing";
    }

    if (update.unresolvedQuestionsAdded && update.unresolvedQuestionsAdded.length > 0) {
      const seen = new Set(topic.unresolvedQuestions);
      for (const question of update.unresolvedQuestionsAdded) {
        if (!seen.has(question)) {
          topic.unresolvedQuestions.push(question);
        }
      }
    }
    if (update.unresolvedQuestionsResolved && update.unresolvedQuestionsResolved.length > 0) {
      const resolved = update.unresolvedQuestionsResolved;
      topic.unresolvedQuestions = topic.unresolvedQuestions.filter((question) => !resolved.includes(question));
    }

    next.topics[name] = topic;
  }

  if (update.section) {
    next.currentSection = update.section;
  }
  if (update.nextStep) {
    next.nextStep = update.nextStep;
  }
  return next;
}
