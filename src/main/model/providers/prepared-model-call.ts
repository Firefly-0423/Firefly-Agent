import {requestProviderIdentity} from "./request-provider-identity";
import { createHash } from "node:crypto";
import { Agent, type Dispatcher } from "undici";
import { contextFail, type JsonValue, type PreparedRequest, type RequestIdentity } from "../../memory/context/context-contracts";
import { AgentRuntimeError } from "../errors/agent-runtime-error";
import { connectionLost } from "./connection-lost";
import { copyResponseJson } from "./response-request-snapshot";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { streamPreparedChatWithSdk, type SdkStreamRunInput } from "./sdk-stream/runtime";
import type { UnifiedStreamDelta } from "./sdk-stream/types";
import type { ChatRequest, ChatResponse, ChatVendorAdapter, Transport, VendorConfig } from "./types";

/** Main-only counting view. Authentication headers and credentials never enter this object. */
export type PreparedModelCall = Readonly<{
  request: PreparedRequest;
  endpoint: string;
  serializedBody: string;
}>;
export interface PreparedModelCallInput {
  prepared: PreparedModelCall;
  config: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Main final network gate, invoked only after actual SDK bytes are checked. It runs again before every
   * retry of a dropped connection (attempt > 0), so a retry is admitted under the same checks as the first send.
   */
  guardSend?: (send:()=>Promise<Response>, attempt:number)=>Promise<Response>;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  onDiagnostic?: SdkStreamRunInput["onDiagnostic"];
  onModelExecution?: (phase: "start" | "end", terminal?: "completed" | "failed" | "cancelled") => void;
  /** Silence limits; tests shorten them. Defaults are MODEL_IDLE_DEFAULTS. */
  idle?: Readonly<{ headersMs: number; bodyMs: number }>;
}
/**
 * How long a model request may stay silent. A provider that never answers, or a stream that stops sending
 * bytes, otherwise held the run until the total request limit (10 minutes). Reasoning models stream their
 * thinking or keep-alive bytes, and any byte resets the body limit.
 */
export const MODEL_IDLE_DEFAULTS = Object.freeze({ headersMs: 120_000, bodyMs: 300_000 });
const IDLE_REASON = "Model stream idle";
export interface PreparedModelCallOptions {
  /** Main supplies the live grant/profile revision check. Never serialized into the counting frame. */
  validateCurrent?: () => void;
  /** Trusted Main run policy; captured privately and never read from the dispatch DTO or prompt. */
  persistDiagnostics?: boolean;
}
interface PrivateCall {
  adapter: ChatVendorAdapter;
  config: VendorConfig;
  sourceConfig: VendorConfig;
  headers: Record<string, string>;
  fingerprint: string;
  runtimeFingerprint: string;
  adapterFingerprint: string;
  buildRequest: ChatVendorAdapter["buildRequest"];
  buildStreamRequest: ChatVendorAdapter["buildStreamRequest"];
  parseResponse: ChatVendorAdapter["parseResponse"];
  validateCurrent?: () => void;
  persistDiagnostics: boolean;
  consumed: boolean;
}
const calls = new WeakMap<PreparedModelCall, PrivateCall>();
const changed = (): never => contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
const unsupported = (): never => contextFail("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
const copy = <T>(value: T): T => copyResponseJson(value, true, unsupported);
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(copy(value))).digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function adapterFingerprint(adapter: ChatVendorAdapter): string {
  return fingerprint({ id: adapter.id, transport: adapter.transport, capability: adapter.capability });
}
function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
function check(call: PrivateCall, config: VendorConfig, signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled(signal);
  call.validateCurrent?.();
  try {
    if (fingerprint(call.sourceConfig) !== call.fingerprint
      || fingerprint(config) !== call.fingerprint
      || fingerprint(getVendorRuntimeSettings()) !== call.runtimeFingerprint
      || adapterFingerprint(call.adapter) !== call.adapterFingerprint
      || call.adapter.buildRequest !== call.buildRequest
      || call.adapter.buildStreamRequest !== call.buildStreamRequest
      || call.adapter.parseResponse !== call.parseResponse) changed();
  } catch { changed(); }
  if (signal?.aborted) throw cancelled(signal);
}

