import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { OneBotResponse, OneBotStreamPacket } from "./onebot-types";

type PendingAction = {
  packetError?: Error;
  terminalReceived: boolean;
  packetChain: Promise<void>;
  onPacket?: (packet: OneBotStreamPacket) => void | Promise<void>;
  timer: NodeJS.Timeout;
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
  mode: "single" | "stream";
};
export class OneBotActionError extends Error {
  constructor(message: string, readonly retcode?: number) {
    super(message);
    this.name = "OneBotActionError";
  }
}
export class OneBotActionClient {
  private requests = new Map<string, PendingAction>();
  constructor(private readonly socket: WebSocket, private readonly normalTimeoutMs = 30_000, private readonly streamTimeoutMs = 10 * 60_000) {}

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = this.normalTimeoutMs): Promise<T> {
    return this.sendRequest<T>(action, params, "single", timeoutMs);
  }
  callStream<T = OneBotStreamPacket>(action: string, params: Record<string, unknown>, onPacket: (packet: OneBotStreamPacket) => void | Promise<void>, timeoutMs = this.streamTimeoutMs): Promise<T> {
    return this.sendRequest<T>(action, params, "stream", timeoutMs, onPacket);
  }
  handleResponse(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const reply = value as OneBotResponse<unknown>;
    if (typeof reply.echo !== "string") return false;
    const request = this.requests.get(reply.echo);
    if (!request) return false;
    if (reply.status === "failed" || reply.retcode !== 0) {
      this.finish(reply.echo);
      request.reject(new OneBotActionError(reply.wording || reply.message || `OneBot action failed (${reply.retcode})`, reply.retcode));
      return true;
    }
    if (request.mode === "single") {
      this.finish(reply.echo);
      request.resolve(reply.data);
      return true;
    }
    if (request.terminalReceived) return true;
    const frame = reply.data as OneBotStreamPacket;
    request.packetChain = request.packetChain.then(() => request.onPacket?.(frame)).catch((failure) => {
      request.packetError ??= failure instanceof Error ? failure : new Error(String(failure));
    });
    const finalResponse = frame?.type === "response";
    if (finalResponse || frame?.type === "error" || frame?.type === "reset") {
      request.terminalReceived = true;
      void request.packetChain.then(() => {
        this.finish(reply.echo!);
        if (request.packetError) request.reject(request.packetError);
        else if (finalResponse) request.resolve(frame);
        else request.reject(new OneBotActionError(`OneBot stream ${frame.type}`));
      });
    }
    return true;
  }
  rejectAll(reason = "OneBot connection closed"): void {
    for (const [identifier, request] of this.requests.entries()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
      this.requests.delete(identifier);
    }
  }
  get pendingCount(): number { return this.requests.size; }

  private finish(identifier: string): void {
    const request = this.requests.get(identifier);
    if (request) {
      clearTimeout(request.timer);
      this.requests.delete(identifier);
    }
  }
  private sendRequest<T>(action: string, params: Record<string, unknown>, mode: PendingAction["mode"], timeoutMs: number, onPacket?: PendingAction["onPacket"]): Promise<T> {
    if (this.socket.readyState !== 1) return Promise.reject(new Error("OneBot WebSocket is not open"));
    const identifier = randomUUID();
    return new Promise<T>((accept, fail) => {
      const deadline = setTimeout(() => {
        this.requests.delete(identifier);
        fail(new Error(`OneBot action timeout: ${action}`));
      }, timeoutMs);
      this.requests.set(identifier, {
        mode, resolve: accept as (value: unknown) => void, reject: fail, timer: deadline,
        onPacket, packetChain: Promise.resolve(), terminalReceived: false,
      });
      try { this.socket.send(JSON.stringify({ action, params, echo: identifier })); }
      catch (failure) {
        this.finish(identifier);
        fail(failure instanceof Error ? failure : new Error(String(failure)));
      }
    });
  }
}
