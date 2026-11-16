// toast 上“查看审批”与作答的现场核实。审批本身仍由 permission 结算，这里只决定能不能看、能不能批：
// 只认审批 id 对应的原请求和原运行，不看渲染页当前打开的是哪个会话。

import type { ApprovalRequest } from "../../../shared/permission-approval";
import type { ToastApprovalArgument, ToastApprovalDetail } from "../../../shared/toast-types";

export interface ApprovalReviewDeps {
  /** 按审批 id 取仍在等待的原请求；已结算、已取消或未知的 id 返回 undefined */
  getPendingApproval(approvalId: string): ApprovalRequest | undefined;
  /** 运行仍在进行时返回它所属的会话 id；已结束、已取消、已被接管或未登记的运行返回 undefined */
  findActiveSessionForRun(runId: string): string | undefined;
  /** 会话标题，只用于展示；取不到时返回 undefined */
  getSessionTitle?(sessionId: string): string | undefined;
  /** 结算仍在等待的审批；已结算或未知的 id 返回 false，不结算任何东西 */
  answerApproval(approvalId: string, allowed: boolean): boolean;
}

/** 详情里最多列出的参数个数和每个值的最大长度，避免把整段写入内容塞进提醒窗口 */
export const APPROVAL_ARGUMENT_LIMIT = 6;
export const APPROVAL_ARGUMENT_TEXT_LIMIT = 160;

function argumentText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > APPROVAL_ARGUMENT_TEXT_LIMIT ? `${text.slice(0, APPROVAL_ARGUMENT_TEXT_LIMIT)}…` : text;
}

/** 关键操作参数：按原请求里的顺序取前几项，值转成截断后的文本 */
export function summarizeApprovalArguments(args: Record<string, unknown>): ToastApprovalArgument[] {
  return Object.entries(args ?? {})
    .filter(([, value]) => value !== undefined)
    .slice(0, APPROVAL_ARGUMENT_LIMIT)
    .map(([key, value]) => ({ key, value: argumentText(value) }));
}

function hasRunId(request: ApprovalRequest): request is ApprovalRequest & { runId: string } {
  return typeof request.runId === "string" && request.runId.trim().length > 0;
}

export function createApprovalReview(deps: ApprovalReviewDeps) {
  function inspect(approvalId: string): ToastApprovalDetail {
    const request = deps.getPendingApproval(approvalId);
    if (!request) return { state: "expired", approvalId };
    const shared = {
      approvalId, toolName: request.toolName, toolId: request.toolId,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      args: summarizeApprovalArguments(request.args),
    };
    // 没有运行 ID 的审批不属于任何会话；主进程确认不了它来自独立的审批入口，只显示，不能批准。
    if (!hasRunId(request)) return { state: "runless", ...shared };
    const sessionId = deps.findActiveSessionForRun(request.runId);
    if (!sessionId) return { state: "unverified", ...shared };
    const title = deps.getSessionTitle?.(sessionId);
    return { state: "pending", ...shared, session: { id: sessionId, ...(title ? { title } : {}) } };
  }

  /** 作答前再核实一次；只有原运行仍在所属会话里的 pending 才结算，其余一律不放行 */
  function answer(approvalId: string, allowed: boolean): { ok: boolean } {
    const detail = inspect(approvalId);
    if (detail.state !== "pending") return { ok: false };
    return { ok: deps.answerApproval(approvalId, allowed) };
  }

  return { inspect, answer };
}

export type ApprovalReview = ReturnType<typeof createApprovalReview>;
