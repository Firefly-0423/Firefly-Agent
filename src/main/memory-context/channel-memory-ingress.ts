import { createHash } from "node:crypto";
import type { ChannelAdapter } from "../channels/adapters/base";
import { getChannelMemoryAccountSignal } from "../channels/adapters/base";
import type { ChannelChatType, ChannelId, IncomingMessage } from "../channels/types";
import { canonicalJson } from "../memory-core/repository-types";
import type { FireflyRunOptions } from "../orchestrator/firefly-agent";
import type { TranscriptSink } from "../orchestrator/transcript-sink";
import type { MainMemoryRun } from "./main-memory-runtime";
import type { MainAttachmentGrant } from "./main-attachment-projection";

declare const ingressBrand: unique symbol;
export type ChannelMemoryIngress = Readonly<{ [ingressBrand]: true }>;
export type ChannelMemoryProvenance = "direct-text" | "quoted-context" | "asr" | "attachment" | "source-less";
export interface ChannelMemoryIngressContext {
  readonly channel: ChannelId;
  readonly accountKey: string;
  readonly accountRevision: number;
  readonly senderId: string;
  readonly chatType: ChannelChatType;
  readonly chatId: string;
  readonly threadId?: string;
  readonly scopeKey: string;
  readonly actorKey: string;
  readonly sessionId: string;
  readonly provenance: ChannelMemoryProvenance;
  readonly signal: AbortSignal;
  readonly text: string;
  assertCurrent(): void;
}
export interface ChannelMemoryPreparedRun {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly transcriptSink: TranscriptSink;
  /** Issued by the authenticated owner from canonical attachment references. */
  readonly attachmentGrant?: MainAttachmentGrant;
  openMemoryRun(options: FireflyRunOptions): Promise<MainMemoryRun>;
  close(): Promise<void>;
}
/** Main composition owns this host and reuses its single canonical store/backend. */
export interface ChannelsMemoryHost {
  prepareRun(input: {
    ingress: ChannelMemoryIngress;
    message: IncomingMessage;
    userText: string;
    modelProfileId: string;
    runId: string;
    userTurnId: string;
    assistantTurnId: string;
    signal?: AbortSignal;
  }): Promise<ChannelMemoryPreparedRun>;
}

const deny = (): never => { throw Error("MEMORY_CHANNEL_INGRESS_DENIED"); };
const caps = new WeakMap<object, { message: IncomingMessage; context: ChannelMemoryIngressContext }>();
const transformations = new WeakMap<object, "asr">();
/** Called only at the authenticated adapter's actual successful conversion boundary.
 * A property in platform JSON, a copied message, or a renderer request is not a mark. */
export function markChannelTextTransform(message: IncomingMessage, kind: "asr"): void {
  if (!message || typeof message !== "object" || kind !== "asr") deny();
  transformations.set(message, kind);
}
function messageFingerprint(message: IncomingMessage): string {
  return canonicalJson({ channel: message.channel, senderId: message.senderId, senderName: message.senderName ?? null,
    chatType: message.chatType ?? "private", chatId: message.chatId, threadId: message.threadId ?? null,
    messageId: message.messageId ?? null, text: message.text, at: message.at.getTime(),
    attachments: message.attachments ?? [], reply: message.reply ?? null, mentions: message.mentions ?? [] });
}
export function requireChannelMemoryIngress(value: unknown, message?: IncomingMessage): Readonly<ChannelMemoryIngressContext> {
  const record = value && typeof value === "object" ? caps.get(value) : undefined;
  if (!record || message !== undefined && record.message !== message) return deny();
  record.context.assertCurrent();
  return record.context;
}

/** The manager keeps this issuer private and calls it only from the registered
 * adapter's own handler closure. Looking up an adapter never creates a grant. */
export function createChannelMemoryIngressIssuer(options: { isCurrent(adapter: ChannelAdapter, lifetime: AbortSignal): boolean }) {
  return Object.freeze({
    capture(adapter: ChannelAdapter, message: IncomingMessage, lifetime: AbortSignal): ChannelMemoryIngress | undefined {
      try {
        const account = adapter.getMemoryAccountIdentity?.(), accountSignal = getChannelMemoryAccountSignal(account);
        if (!account || !accountSignal || lifetime.aborted || accountSignal.aborted || !options.isCurrent(adapter, lifetime)
          || message.channel !== adapter.id || !["private", "group"].includes(message.chatType ?? "private")
          || ![account.accountKey, message.senderId, message.chatId].every(value => typeof value === "string" && value.trim() && value.length <= 4096)
          || message.threadId !== undefined && (typeof message.threadId !== "string" || !message.threadId.trim())
          || typeof message.text !== "string" || !(message.at instanceof Date) || !Number.isSafeInteger(message.at.getTime())) return undefined;
        const fingerprint = messageFingerprint(message), channel = adapter.id, chatType = message.chatType ?? "private";
        const tuple = canonicalJson([account.accountKey, channel, message.senderId, chatType, message.chatId, message.threadId ?? null]);
        const hash = createHash("sha256").update(tuple).digest("hex"), signal = AbortSignal.any([lifetime, accountSignal]);
        const provenance: ChannelMemoryProvenance = message.attachments?.length ? "attachment" : message.reply?.text ? "quoted-context"
          : transformations.get(message) ?? (message.text.trim() ? "direct-text" : "source-less");
        const context: ChannelMemoryIngressContext = Object.freeze({ channel, accountKey: account.accountKey, accountRevision: account.revision,
          senderId: message.senderId, chatType, chatId: message.chatId, ...(message.threadId ? { threadId: message.threadId } : {}),
          scopeKey: `channel-scope-${hash}`, actorKey: `channel-actor-${hash}`, sessionId: `channel-session-${hash}`,
          provenance, signal, text: message.text,
          assertCurrent() {
            if (signal.aborted || !options.isCurrent(adapter, lifetime) || adapter.getMemoryAccountIdentity?.() !== account
              || getChannelMemoryAccountSignal(account) !== accountSignal || messageFingerprint(message) !== fingerprint) return deny();
          },
        });
        context.assertCurrent();
        const cap = Object.freeze({}) as ChannelMemoryIngress; caps.set(cap, { message, context }); return cap;
      } catch { return undefined; }
    },
  });
}
