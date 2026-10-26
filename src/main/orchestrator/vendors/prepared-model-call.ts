import {requestProviderIdentity} from "./request-provider-identity";
import { createHash } from "node:crypto";
import { Agent, type Dispatcher } from "undici";
import { contextFail, type JsonValue, type PreparedRequest, type RequestIdentity } from "../../memory-context/context-contracts";
import { AgentRuntimeError } from "../agent-runtime-error";
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
  /** Main final network gate, invoked only after actual SDK bytes are checked. */
  guardSend?: (send:()=>Promise<Response>)=>Promise<Response>;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  onDiagnostic?: SdkStreamRunInput["onDiagnostic"];
  onModelExecution?: (phase: "start" | "end", terminal?: "completed" | "failed" | "cancelled") => void;
}
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

const CONNECTION_LOST_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CLOSED"]);
/** Delays before each retry of a model request whose connection was lost before any response arrived. */
const CONNECTION_RETRY_DELAYS_MS = [1_000, 3_000];
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
/** A transport-level failure; fetch rejects this way only before the response headers arrive. */
function connectionLost(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 6; cause = (cause as { cause?: unknown }).cause, depth++) {
    const { code } = cause as { code?: unknown };
    if (typeof code === "string" && CONNECTION_LOST_CODES.has(code)) return true;
  }
  return false;
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
        // A model call has no side effect outside the provider, so a request whose connection dropped before
        // any response is sent again (twice at most); once a response has started it is never replayed.
        const send=async(request:Request,attempt:number):Promise<Response>=>{
          const spare=attempt<CONNECTION_RETRY_DELAYS_MS.length?request.clone():undefined;
          // Node's RequestInit types lag the undici package; the dispatcher option is the same at runtime.
          try{return await delegate(request,{dispatcher:modelConnectionPool()} as unknown as RequestInit)}
          catch(error){
            if(!spare||!connectionLost(error)||outgoing.signal.aborted)throw error;
            await new Promise(resolve=>setTimeout(resolve,CONNECTION_RETRY_DELAYS_MS[attempt]));
            check(call,input.config,input.signal);
            if(outgoing.signal.aborted)throw cancelled(outgoing.signal);
            return send(spare,attempt+1);
          }
        };
        return send(outgoing,0);
      };
      return await (input.guardSend?input.guardSend(invoke):invoke());
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
    throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
