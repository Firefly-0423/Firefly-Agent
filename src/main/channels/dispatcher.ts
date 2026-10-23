import type { IncomingMessage, OutgoingMessage } from "./types";
import type { ChannelsSettings } from "./settings-store";
import type { FireflyRunTerminalResult } from "../../shared/run-terminal";
import { appendLog } from "./message-log";
import { requireChannelMemoryIngress, type ChannelMemoryIngress } from "../memory-context/channel-memory-ingress";
import { rememberProactiveChannelRecipient } from "./proactive-delivery";
import type { ChannelRateLimiter } from "./rate-limiter";
import type { KeyedQueue } from "./keyed-queue";
import type { ChannelDeliveryService } from "./delivery-service";
import type { OutgoingComposer } from "./outgoing-composer";
import { makeSessionId, type ChannelContext, type ChatMessage, type DispatchContext } from "./channel-context";
export { formatChannelUserText, lookupOriginalSender, makeSessionId } from "./channel-context";
export type { BoundConversationMessageMetadata, ChatMessage, DispatchContext } from "./channel-context";

export type ChannelAgentResult = { terminal?: FireflyRunTerminalResult; sticker: string | null; text: string };
export interface DispatcherDeps {
  readonly broadcastChat?: (event: { type: "bot:incoming" | "bot:outgoing"; channel: string; senderId: string; senderName?: string; chatId: string; text: string; at: number }) => void;
  readonly observeExternalChat?: (sessionId: string, msg: IncomingMessage) => void;
  readonly loadSettings: () => ChannelsSettings;
  readonly buildAndRunAgent: (msg: IncomingMessage, sessionId: string, priorMessages?: ChatMessage[], ingress?: ChannelMemoryIngress) => Promise<ChannelAgentResult>;
  readonly delivery: ChannelDeliveryService;
  readonly composer: OutgoingComposer;
  readonly context: ChannelContext;
  readonly limiter: ChannelRateLimiter;
  readonly queue: KeyedQueue;
  readonly memoryEnabled?: boolean;
}
function terminalReply(content: string, outcome?: FireflyRunTerminalResult): string {
  const status = outcome?.status ?? "success";
  const notices = {
    success: "", timeout: "[timeout] 本次执行已超时，本进程已停止本次处理。",
    cancelled: "[cancelled] 本次执行已取消，本进程已停止本次处理。",
    runtime_error: "[runtime_error] 本次执行失败，未能完整完成。",
  };
  const effects = outcome?.externalEffectsMayContinue ? "外部操作可能仍在继续，已发生的效果不会自动撤回。" : "";
  const partial = status !== "success" && content.trim() ? "[部分输出，未完整完成]" : "";
  return [notices[status], effects, partial, content].filter(Boolean).join("\n\n");
}

