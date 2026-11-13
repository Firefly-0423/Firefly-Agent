export type PlanStateName = "NORMAL" | "PLAN_DISCUSSING" | "PLAN_REVIEW" | "EXECUTING";
interface PlanSessionState { enteredAt: number; planPath: string; planWrittenThisRun: boolean; state: PlanStateName }
type PlanStateBroadcaster = (conversationId: string, state: PlanStateName) => void;
const conversations = new Map<string, PlanSessionState>();
let fallbackRoot: string | null = null;
let notifyState: PlanStateBroadcaster | null = null;

export function initPlanPaths(userDataRoot: string): void { fallbackRoot = userDataRoot; }
export function initPlanStateBroadcaster(broadcaster: PlanStateBroadcaster | null): void { notifyState = broadcaster; }

function broadcastState(conversationId: string, state: PlanStateName): void {
  try { notifyState?.(conversationId, state); } catch { /* 通知失败不回滚已完成的切换。 */ }
}
function normalizedPath(...segments: string[]): string { return segments.join("/").replace(/\\/g, "/").replace(/\/+/g, "/"); }
function planFileName(at = new Date()): string {
  const pair = (value: number) => String(value).padStart(2, "0");
  const date = [at.getFullYear(), pair(at.getMonth() + 1), pair(at.getDate())].join("");
  const time = [pair(at.getHours()), pair(at.getMinutes()), pair(at.getSeconds())].join("");
  return `plan-${date}-${time}.md`;
}
export function buildWorkspacePlanPath(workspaceRoot: string): string {
  return normalizedPath(workspaceRoot.replace(/[\\/]$/, ""), ".firefly/docs", planFileName());
}
function fallbackPlanPath(conversationId: string): string {
  const root = fallbackRoot ?? "";
  return root ? normalizedPath(root, "plans", conversationId, "plan.md") : normalizedPath("plans", conversationId, "plan.md");
}
export function getPlanPath(conversationId: string): string { return conversations.get(conversationId)?.planPath || fallbackPlanPath(conversationId); }
export function getPlanState(conversationId: string): PlanStateName { return conversations.get(conversationId)?.state ?? "NORMAL"; }
export function isInPlanDiscussion(conversationId: string): boolean {
  const phase = getPlanState(conversationId);
  return phase === "PLAN_DISCUSSING" || phase === "PLAN_REVIEW";
}
export function isPlanReadOnly(conversationId: string): boolean { return isInPlanDiscussion(conversationId); }

function ensureSession(conversationId: string): PlanSessionState {
  const present = conversations.get(conversationId);
  if (present) return present;
  const created: PlanSessionState = { state: "NORMAL", planWrittenThisRun: false, planPath: "", enteredAt: Date.now() };
  conversations.set(conversationId, created);
  return created;
}

export function enterPlanDiscussing(conversationId: string, workspaceRoot?: string): { ok: boolean; reason?: string } {
  const session = ensureSession(conversationId);
  switch (session.state) {
    case "PLAN_DISCUSSING": return { ok: false, reason: "已在计划模式中" };
    case "PLAN_REVIEW": return { ok: false, reason: "计划待审批，等待用户决定" };
    case "EXECUTING": return { ok: false, reason: "计划执行中，不可进入计划模式" };
  }
  session.state = "PLAN_DISCUSSING";
  session.planWrittenThisRun = false;
  session.planPath = workspaceRoot ? buildWorkspacePlanPath(workspaceRoot) : fallbackPlanPath(conversationId);
  session.enteredAt = Date.now();
  broadcastState(conversationId, session.state);
  return { ok: true };
}
export function markPlanWritten(conversationId: string): void { ensureSession(conversationId).planWrittenThisRun = true; }
export function hasPlanWrittenThisRun(conversationId: string): boolean { return conversations.get(conversationId)?.planWrittenThisRun ?? false; }
export function moveToReview(conversationId: string): boolean {
  const session = conversations.get(conversationId);
  if (!session || session.state !== "PLAN_DISCUSSING" || !session.planWrittenThisRun) return false;
  session.state = "PLAN_REVIEW";
  session.planWrittenThisRun = false;
  broadcastState(conversationId, session.state);
  return true;
}
function leaveReview(conversationId: string, destination: "PLAN_DISCUSSING" | "EXECUTING"): boolean {
  const session = conversations.get(conversationId);
  if (!session || session.state !== "PLAN_REVIEW") return false;
  session.state = destination;
  broadcastState(conversationId, session.state);
  return true;
}
export function supplementPlan(conversationId: string): boolean { return leaveReview(conversationId, "PLAN_DISCUSSING"); }
export function approvePlan(conversationId: string): boolean { return leaveReview(conversationId, "EXECUTING"); }
export function exitPlanMode(conversationId: string): void {
  const session = conversations.get(conversationId);
  if (!session) return;
  session.state = "NORMAL";
  session.planWrittenThisRun = false;
  broadcastState(conversationId, session.state);
}
export function completeExecution(conversationId: string): string | undefined {
  const session = conversations.get(conversationId);
  if (!session || session.state !== "EXECUTING") return undefined;
  session.state = "NORMAL";
  session.planWrittenThisRun = false;
  broadcastState(conversationId, session.state);
  return session.planPath;
}
export function resetPlanSessionsForTest(): void { conversations.clear(); fallbackRoot = null; notifyState = null; }
