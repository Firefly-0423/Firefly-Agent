/**
 * 会话轨迹的协议类型定义（CTA 第一阶段）。
 *
 * 本文件只描述 JSONL 条目的结构与校验规则，自身不做任何读写：
 *   信封字段包括 seq / id / at / runId / turnId / revision / roundId；
 *   载荷通过 kind 区分，可取 user、assistant、tool_result、interruption、
 *   turn_rewind、backfill_boundary、compaction_checkpoint 等类型；
 *   assistant 与 tool_result 直接沿用规范的 ChatMessage，
 *   禁止从展示事件或预览内容反推出协议消息。
 */

import type { PendingChatAttachment } from "../../shared/chat-types";
import type { ToolCallOutcome } from "./harness/types";
import type { ChatMessage } from "./vendors/types";

export interface SAssistantBinding {
  runId: string;
  assistantTurnId: string;
  userTurnId: string;
  userRevision: number;
}
export interface SAssistantSettlementBinding extends SAssistantBinding {
  assistantEntryId: string;
}
export type SAssistantSettlementResult = "success" | "interrupted";
export interface SAssistantSettlementPayload {
  binding: SAssistantSettlementBinding;
  result: SAssistantSettlementResult;
  /** Main-owned reason code, never an exception body or model text. */
  safeReason: string;
}
function invalidSBinding(): never { throw Error("TRANSCRIPT_S_BINDING_INVALID"); }
function dataObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== fields.length)
    invalidSBinding();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor))
      invalidSBinding();
    result[field] = descriptor.value;
  }
  return result;
}
function sId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))
    invalidSBinding();
  return value;
}
function sRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    invalidSBinding();
  return value as number;
}
export function copySAssistantBinding(value: unknown): SAssistantBinding {
  const b = dataObject(value, ["runId", "assistantTurnId", "userTurnId", "userRevision"]);
  const result = {
    runId: sId(b.runId), assistantTurnId: sId(b.assistantTurnId),
    userTurnId: sId(b.userTurnId), userRevision: sRevision(b.userRevision),
  };
  if (result.assistantTurnId === result.userTurnId)
    invalidSBinding();
  return result;
}
export function copySAssistantSettlementBinding(value: unknown): SAssistantSettlementBinding {
  const b = dataObject(value, ["runId", "assistantTurnId", "userTurnId", "userRevision", "assistantEntryId"]);
  return {
    ...copySAssistantBinding({
      runId: b.runId, assistantTurnId: b.assistantTurnId,
      userTurnId: b.userTurnId, userRevision: b.userRevision,
    }),
    assistantEntryId: sId(b.assistantEntryId),
  };
}
export function copySAssistantMessage(value: unknown): ChatMessage {
  const m = dataObject(value, ["role", "content"]);
  if (m.role !== "assistant" || typeof m.content !== "string" || !m.content.trim() || Buffer.byteLength(m.content) > 8 * 1024 * 1024)
    invalidSBinding();
  return { role: "assistant", content: m.content };
}
export function copySAssistantSettlementPayload(value: unknown): SAssistantSettlementPayload {
  const p = dataObject(value, ["binding", "result", "safeReason"]);
  if (p.result !== "success" && p.result !== "interrupted")
    invalidSBinding();
  if (typeof p.safeReason !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(p.safeReason))
    invalidSBinding();
  return { binding: copySAssistantSettlementBinding(p.binding), result: p.result, safeReason: p.safeReason };
}

export type TranscriptEnvelopeBase = {
  /** 产生这条记录的 harness 轮次（多轮工具调用时用）。 */
  roundId?: string;
  /** user 条目的修订号：每次编辑递增，首次为 1；replace_user 行沿用此字段记录替换后的修订号。 */
  revision?: number;
  /** userTurnId 或 assistantTurnId。 */
  turnId?: string;
  /** 生成本条记录的 run。 */
  runId?: string;
  at: number;
  /** entryId，同时作为幂等主键。 */
  id: string;
  /** 会话内单调递增的序号，快照与重放依赖它。 */
  seq: number;
};