/** Inspect only protocol input positions: a schema property named `type` is not a content block. */
function inputTypes(body: Record<string, unknown>, transport: Transport): string[] {
  const found = new Set<string>(["text"]);
  if (Array.isArray(body.tools) && body.tools.length) found.add("function-tools");
  const blocks = (value: unknown): void => {
    if (value === undefined || value === null || typeof value === "string") return;
    if (!Array.isArray(value)) unsupported();
    for (const item of value as unknown[]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) unsupported();
      const block = item as Record<string, unknown>;
      switch (block.type) {
        case "text": case "input_text": case "output_text": case "refusal":
        case "thinking": case "redacted_thinking": case "reasoning": case "reasoning_details": break;
        case "image": case "image_url": case "input_image": found.add("image"); break;
        case "tool_use": found.add("function-tools"); break;
        case "tool_result": found.add("function-tools"); blocks(block.content); break;
        default: unsupported();
      }
    }
  };
  if (transport === "responses") {
    if (typeof body.input === "string") return [...found];
    if (!Array.isArray(body.input)) unsupported();
    for (const item of body.input as Record<string, unknown>[]) {
      if (item.type === "function_call") found.add("function-tools");
      else if (item.type === "function_call_output") { found.add("function-tools"); blocks(item.output); }
      else if (item.type === "reasoning") continue;
      else if (item.type === "message" || item.type === undefined && typeof item.role === "string") blocks(item.content);
      else unsupported();
    }
  } else {
    if (!Array.isArray(body.messages)) unsupported();
    for (const message of body.messages as Record<string, unknown>[]) {
      blocks(message.content);
      if (message.role === "tool" || Array.isArray(message.tool_calls) && message.tool_calls.length) found.add("function-tools");
    }
  }
  return ["text", "function-tools", "image"].filter(type => found.has(type));
}

/** Prepare exactly once, after prompt layers/cache hints. No credential lookup or model call occurs here. */
export function prepareModelCall(
  adapter: ChatVendorAdapter,
  request: ChatRequest,
  config: VendorConfig,
  identity: RequestIdentity,
  options: PreparedModelCallOptions = {},
): PreparedModelCall {
  options.validateCurrent?.();
  const detached = copy(request), detachedConfig = copy(config), detachedIdentity = copy(identity);
  if (detached.model !== detachedConfig.model || detachedIdentity.model !== detached.model
    || (detachedIdentity.providerId !== adapter.id && detachedIdentity.providerId !== requestProviderIdentity(detachedConfig.baseUrl)) || detachedIdentity.transport !== adapter.transport
    || Object.keys(detachedIdentity).some(key => !["providerId", "model", "transport", "framingVersion"].includes(key))
    || Object.values(detachedIdentity).some(value => typeof value !== "string" || !value || value.length > 1024)
    || !detachedIdentity.framingVersion) unsupported();
  const privateCall: PrivateCall = {
    adapter, config: freeze(detachedConfig), sourceConfig: config, headers: {}, fingerprint: fingerprint(config),
    runtimeFingerprint: fingerprint(getVendorRuntimeSettings()), adapterFingerprint: adapterFingerprint(adapter),
    buildRequest: adapter.buildRequest, buildStreamRequest: adapter.buildStreamRequest, parseResponse: adapter.parseResponse,
    validateCurrent: options.validateCurrent, persistDiagnostics: options.persistDiagnostics !== false, consumed: false,
  };
  const http = detached.stream === false
    ? adapter.buildRequest(detached, detachedConfig)
    : adapter.buildStreamRequest({ ...detached, stream: true }, detachedConfig);
  const endpoint = new URL(http.url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) unsupported();
  const body: unknown = JSON.parse(http.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) unsupported();
  // Snapshot validation must not reorder the actual serializer bytes.
  copy(body);
  const wire = body as Record<string, JsonValue>;
  if (wire.model !== detached.model || wire.stream !== (detached.stream !== false)) unsupported();
  if (JSON.stringify(wire) !== http.body) unsupported();
  const outputBounds = ["max_tokens", "max_output_tokens", "max_completion_tokens"]
    .flatMap(key => wire[key] === undefined ? [] : [wire[key]]);
  if (outputBounds.some(value => !Number.isSafeInteger(value) || (value as number) < 0)) unsupported();
  const prepared: PreparedModelCall = freeze({
    request: { ...detachedIdentity, body: wire, inputTypes: inputTypes(wire, adapter.transport),
      ...(outputBounds.length ? { maxOutputTokens: Math.max(...outputBounds as number[]) } : {}) },
    endpoint: endpoint.href, serializedBody: http.body,
  });
  privateCall.headers = freeze(copy(http.headers));
  check(privateCall, config);
  calls.set(prepared, privateCall);
  return prepared;
}

