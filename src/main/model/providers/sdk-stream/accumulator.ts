import type { ToolCall, ChatResponse } from "../types";
import { ProviderProtocolError, type UnifiedStreamDelta, type StreamAccumulatorSnapshot } from "./types";

type PendingCall = { ended: boolean; arguments: string; name: string; id?: string; index: number };
export class FireflyStreamAccumulator {
  private visible = "";
  private reasoning = "";
  private readonly pending = new Map<number, PendingCall>();
  private terminal: string | undefined;
  private refusalText: string | undefined;
  private tokensIn: number | undefined;
  private tokensOut: number | undefined;
  private cacheHits: number | undefined;
  private cacheWrites: number | undefined;

  apply(delta: UnifiedStreamDelta): void {
    if (delta.type === "text_delta") this.visible += delta.delta;
    else if (delta.type === "reasoning_delta") this.reasoning += delta.delta;
    else if (delta.type === "finish") this.terminal = delta.reason;
    else if (delta.type === "refusal") this.refusalText = delta.reason;
    else if (delta.type === "usage") {
      if (delta.inputTokens !== undefined) this.tokensIn = delta.inputTokens;
      if (delta.outputTokens !== undefined) this.tokensOut = delta.outputTokens;
      if (delta.cachedInputTokens !== undefined) this.cacheHits = delta.cachedInputTokens;
      if (delta.cacheCreationTokens !== undefined) this.cacheWrites = delta.cacheCreationTokens;
    } else if (delta.type === "tool_call_start" || delta.type === "tool_call_arguments_delta" || delta.type === "tool_call_end") {
      const call = this.slot(delta.index);
      this.identify(call, delta.id);
      if (delta.type === "tool_call_start") call.name += delta.nameDelta ?? "";
      else if (delta.type === "tool_call_arguments_delta") call.arguments += delta.delta;
      else if (delta.type === "tool_call_end") call.ended = true;
    }
  }
  private usageFields(): { usage?: NonNullable<ChatResponse["usage"]> } {
    if (this.tokensIn === undefined && this.tokensOut === undefined && this.cacheHits === undefined && this.cacheWrites === undefined) return {};
    return { usage: {
      input: this.tokensIn ?? 0, output: this.tokensOut ?? 0,
      ...(this.cacheHits !== undefined ? { cachedInput: this.cacheHits } : {}),
      ...(this.cacheWrites !== undefined ? { cacheCreation: this.cacheWrites } : {}),
    } };
  }
  snapshot(): StreamAccumulatorSnapshot {
    return {
      text: this.visible, ...(this.reasoning ? { thinking: this.reasoning } : {}),
      toolCalls: this.inOrder().map((entry) => ({ ...entry })),
      ...(this.terminal !== undefined ? { finishReason: this.terminal } : {}),
      ...(this.refusalText !== undefined ? { refusal: this.refusalText } : {}),
      ...this.usageFields(),
    };
  }
  finalize(raw: unknown): ChatResponse {
    const calls = this.inOrder().map((entry) => this.complete(entry));
    const message = {
      role: "assistant" as const, content: this.visible,
      ...(this.reasoning ? { thinking: this.reasoning } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    };
    return {
      assistantMessage: message, text: this.visible,
      ...(this.reasoning ? { thinking: this.reasoning } : {}),
      ...(this.refusalText !== undefined ? { refusal: this.refusalText } : {}),
      toolCalls: calls, finishReason: this.terminal ?? "unknown", raw, ...this.usageFields(),
    };
  }
  private slot(position: number): PendingCall {
    const known = this.pending.get(position);
    if (known) return known;
    const empty: PendingCall = { index: position, name: "", arguments: "", ended: false };
    this.pending.set(position, empty);
    return empty;
  }
  private identify(call: PendingCall, incoming: string | undefined): void {
    if (!incoming) return;
    if (!call.id) call.id = incoming;
    else if (call.id !== incoming) throw new ProviderProtocolError("E_TOOL_CALL_ID_CHANGED",
      `Tool call at index ${call.index} changed id from ${call.id} to ${incoming}`);
  }
  private inOrder(): PendingCall[] {
    return Array.from(this.pending.values()).sort((a, b) => a.index - b.index);
  }
  private complete(call: PendingCall): ToolCall {
    if (!call.ended || !call.id || !call.name.trim()) throw new ProviderProtocolError("E_TOOL_CALL_INCOMPLETE",
      `Tool call at index ${call.index} is missing its terminal marker, id, or name`);
    try { JSON.parse(call.arguments); }
    catch (cause) {
      throw new ProviderProtocolError("E_TOOL_CALL_INCOMPLETE",
        `Tool call at index ${call.index} has incomplete JSON arguments: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return { id: call.id, name: call.name, arguments: call.arguments };
  }
}