export type TranscriptUserPayload = {
  attachments?: PendingChatAttachment[];
  text: string;
};

type ToolResultPayload = {
  message: ChatMessage;
  outcome: ToolCallOutcome;
  toolCallId: string;
  assistantEntryId: string;
  fullRef?: string;
  fileRead?: { path: string; canonicalPath: string; sha256: string; startLine: number; endLine: number; totalLines: number };
};

type TurnRewindPayload = {
  replacementUser?: TranscriptUserPayload;
  reason: "edit" | "regenerate";
  disposition: "keep_user" | "replace_user";
  anchorUserTurnId: string;
};

type BackfillPayload = { note: string };
type CompactionPayload = { ref: string };

export type TranscriptEntry =
  | (TranscriptEnvelopeBase & { kind: "user"; payload: TranscriptUserPayload })
  | (TranscriptEnvelopeBase & { kind: "assistant"; payload: ChatMessage; sSettlement?: {version: 1; userTurnId: string; userRevision: number} })
  | (TranscriptEnvelopeBase & { kind: "assistant_settlement"; payload: SAssistantSettlementPayload })
  | (TranscriptEnvelopeBase & { kind: "tool_result"; payload: ToolResultPayload })
  | (TranscriptEnvelopeBase & { kind: "interruption"; payload: { reason: "user_cancel" } })
  | (TranscriptEnvelopeBase & { kind: "turn_rewind"; payload: TurnRewindPayload })
  | (TranscriptEnvelopeBase & { kind: "backfill_boundary"; payload: BackfillPayload })
  | (TranscriptEnvelopeBase & { kind: "compaction_checkpoint"; payload: CompactionPayload });

/** 对联合类型逐成员做 Omit，保留 kind 的判别能力（普通 Omit 会把联合压平）。 */
type OmitPerMember<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 追加入参：不含 seq，seq 由 store 在会话的写队列内分配。 */
export type TranscriptAppendInput = OmitPerMember<TranscriptEntry, "seq">;

export type TranscriptSnapshot = {
  seenUserRevisions: string[];
  seenEntryIds: string[];
  /** 快照覆盖到的 seq：重放时只读取 seq 大于该值的 JSONL 增量。 */
  throughSeq: number;
  entries: TranscriptEntry[];
  schemaVersion: 1;
};

/** user 条目的次级幂等键，由 turnId 与 revision 拼接而成。 */
export function userRevisionKey(turnId: string, revision: number): string {
  return String(turnId) + "\u0000" + String(revision);
}

/** 追加前的协议校验；校验失败直接拒绝，不会进入写队列（失败即关闭）。 */
export function assertValidTranscriptDraft(input: TranscriptAppendInput): void {
  if (input.kind === "assistant" && Object.hasOwn(input, "sSettlement")) {
    const mark = dataObject(input.sSettlement, ["version", "userTurnId", "userRevision"]);
    if (mark.version !== 1) invalidSBinding();
    copySAssistantBinding({
      runId: input.runId, assistantTurnId: input.turnId,
      userTurnId: mark.userTurnId, userRevision: mark.userRevision,
    });
    sId(input.id);
    copySAssistantMessage(input.payload);
    if (input.roundId !== "s-response") invalidSBinding();
  }
  if (input.kind === "assistant_settlement") {
    const p = copySAssistantSettlementPayload(input.payload);
    sId(input.id);
    if (input.runId !== p.binding.runId || input.turnId !== p.binding.assistantTurnId) invalidSBinding();
  }
  if (!input.id || input.id.includes("\n")) throw new Error("TRANSCRIPT_INVALID_ENTRY_ID");
  const badUserRevision = input.kind === "user" && (!input.turnId || !input.revision || input.revision < 1);
  if (badUserRevision) throw new Error("TRANSCRIPT_INVALID_USER_REVISION");
  const replacementMissing = input.kind === "turn_rewind" && input.payload.disposition === "replace_user"
    && (!input.payload.replacementUser || !input.turnId || !input.revision);
  if (replacementMissing) throw new Error("TRANSCRIPT_REPLACEMENT_REQUIRED");
}
