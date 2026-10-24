import * as fs from "fs";
import { type BaseEvent, EventType } from "@ag-ui/core";
import type { ReviewRunStatus } from "../../../../shared/review-types";
import type { ConversationMode } from "../../../../shared/chat-types";
import { getPlanState, supplementPlan, getPlanPath, completeExecution } from "../../plan-mode";

export async function preparePlanRunContext(request: {
  threadId: string;
  mode?: ConversationMode;
}): Promise<{
  planContextBlock?: string;
  planState: ReturnType<typeof getPlanState> | undefined;
}> {
  const eligible = request.mode === "code" || request.mode === "chat";
  if (eligible && getPlanState(request.threadId) === "PLAN_REVIEW") {
    supplementPlan(request.threadId);
    console.log("[HarnessAdapter] [Plan] new message during PLAN_REVIEW, back to PLAN_DISCUSSING");
  }
  const snapshot = eligible ? getPlanState(request.threadId) : undefined;
  if (snapshot === "EXECUTING") {
    try {
      const approved = await fs.promises.readFile(getPlanPath(request.threadId), "utf8");
      const context = "[PLAN_CONTEXT]\n"
        + "用户已批准以下实施计划。请严格按计划清单顺序执行，用 update_todo 维护任务进度：\n\n"
        + approved.trim();
      return { planState: snapshot, planContextBlock: context };
    } catch (problem) {
      console.warn("[HarnessAdapter] [Plan] read plan.md failed:", problem instanceof Error ? problem.message : problem);
    }
  }
  return { planState: snapshot };
}

export function completePlanRun(completion: {
  send: (event: BaseEvent) => void;
  signal: AbortSignal;
  planState?: ReturnType<typeof getPlanState>;
  runStatus: ReviewRunStatus;
  runId: string;
  threadId: string;
  mode?: ConversationMode;
}): void {
  if (completion.mode !== "code" && completion.mode !== "chat") return;
  if (completion.planState !== "EXECUTING") return;
  const archivedPath = completeExecution(completion.threadId);
  if (!archivedPath) return;
  console.log(`[HarnessAdapter] [Plan] execution finished, back to NORMAL, plan=${archivedPath}`);
  // 先释放执行态，再决定是否通知界面。
  if (completion.signal.aborted || completion.runStatus !== "completed") return;
  completion.send({
    type: EventType.CUSTOM, name: "firefly.plan.completed",
    value: { planPath: archivedPath, runStatus: completion.runStatus },
    threadId: completion.threadId, runId: completion.runId,
  } as BaseEvent);
}