/** Delays before each retry of a model request whose connection was lost before any response arrived. */
const CONNECTION_RETRY_DELAYS_MS = [1_000, 3_000];
/**
 * Provider answers that only say "not now": rate limited (429), a gateway or upstream that is briefly unavailable
 * (502/503/504), and Anthropic's overloaded (529). Nothing was generated, so the same request is sent again, at most
 * twice like a dropped connection. 500 and every 4xx other than 429 are real failures and are reported at once.
 */
const TEMPORARY_PROVIDER_STATUSES = new Set([429, 502, 503, 504, 529]);
const PROVIDER_RETRY_DELAYS_MS = [2_000, 6_000];
const PROVIDER_RETRY_MAX_WAIT_MS = 20_000;

/** How long to wait before retry `attempt` (0-based): the provider's Retry-After (seconds or a date) when given, capped. */
export function providerRetryDelayMs(attempt: number, retryAfter: string | null, now = Date.now()): number {
  const fallback = PROVIDER_RETRY_DELAYS_MS[Math.min(attempt, PROVIDER_RETRY_DELAYS_MS.length - 1)]!;
  const text = retryAfter?.trim();
  if (!text) return fallback;
  const asked = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(asked)) return fallback;
  return Math.min(Math.max(0, Math.round(asked)), PROVIDER_RETRY_MAX_WAIT_MS);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
let modelPool: Agent | undefined;
/** Where Node's fetch and the undici package keep a dispatcher installed with setGlobalDispatcher. */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
/**
 * One pool for model requests that keeps an idle connection for 20 s (providers close idle ones at about
 * 30 s). Node's default of 4 s closed it during every tool round, so each round paid a new TLS handshake,
 * which on an unstable network or behind a proxy is where requests failed. Node fills the slot itself with
 * a plain Agent the first time anything builds a Request, so a plain Agent there is that default and is
 * replaced; any other dispatcher (a proxy, a test mock) was installed on purpose and still wins.
 * Reading the slot never installs one.
 */
