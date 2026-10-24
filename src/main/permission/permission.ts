// 本地权限闸门：当前档位的持有与落盘、工具调用的放行判定、以及「每次审批」的卡片往返。
import { app, BrowserWindow, ipcMain } from "electron";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { createAbortError } from "../utils/abort-utils";
import { logger, LogTag } from "../logging/logger";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "./permission-policy";
import { toastEvents } from "../toast/toast-events";
import type { ApprovalOrigin, ApprovalRequest, ApprovalSettleReason, ApprovalSettledPayload } from "../../shared/permission-approval";

export { policyFor, type AgentFileAccessLevel, type ToolRiskLevel };
// 审批载荷只在 shared 里声明一次，主进程、preload、渲染端共用。
export type { ApprovalRequest, ApprovalSettledPayload, ApprovalSettleReason };

const TAG = "[Permission]";

export const ACCESS_LEVEL_LABEL: Record<AgentFileAccessLevel, string> = {
  "read-only": "只读", scoped: "指定目录", full: "完全访问",
  "project-read-only": "完全只读", "per-action": "每次审批",
};

function isValidLevel(value: unknown): value is AgentFileAccessLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACCESS_LEVEL_LABEL, value);
}

// ── 档位：内存值 + userData 下的 JSON 文件 ──────────────────

let activeLevel: AgentFileAccessLevel = "read-only";

export function getCurrentLevel(): AgentFileAccessLevel {
  return activeLevel;
}

const levelFilePath = () => path.join(app.getPath("userData"), "agent-permission.json");

function writeLevelFile(level: AgentFileAccessLevel): void {
  try {
    const target = levelFilePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ level }, null, 2), "utf8");
  } catch (err) {
    console.error(TAG, "写入档位文件失败:", err);
  }
}

export function setCurrentLevel(level: AgentFileAccessLevel): void {
  if (activeLevel === level) return;
  console.log(TAG, "切换档位:", activeLevel, "→", level);
  activeLevel = level;
  writeLevelFile(level);
}

/** 启动时读回上次的档位；文件缺失或内容不合法时保持默认。需在 app ready 之后调用。 */
export function initPermissionFromDisk(): void {
  try {
    const source = levelFilePath();
    if (!fs.existsSync(source)) {
      console.log(TAG, "没有已保存的档位，沿用默认 read-only");
      return;
    }
    const saved = JSON.parse(fs.readFileSync(source, "utf8")) as { level?: unknown } | null;
    const candidate = saved?.level;
    if (!isValidLevel(candidate)) {
      console.warn(TAG, "已保存的档位无法识别，沿用默认");
      return;
    }
    activeLevel = candidate;
    logger.info(LogTag.Permission, "loaded level from disk:", activeLevel);
  } catch (err) {
    console.error(TAG, "读取档位文件失败:", err);
  }
}

// ── 审批往返（per-action 档位） ─────────────────────────────
// 请求广播给所有窗口，由渲染端弹卡片；用户的回答经 IPC 回到这里。
// 没有超时：只有用户回答、所属 run 被取消、或调用方的 signal 触发才会结算。
// 渲染端可能还没就绪，所以未结算期间每 10 秒原样重播一次（渲染端按 id 覆盖，无副作用）。
// 每一次结算都会广播 SETTLED，渲染端据此撤掉卡片。

const REPLAY_EVERY_MS = 10_000;

interface Waiter {
  grant: (allowed: boolean) => void;
  fail: (err: Error) => void;
  ticker: NodeJS.Timeout;
  runId?: string;
  unhook?: () => void;
}

const waiters = new Map<string, Waiter>();
let requestSeq = 0;

// 通道常量必须直接写在 send 调用处，IPC 契约扫描才能认出这是主进程外发。
function showCard(card: ApprovalRequest): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.PERMISSION_APPROVAL_REQUEST, card);
}

function dropCard(settled: ApprovalSettledPayload): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.PERMISSION_APPROVAL_SETTLED, settled);
}

/** 所有结算路径的唯一出口：停重播、出表、撤监听、通知窗口与 toast，最后才执行回调。 */
function closeWaiter(id: string, reason: ApprovalSettleReason, finish: (w: Waiter) => void): void {
  const w = waiters.get(id);
  if (w === undefined) return;
  clearInterval(w.ticker);
  waiters.delete(id);
  w.unhook?.();
  const settled: ApprovalSettledPayload = { id, runId: w.runId, reason };
  dropCard(settled);
  toastEvents.publishApprovalSettled({ id, runId: w.runId, reason });
  finish(w);
}

const rejectAsCancelled = (w: Waiter): void => w.fail(createAbortError());

