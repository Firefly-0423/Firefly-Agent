/**
 * 每轮对话结束后，在后台静默更新 Learn 学习进度。
 *
 * 由 agui-bridge.ts 在一轮运行结束后调用。这里不阻塞主流程，也绝不把异常抛回调用方。
 */

import { extractProgress } from "./learn-progress-extractor";
import { loadProgress, applyUpdate, saveProgress } from "./learn-progress-service";
import { canUpdateLearningProgress } from "../knowledge-workspace";
import type { ObsidianWorkspaceService } from "../obsidian/obsidian-workspace-service";
import type { ChatVendorAdapter } from "../../orchestrator/vendors/types";
import type { VendorConfig } from "../../orchestrator/vendors/types";
import type { QuizAnswerResult } from "../../../shared/pop-quiz";
import { policyFor, type AgentFileAccessLevel } from "../../permission/permission-policy";

export interface LearnPostTurnDeps {
  adapter: ChatVendorAdapter;
  cfg: VendorConfig;
  workspace: ObsidianWorkspaceService;
  accessLevel: AgentFileAccessLevel;
  assistantMessage: string;
  userMessage: string;
  systemPrompt: string;
  /** 本轮 pop_quiz 抽查的作答结果（已在本地判分），跳过的抽查不会传入。 */
  quizEvidence?: QuizAnswerResult[];
}

/** 短于此长度的回复通常不是教学内容，除非本轮有抽查作答。 */
const MIN_TEACHING_REPLY_LENGTH = 50;

/** 判断本轮是否值得更新进度：先看权限，再看 vault，再看回复长度，最后看 Learn 权限。 */
async function shouldUpdateProgress(deps: LearnPostTurnDeps): Promise<boolean> {
  if (policyFor(deps.accessLevel, "fs-write") !== "allow") {
    return false;
  }
  if (!deps.workspace.isReady()) {
    console.warn("[LearnProgress] Vault 未配置或不可用，跳过进度更新");
    return false;
  }
  try {
    const hasQuiz = Boolean(deps.quizEvidence?.length);
    if (deps.assistantMessage.length < MIN_TEACHING_REPLY_LENGTH && !hasQuiz) {
      return false;
    }
    return await canUpdateLearningProgress(deps.workspace);
  } catch {
    return false;
  }
}

/**
 * 在一轮有实质内容的对话后，异步、静默地更新学习进度。
 */
export async function runLearnPostTurnHook(deps: LearnPostTurnDeps): Promise<void> {
  if (!(await shouldUpdateProgress(deps))) {
    return;
  }
  scheduleAsync(() =>
    updateProgressAsync(deps).catch((err) => console.warn("[LearnProgress] 进度更新失败：", err)),
  );
}

function pickTurnText(t: { systemPrompt: string; userMessage: string; assistantMessage: string }) {
  return { assistantMessage: t.assistantMessage, userMessage: t.userMessage, systemPrompt: t.systemPrompt };
}

/** 提取增量、读取现有进度、套用增量、写回。无实质变化时直接结束。 */
async function updateProgressAsync(deps: LearnPostTurnDeps): Promise<void> {
  const { adapter, cfg, quizEvidence, ...turn } = deps;
  const change = await extractProgress({
    ...pickTurnText(turn),
    quizEvidence,
    cfg,
    adapter,
  });
  if (!change || !change.hasMeaningfulChange) {
    return;
  }
  const current = await loadProgress(deps.workspace);
  const next = applyUpdate(current, change);
  await saveProgress(next, deps.workspace);
}

/** 放到下一轮事件循环执行，避免占用当前调用栈。 */
function scheduleAsync(task: () => Promise<void>): void {
  setImmediate(() => {
    task().catch((err) => console.warn("[LearnProgress] 异步任务失败：", err));
  });
}