export class ChannelDispatcher {
  private cached: ChannelsSettings | null = null;
  constructor(private readonly deps: DispatcherDeps) {}
  private get settings(): ChannelsSettings {
    if (!this.cached) {
      this.cached = this.deps.loadSettings();
      this.deps.limiter.reconfigure({ perUser: this.cached.rateLimitPerUser, perChannel: this.cached.rateLimitPerChannel });
    }
    return this.cached;
  }
  reloadSettings(): void { this.cached = null; void this.settings; }
  async handleIncoming(msg: IncomingMessage, ingress?: ChannelMemoryIngress): Promise<OutgoingMessage | null> {
    if (this.deps.memoryEnabled && !ingress) return null;
    const authority = ingress ? requireChannelMemoryIngress(ingress, msg) : undefined;
    const identifier = authority?.sessionId ?? makeSessionId(msg.channel, msg.chatId);
    void this.settings;
    return this.deps.queue.run(`external:${identifier}`, async () => {
      if (!this.deps.limiter.tryConsume(msg.channel, msg.senderId)) {
        console.warn("[ChannelDispatcher]", `限速: ${msg.channel}:${msg.senderId}`);
        return null;
      }
      try { this.deps.observeExternalChat?.(identifier, msg); }
      catch (failure) { console.warn("[ChannelDispatcher]", "observeExternalChat 失败（继续处理消息）:", failure); }
      const snapshot = this.deps.context.resolveDispatchContext(identifier);
      const execute = () => this.processIncoming(msg, snapshot, ingress);
      return snapshot.boundConversationId ? this.deps.queue.run(`conversation:${snapshot.boundConversationId}`, execute) : execute();
    });
  }
  private async processIncoming(msg: IncomingMessage, context: DispatchContext, ingress?: ChannelMemoryIngress): Promise<OutgoingMessage | null> {
    const identifier = context.sessionId;
    this.deps.context.recordIncomingSession(msg, context);
    rememberProactiveChannelRecipient(msg, identifier);
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({ type: "bot:incoming", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: msg.text, at: msg.at.getTime() });
      } catch (failure) { console.warn("[ChannelDispatcher]", "broadcastChat (incoming) 失败:", failure); }
    }
    try {
      appendLog({ dir: "incoming", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: msg.text, hasAttachments: (msg.attachments?.length ?? 0) > 0 });
    } catch (failure) { console.warn("[ChannelDispatcher]", "appendLog (incoming) 失败:", failure); }
    const history = this.deps.memoryEnabled ? [] : await this.deps.context.resolvePriorMessages(context, 16);
    await this.deps.context.appendIncomingContext(msg, context);
    let content: string;
    let decoration: string | null;
    let outcome: FireflyRunTerminalResult | undefined;
    try {
      if (ingress) requireChannelMemoryIngress(ingress, msg);
      const generated = ingress ? await this.deps.buildAndRunAgent(msg, identifier, history, ingress) : await this.deps.buildAndRunAgent(msg, identifier, history);
      if (ingress) requireChannelMemoryIngress(ingress, msg);
      content = generated.text;
      decoration = generated.sticker;
      outcome = generated.terminal;
    } catch (failure) {
      const diagnostic = failure instanceof Error ? failure.message : String(failure);
      console.error("[ChannelDispatcher]", "agent 调用失败:", diagnostic);
      try {
        appendLog({ dir: "error", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: `[agent 调用失败] ${diagnostic}` });
      } catch (logFailure) { console.warn("[ChannelDispatcher]", "appendLog (error) 失败:", logFailure); }
      if (ingress) { try { requireChannelMemoryIngress(ingress, msg); } catch { return null; } }
      content = "";
      decoration = null;
      outcome = { status: "runtime_error", externalEffectsMayContinue: true };
    }
    const response = await this.deps.composer.compose({ incoming: msg, replyText: terminalReply(content, outcome), sticker: outcome && outcome.status !== "success" ? null : decoration, settings: { stickerEnabled: this.settings.stickerEnabled } });
    try {
      if (ingress) requireChannelMemoryIngress(ingress, msg);
      const receipt = await this.deps.delivery.send(response.message);
      if (!receipt.ok) {
        console.warn("[ChannelDispatcher]", `发送失败 [${msg.channel}]:`, receipt.error);
        try {
          appendLog({ dir: "error", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: `[发送失败] ${receipt.error}` });
        } catch (failure) { console.warn("[ChannelDispatcher]", "appendLog (delivery error) 失败:", failure); }
        return null;
      }
      if (this.settings.mirrorToDesktop) {
        try {
          this.deps.broadcastChat?.({ type: "bot:outgoing", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: response.assistantText, at: Date.now() });
        } catch (failure) { console.warn("[ChannelDispatcher]", "broadcastChat (outgoing) 失败:", failure); }
      }
      try {
        appendLog({ dir: "outgoing", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: response.assistantText, hasAttachments: response.message.parts.some((fragment) => fragment.kind === "audio") });
      } catch (failure) { console.warn("[ChannelDispatcher]", "appendLog (outgoing) 失败:", failure); }
      if (!outcome || outcome.status === "success") await this.deps.context.appendAssistantContext(msg, context, response);
      return response.message;
    } finally {
      try { await this.deps.composer.cleanupTransientFiles(response.transientFiles); }
      catch (failure) { console.warn("[ChannelDispatcher]", "清理出站临时文件失败:", failure); }
    }
  }
}
