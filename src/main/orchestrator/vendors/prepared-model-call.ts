import {requestProviderIdentity} from "./request-provider-identity";
import { createHash } from "node:crypto";
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
        dispatched=true;return delegate(outgoing);
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