function modelConnectionPool(): Dispatcher {
  const installed = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] as Dispatcher | undefined;
  if (installed && installed.constructor.name !== "Agent") return installed;
  return modelPool ??= new Agent({ keepAliveTimeout: 20_000, keepAliveMaxTimeout: 20_000 });
}
/** Must be called by Main's context.dispatch single-use permit callback; it grants no memory authority itself. */
export async function dispatchPreparedModelCall(input: PreparedModelCallInput): Promise<ChatResponse> {
  input = { ...input };
  const call = calls.get(input.prepared) ?? changed();
  if (call.consumed) changed();
  check(call, input.config, input.signal);
  call.consumed = true;
  let started = false;
  let dispatched = false;
  let terminal: "completed" | "failed" | "cancelled" = "failed";
  let boundaryError: unknown;
  let idleExpired = false;
  const limits = input.idle ?? MODEL_IDLE_DEFAULTS;
  const delegate = globalThis.fetch;
  const observe = (phase: "start" | "end", result?: typeof terminal): void => {
    try {
      // TypeScript permits async callbacks where a void callback is expected.
      void Promise.resolve(input.onModelExecution?.(phase, result)).catch(() => {});
    } catch { /* Observability cannot alter dispatch/settlement. */ }
  };
  const guardedFetch: typeof fetch = async (source, init) => {
    try {
      // A redirect must not forward the prompt outside the authenticated endpoint.
      const outgoing = new Request(source, { ...init, redirect: "error" });
      // SDK defaults assume protocol-specific auth. The existing adapter owns the
      // actual endpoint auth policy (including x-api-key on OpenAI-compatible APIs).
      outgoing.headers.delete("authorization");
      outgoing.headers.delete("x-api-key");
      for (const [name, value] of Object.entries(call.headers)) outgoing.headers.set(name, value);
      if (started || outgoing.method !== "POST" || outgoing.url !== input.prepared.endpoint
        || await outgoing.clone().text() !== input.prepared.serializedBody) changed();
      check(call, input.config, input.signal);
      if (outgoing.signal.aborted) throw cancelled(outgoing.signal);
      const invoke=()=>{
        if(started)changed();
        check(call,input.config,input.signal);
        if(outgoing.signal.aborted)throw cancelled(outgoing.signal);
        started=true;observe("start");
        check(call,input.config,input.signal);
        if(outgoing.signal.aborted)throw cancelled(outgoing.signal);
        dispatched=true;
        return attemptOnce(outgoing);
      };
      // Node's RequestInit types lag the undici package; the dispatcher option is the same at runtime.
      // Each attempt has its own silence watchdog: headers must arrive within headersMs, and once the body
      // streams, every chunk restarts bodyMs. Silence aborts only this attempt's connection.
      const attemptOnce=async(request:Request)=>{
        const watchdog=new AbortController();
        let timer:ReturnType<typeof setTimeout>|undefined;
        const arm=(ms:number)=>{ clearTimeout(timer); timer=setTimeout(()=>{ idleExpired=true; watchdog.abort(new DOMException(IDLE_REASON,"TimeoutError")); },ms); };
        const watched=new Request(request,{signal:AbortSignal.any([request.signal,watchdog.signal])});
        arm(limits.headersMs);
        let response:Response;
        try{ response=await delegate(watched,{dispatcher:modelConnectionPool()} as unknown as RequestInit); }
        catch(error){ clearTimeout(timer); throw error; }
        idleExpired=false;
        if(!response.body){ clearTimeout(timer); return response; }
        arm(limits.bodyMs);
        const reader=response.body.getReader();
        // One rejection per response, not one abort listener per chunk (long replies piled them up).
        const silenced=new Promise<never>((_resolve,reject)=>{
          if(watchdog.signal.aborted)reject(watchdog.signal.reason);
          else watchdog.signal.addEventListener("abort",()=>reject(watchdog.signal.reason),{once:true});
        });
        silenced.catch(()=>{});
        const body=new ReadableStream<Uint8Array>({
          async pull(controller){
            try{
              const next=await Promise.race([reader.read(),silenced]);
              if(next.done){ clearTimeout(timer); controller.close(); return; }
              arm(limits.bodyMs);
              controller.enqueue(next.value);
            }catch(error){ clearTimeout(timer); void reader.cancel(error).catch(()=>{}); controller.error(error); }
          },
          cancel(reason){ clearTimeout(timer); return reader.cancel(reason); },
        });
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      };
      // A model call has no side effect outside the provider, so a request whose connection dropped before
      // any response is sent again (twice at most); once a response has started it is never replayed.
      // Each retry passes the send gate again, so memory forgotten during the wait is never sent.
      const spares=CONNECTION_RETRY_DELAYS_MS.map(()=>outgoing.clone());
      const gate=(run:()=>Promise<Response>,attempt:number)=>input.guardSend?input.guardSend(run,attempt):run();
      for(let attempt=0;;attempt++){
        try{
          const answered=await gate(attempt===0?invoke:()=>{
            check(call,input.config,input.signal);
            if(outgoing.signal.aborted)throw cancelled(outgoing.signal);
            return attemptOnce(spares[attempt-1]);
          },attempt);
          if(!TEMPORARY_PROVIDER_STATUSES.has(answered.status)||attempt>=spares.length||outgoing.signal.aborted)return answered;
          const wait=providerRetryDelayMs(attempt,answered.headers.get("retry-after"));
          await answered.body?.cancel().catch(()=>undefined);
          await pause(wait,outgoing.signal);
          check(call,input.config,input.signal);
          if(outgoing.signal.aborted)throw cancelled(outgoing.signal);
          continue;
        }catch(error){
          // A provider that never started answering is treated like a dropped connection: nothing was shown yet.
          if(attempt>=spares.length||!(connectionLost(error)||idleExpired)||outgoing.signal.aborted)throw error;
          idleExpired=false;
          await new Promise(resolve=>setTimeout(resolve,CONNECTION_RETRY_DELAYS_MS[attempt]));
          check(call,input.config,input.signal);
          if(outgoing.signal.aborted)throw cancelled(outgoing.signal);
        }
      }
    } catch (error) {
      boundaryError = error;
      throw error;
    }
  };
  try {
    const response = input.prepared.request.body.stream === true
      ? await streamPreparedChatWithSdk({
        adapter: call.adapter, config: call.config, model: input.prepared.request.model,
        prepared: { endpoint: input.prepared.endpoint, body: input.prepared.request.body },
        fetch: guardedFetch, timeoutMs: input.timeoutMs, signal: input.signal, onDelta: input.onDelta, onDiagnostic: input.onDiagnostic,
        persistDiagnostics: call.persistDiagnostics,
      })
      : await nonStreaming(input, call, guardedFetch);
    if (input.signal?.aborted) throw cancelled(input.signal);
    terminal = "completed";
    return response;
  } catch (error) {
    if (input.signal?.aborted) { terminal = "cancelled"; throw cancelled(input.signal); }
    // SDKs wrap custom-fetch errors. Restore a boundary rejection without changing provider errors.
    if (error instanceof AgentRuntimeError && error.code === "E_MODEL_REQUEST_TIMEOUT") throw error;
    if (idleExpired) {
      const seconds = Math.round(Math.max(limits.headersMs, limits.bodyMs) / 1000);
      throw new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", `模型服务长时间没有任何响应（超过 ${seconds} 秒），已停止等待。可以稍后重试，或换一个模型。`, { cause: error });
    }
    if (!dispatched && boundaryError !== undefined) throw boundaryError;
    throw error;
  } finally {
    if (started) observe("end", terminal);
  }
}

async function nonStreaming(input: PreparedModelCallInput, call: PrivateCall, fetch: typeof globalThis.fetch): Promise<ChatResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const timer = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Model request timed out", "TimeoutError"));
  }, input.timeoutMs) : undefined;
  try {
    const response = await fetch(input.prepared.endpoint, {
      method: "POST", headers: call.headers, body: input.prepared.serializedBody, signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      const cause = Object.assign(new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`), { status: response.status });
      throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", `模型请求失败：HTTP ${response.status}`, { cause });
    }
    const raw = await response.json();
    if (controller.signal.aborted) throw cancelled(controller.signal);
    return call.parseResponse.call(call.adapter, raw);
  } catch (error) {
    if (timedOut) throw new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "模型响应超时，请稍后重试。", { cause: error });
    if (input.signal?.aborted) throw cancelled(input.signal);
    if (error instanceof AgentRuntimeError) throw error;
    if (connectionLost(error)) throw new AgentRuntimeError("E_MODEL_CONNECTION_LOST", "模型服务连接中断。", { cause: error });
    throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