/** 发起一次审批并等待结果；无超时，用户回答或取消前一直挂起。 */
export function requestApproval(request: Omit<ApprovalRequest, "id">, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((grant, fail) => {
    if (signal?.aborted) {
      fail(createAbortError());
      return;
    }
    requestSeq += 1;
    const id = `approve-${requestSeq}-${Date.now()}`;
    const card: ApprovalRequest = { id, ...request };
    console.log(TAG, "下发审批请求:", id, request.toolId);

    // 应用正在退出、没有窗口可问时，直接视为拒绝
    if (BrowserWindow.getAllWindows().length === 0) {
      console.warn(TAG, "当前没有窗口，审批按拒绝处理");
      grant(false);
      return;
    }

    const ticker = setInterval(() => showCard(card), REPLAY_EVERY_MS);
    if (typeof ticker.unref === "function") ticker.unref();

    const onAbort = (): void => closeWaiter(id, "cancelled", rejectAsCancelled);
    const waiter: Waiter = { grant, fail, ticker, runId: request.runId };
    if (signal) waiter.unhook = () => signal.removeEventListener("abort", onAbort);
    waiters.set(id, waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    showCard(card);
    // 只通知一次；之后的重播由 toast 侧去重
    const { toolId, toolName, runId } = request;
    toastEvents.publishApprovalPending({ id, toolId, toolName, runId });
  });
}

/** 取消某个 run 名下全部未决审批（每条都会广播 SETTLED）。 */
export function cancelPendingApprovalsForRun(runId: string): void {
  const owned = [...waiters.entries()].filter(([, w]) => w.runId === runId);
  for (const [id] of owned) {
    closeWaiter(id, "cancelled", rejectAsCancelled);
    console.log(TAG, "已取消未决审批:", id, "runId=", runId);
  }
}

// ── IPC ────────────────────────────────────────────────────

export function registerPermissionIpc(ipcOption?: IpcScope): void {
  const scope = ipcOption ?? createIpcScope(ipcMain);

  scope.handle(IPC.PERMISSION_GET_LEVEL, () => ({ level: activeLevel }));

  scope.handle(IPC.PERMISSION_SET_LEVEL, (_event, requested: AgentFileAccessLevel) => {
    if (!isValidLevel(requested)) {
      return { ok: false, error: "无效的档位: " + String(requested) };
    }
    setCurrentLevel(requested);
    return { ok: true, level: activeLevel };
  });

  scope.handle(IPC.PERMISSION_APPROVAL_RESOLVE, (_event, answer: { id: string; allowed: boolean }) => {
    if (!waiters.has(answer?.id)) {
      console.warn(TAG, "收到未知审批的回传:", answer?.id);
      return { ok: false };
    }
    console.log(TAG, "审批回传:", answer.id, answer.allowed ? "同意" : "拒绝");
    closeWaiter(answer.id, "answered", (w) => w.grant(Boolean(answer.allowed)));
    return { ok: true };
  });

  logger.info(LogTag.Permission, "IPC handlers registered");
}

// ── 判定入口 ────────────────────────────────────────────────

type Verdict = ReturnType<typeof policyFor>;

/** 两个判定取更严的一个：deny 优先，其次 ask。 */
function stricter(a: Verdict, b: Verdict): Verdict {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "ask" || b === "ask") return "ask";
  return "allow";
}

export interface PermissionCheckInput {
  signal?: AbortSignal;
  /** 工具调用 / 子 agent 归属，原样带到审批卡片上。 */
  origin?: ApprovalOrigin;
  /** 审批挂在这个 runId 下，run 取消时一并清理。 */
  runId?: string;
  /** 会话创建时记录的档位快照，只会让结果更严。 */
  level?: AgentFileAccessLevel;
  risk: ToolRiskLevel;
  args: Record<string, unknown>;
  toolDescription: string;
  toolName: string;
  toolId: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 按「当前档位」与「会话快照档位」的交集判定一次工具调用：
 * allow 直接放行，ask 走审批，deny 拒绝并给出原因。
 * 会话快照只能收紧，不能放宽全局档位。
 */
export async function checkPermission(input: PermissionCheckInput): Promise<PermissionCheckResult> {
  const { signal, risk } = input;
  if (signal?.aborted) throw createAbortError();
  const global = activeLevel;
  const verdict = stricter(policyFor(global, risk), policyFor(input.level ?? global, risk));
  console.log(TAG, "checkPermission:", input.toolId, "risk=" + risk, "level=" + global, "→", verdict);

  if (verdict === "allow") return { allowed: true };
  if (verdict === "deny") {
    return {
      allowed: false,
      reason: `当前档位「${ACCESS_LEVEL_LABEL[global]}」不允许此操作（risk=${risk}）。请到设置 → 流萤 → 本地文件权限提升档位。`,
    };
  }

  const { toolId, toolName, toolDescription, args, runId } = input;
  const approved = await requestApproval({ toolId, toolName, toolDescription, args, risk, runId, ...input.origin }, signal);
  if (signal?.aborted) throw createAbortError();
  if (!approved) return { allowed: false, reason: "用户拒绝了此次操作。" };

  // 等待期间档位可能被收紧，已批准的审批不能把它放回去
  const nowGlobal = activeLevel;
  if (policyFor(nowGlobal, risk) === "deny" || policyFor(input.level ?? nowGlobal, risk) === "deny") {
    return { allowed: false, reason: "等待审批期间权限已收紧，此次操作未执行。" };
  }
  return { allowed: true };
}
