import type { MainActorAuthority } from "../memory-core/main-actor-authority";
import { canonicalJson } from "../memory-core/repository-types";
import { readHistoryEvidence } from "../memory-history/main-history";
import type { createMainSourceRegistry } from "../memory-sources/source-registry";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { readTrustedPromptContext } from "../orchestrator/prompt-layers";
import { isExplicitStreamUnsupported } from "../orchestrator/vendors/stream-support";
import type { TranscriptSink } from "../orchestrator/transcript-sink";
import { dispatchPreparedModelCall, prepareModelCall, type PreparedModelCall, type PreparedModelCallInput } from "../orchestrator/vendors/prepared-model-call";
import { copyResponseJson } from "../orchestrator/vendors/response-request-snapshot";
import type { SdkStreamRunInput } from "../orchestrator/vendors/sdk-stream/runtime";
import type { ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, VendorConfig } from "../orchestrator/vendors/types";
import { contextFail, type ContextBudget, type ContextFact, type ContextTransport, type ContextUnit, type PreparedRequest, type TokenCounter } from "./context-contracts";
import { createMainContext } from "./main-context";
import type { MemoryRunAuthority, MemoryRunContext, MemoryRunGrant } from "./main-memory-contracts";
import { assertContextSecretFree } from "./source-secret-screen";
import { requestDigest, selectBudget } from "./token-budget";
import {factContextMessages as memoryMessages} from "./fact-context-messages";

export interface MainMemoryModelBinding {
  readonly profileId: string;
  readonly revision: number;
  readonly config: VendorConfig;
  readonly adapter: ChatVendorAdapter;
  readonly counter: TokenCounter;
  readonly budget: ContextBudget;
  /** Revalidates the saved profile/configuration revision without mutating settings. */
  assertCurrent(): void;
}
export type MainMemoryCapturedContext = Omit<Parameters<ReturnType<typeof createMainContext>["assemble"]>[1], "sessionId" | "signal"> & {
  /** Synchronous Main capture fence, rechecked at the SDK's final wire-send boundary. */
  assertCurrent(): void;
  /** Main-owned coverage description, included in the same counted system frame. */
  contextNotice?: string;
};
export interface MainMemoryRunLifecycle {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Track the real operation, including rejection, until resources may safely close. */
  track<T>(operation: () => Promise<T>): Promise<T>;
}
/** Supplied only by trusted Main composition; strings from the request confer no source authority. */
export interface MainMemoryCapture {
  capture(request: Readonly<ChatRequest>, signal: AbortSignal): Promise<MainMemoryCapturedContext>;
  /** Receives the opaque successful snapshot only inside trusted Main composition. */
  onResponse?(response: { snapshot: object; signal: AbortSignal }): void | Promise<void>;
  /** Must preserve the genuine sink binding and canonical mutation/commit proof. */
  bindSink?(sink: TranscriptSink, lifecycle: MainMemoryRunLifecycle): TranscriptSink;
  close?(): Promise<void>;
}
export interface MainMemoryTemporaryCapture extends Pick<MainMemoryCapture, "bindSink" | "close"> {
  /** Main-owned in-memory transcript view; never reconstructed from caller history. */
  captureTemporary(request: Readonly<ChatRequest>, signal: AbortSignal): Promise<{ units: ContextUnit[]; assertCurrent(): void }>;
}
export interface MainMemoryRuntimeOptions {
  actorAuthority: MainActorAuthority;
  registry: ReturnType<typeof createMainSourceRegistry>;
  transport: ContextTransport;
  runAuthority: MemoryRunAuthority;
  resolveModel(grant: MemoryRunGrant): MainMemoryModelBinding;
  createCapture(input: { context: ReturnType<typeof createMainContext>; run: Readonly<MemoryRunContext> }): MainMemoryCapture;
  createTemporaryCapture?(input: { run: Readonly<MemoryRunContext> }): MainMemoryTemporaryCapture;
  clock?: () => number;
  onModelExecution?: PreparedModelCallInput["onModelExecution"];
  /** Owner closes its one shared backend after every real operation has settled. */
  close?(): Promise<void>;
}
export interface MainMemoryRun {
  call(input: SdkStreamRunInput): Promise<ChatResponse>;
  bindSink(sink: TranscriptSink): TranscriptSink;
  close(): Promise<void>;
}
/** Trusted Main observer allocation. No IDs or callbacks are accepted from model/IPC call DTOs. */
export interface MainMemoryRunOptions {
  createModelExecutionObserver?: () => PreparedModelCallInput["onModelExecution"];
}
export interface MainMemoryRuntime {
  openRun(grant: MemoryRunGrant, options?: MainMemoryRunOptions): Promise<MainMemoryRun>;
  quiesce(): void;
  close(): Promise<void>;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function safeFailure(error: unknown, fallback: string, signal?: AbortSignal): never {
  if (signal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
  if (error instanceof AgentRuntimeError && error.code === "E_MODEL_REQUEST_TIMEOUT") contextFail("E_MODEL_REQUEST_TIMEOUT");
  if (error instanceof Error && /^(MEMORY_[A-Z0-9_]{1,100}|E_MODEL_REQUEST_TIMEOUT)$/.test(error.message)) contextFail(error.message);
  contextFail(fallback);
}
function explicitStreamRejection(error: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; cause?: unknown };
    if ((record.status === 400 || record.status === 422) && isExplicitStreamUnsupported(current)) return true;
    current = record.cause;
  }
  return false;
}
/** Only an explicit image capability refusal on a definite 400/422 is retryable.
 * Never expose provider text or infer this from caller messages or transport names. */
function explicitImageRejection(error: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  const imageUnsupported = /(?:\b(?:images?|image_url|image inputs?|vision|multimodal)\b[^\r\n]{0,60}(?:not supported|unsupported|does not support|unavailable)|(?:not supported|unsupported|does not support)[^\r\n]{0,60}\b(?:images?|image_url|image inputs?|vision|multimodal)\b|不支持.{0,12}(?:图片|图像|视觉|多模态)|(?:图片|图像|视觉|多模态).{0,12}不支持)/i;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current); const record = current as { status?: unknown; message?: unknown; cause?: unknown };
    if ((record.status === 400 || record.status === 422) && typeof record.message === "string" && imageUnsupported.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}
function contextMessages(units: ContextUnit[]): ChatMessage[] {
  return units.flatMap(unit => unit.messages.map(message => {
    const { text, toolCallIds: _ids, ...fields } = message;
    // Rich canonical payloads retain their transport envelopes; text remains the searchable projection.
    return { ...fields, content: (message as typeof message & { content?: ChatMessage["content"] }).content ?? text };
  }));
}
/** Shared Main owner. Each run has isolated preparation state; all use the same actor mutation queue. */
export function createMainMemoryRuntime(options: MainMemoryRuntimeOptions): MainMemoryRuntime {
  let closing = false, closePromise: Promise<void> | undefined;
  const runs = new Set<{ quiesce(): void; close(): Promise<void> }>();
  const usedRuns = new Set<string>();
  const assertOpen = () => { if (closing) contextFail("MEMORY_CONTEXT_RUNTIME_CLOSED"); };

  async function openRun(grant: MemoryRunGrant, runOptions: MainMemoryRunOptions = {}): Promise<MainMemoryRun> {
    const createModelExecutionObserver = runOptions.createModelExecutionObserver;
    assertOpen();
    let run: Readonly<MemoryRunContext>, supplied: MainMemoryModelBinding;
    try { run = options.runAuthority.require(grant); }
    catch (error) { return safeFailure(error, "MEMORY_RUN_DENIED"); }
    const temporary = run.identity.sessionMode === "temporary";
    if (temporary && !options.createTemporaryCapture) contextFail("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
    const actor = options.actorAuthority.requireActor(run.actorToken);
    const key = canonicalJson({ scope: actor.scopeKey, actor: actor.actorKey, provider: actor.providerId, session: actor.sessionId, run: run.identity.runId });
    if (usedRuns.has(key)) contextFail("MEMORY_CONTEXT_RUN_REUSED");
    try { supplied = options.resolveModel(grant); supplied.assertCurrent(); }
    catch (error) { return safeFailure(error, "MEMORY_RUN_PROFILE_DENIED"); }
    if (supplied.profileId !== run.identity.modelProfileId || !Number.isSafeInteger(supplied.revision) || supplied.revision < 1) contextFail("MEMORY_RUN_PROFILE_DENIED");
    if (supplied.revision !== run.profileRevision) contextFail("MEMORY_RUN_PROFILE_CHANGED");
    const profileRevision = supplied.revision;
    const config = frozen(copyResponseJson(supplied.config, true)), configJson = canonicalJson(config);
    const budget = frozen(copyResponseJson(supplied.budget, true));
    const capability = frozen(copyResponseJson(supplied.counter.capability, true));
    const controller = new AbortController(), signal = AbortSignal.any([run.signal, controller.signal]);
    let stopped = false, runClose: Promise<void> | undefined, active: {
      request: ChatRequest; signal: AbortSignal; trustedPromptContext: ChatMessage[]; contextNotice?: string;
      cache: Map<string, PreparedModelCall>; calls: Map<string, PreparedModelCall>; validateCurrent?: () => void;
    } | undefined;
    let responsePreparation: typeof active;
    let tail: Promise<unknown> = Promise.resolve();
    const pending = new Set<Promise<unknown>>();
    function assertCurrent() {
      if (signal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
      if (stopped || closing) contextFail("MEMORY_CONTEXT_RUNTIME_CLOSED");
      options.runAuthority.require(grant); supplied.assertCurrent();
      if (supplied.revision !== profileRevision) contextFail("MEMORY_RUN_PROFILE_CHANGED");
      if (supplied.profileId !== run.identity.modelProfileId || supplied.config.model !== config.model
        || canonicalJson(copyResponseJson(supplied.config, true)) !== configJson
        || canonicalJson(copyResponseJson(supplied.counter.capability, true)) !== canonicalJson(capability)
        || canonicalJson(copyResponseJson(supplied.budget, true)) !== canonicalJson(budget)) contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
    }
    function track<T>(operation: () => Promise<T>): Promise<T> {
      // Invoke synchronously: context.dispatch owns the last no-await mutation/send boundary.
      const result = operation(); pending.add(result);
      void result.then(() => { pending.delete(result); }, () => { pending.delete(result); });
      return result;
    }
    const counter: TokenCounter = { capability, count: async (request, countOptions) => {
      assertCurrent(); const value = await supplied.counter.count(request, countOptions); assertCurrent(); return value;
    } };
    function prepare(units: ContextUnit[], facts: ContextFact[], sOnly = false): PreparedRequest {
      assertCurrent(); const frame = active ?? responsePreparation;
      if (!frame) contextFail("MEMORY_CONTEXT_RUNTIME_INACTIVE");
      const cacheKey = canonicalJson({ sOnly, units, facts });
      const cached = frame.cache.get(cacheKey); if (cached) return cached.request;
      // A response commit can only reuse an already counted frame, never serialize a new one.
      if (!active) contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
      const request: ChatRequest = sOnly
        ? { model: config.model, stream: false, ...(frame.request.maxTokens === undefined ? {} : { maxTokens: frame.request.maxTokens }), messages: contextMessages(units) }
        : { ...frame.request, messages: [...frame.request.messages.filter(message => message.role === "system"), ...(frame.contextNotice ? [{ role: "system" as const, content: frame.contextNotice }] : []), ...memoryMessages(facts), ...contextMessages(units), ...frame.trustedPromptContext] };
      const call = prepareModelCall(supplied.adapter, request, config, { providerId: capability.providerId, model: capability.model, transport: capability.transport, framingVersion: capability.framingVersion }, { validateCurrent: frame.validateCurrent ?? assertCurrent, persistDiagnostics: !temporary });
      if ((call.request.maxOutputTokens ?? 0) > budget.reservedOutputTokens) contextFail("MEMORY_CONTEXT_OUTPUT_RESERVE_INVALID");
      frame.cache.set(cacheKey, call);
      if (!sOnly) frame.calls.set(requestDigest(call.request), call);
      return call.request;
    }
    function authorizeRead(target: { providerId: string; sessionId: string }) {
      assertCurrent();
      const allowed = [run.actorToken, ...run.readActorTokens].some(token => {
        const candidate = options.actorAuthority.requireActor(token);
        return candidate.scopeKey === actor.scopeKey && candidate.actorKey === actor.actorKey
          && candidate.providerId === target.providerId && candidate.sessionId === target.sessionId;
      });
      if (!allowed) contextFail("MEMORY_RUN_READ_DENIED");
    }
    const contextOptions = { actorAuthority: options.actorAuthority, registry: options.registry, transport: options.transport,
      clock: options.clock, includeFactSupportMetadata: true, counter, budget,
      authorizeSourceRead: (_actor: unknown, ref: import("../../shared/memory-contracts").BoundSourceRef) => authorizeRead(ref.binding),
      prepare: (units: ContextUnit[], facts: ContextFact[]) => prepare(units, facts), prepareS: (units: ContextUnit[]) => prepare(units, [], true) };
    const context = temporary ? undefined : createMainContext(contextOptions);
    let capture: MainMemoryCapture | MainMemoryTemporaryCapture;
    try { capture = temporary ? options.createTemporaryCapture!({ run }) : options.createCapture({ context: context!, run });
      if (!capture || (temporary ? typeof (capture as MainMemoryTemporaryCapture).captureTemporary : typeof (capture as MainMemoryCapture).capture) !== "function") contextFail("MEMORY_CONTEXT_CAPTURE_UNSUPPORTED"); assertCurrent(); }
    catch (error) { return safeFailure(error, "MEMORY_CONTEXT_CAPTURE_UNSUPPORTED", signal); }
    usedRuns.add(key);

    function call(input: SdkStreamRunInput): Promise<ChatResponse> {
      let request: ChatRequest, trustedPromptContext: ChatMessage[], inputSignal: AbortSignal | undefined, timeoutMs: number;
      let onDelta: SdkStreamRunInput["onDelta"];
      let onDiagnostic: SdkStreamRunInput["onDiagnostic"];
      try {
        assertCurrent();
        trustedPromptContext = frozen(readTrustedPromptContext(input.request.messages));
        request = frozen(copyResponseJson(input.request, true));
        if (input.adapter !== supplied.adapter || canonicalJson(copyResponseJson(input.config, true)) !== configJson || request.model !== config.model) contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
        timeoutMs = input.timeoutMs; if (!Number.isFinite(timeoutMs) || timeoutMs < 0) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        if (!Array.isArray(request.messages)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
        inputSignal = input.signal; onDelta = input.onDelta; onDiagnostic = input.onDiagnostic;
        if (inputSignal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
      } catch (error) { return Promise.reject(error instanceof Error && /^MEMORY_[A-Z0-9_]{1,100}$/.test(error.message) ? error : new Error("MEMORY_CONTEXT_INPUT_INVALID")); }
      const callSignal = AbortSignal.any([signal, ...(inputSignal ? [inputSignal] : [])]);
      const result = tail.then(async () => {
        assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
        responsePreparation = undefined;
        active = { request, signal: callSignal, trustedPromptContext, cache: new Map(), calls: new Map() };
        let providerFailure: unknown, boundaryFailure: unknown, receivedDelta = false;
        const sendPrepared = (prepared: PreparedModelCall, guardSend?: PreparedModelCallInput["guardSend"]) => {
          const validate = active!.validateCurrent ?? assertCurrent;
          let observer: PreparedModelCallInput["onModelExecution"];
          try { observer = createModelExecutionObserver?.(); } catch { /* Observation cannot alter send authorization. */ }
          return track(() => dispatchPreparedModelCall({
          prepared, config, timeoutMs, signal: callSignal,
          onDelta: delta => { receivedDelta ||= delta.type !== "usage" && (!("delta" in delta) || delta.delta.length > 0);
            try { validate(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED"); }
            catch (error) { boundaryFailure = error; throw error; }
            onDelta?.(delta); },
          onModelExecution: (phase, terminal) => {
            for (const callback of [observer, options.onModelExecution]) {
              try { void Promise.resolve(callback?.(phase, terminal)).catch(() => undefined); } catch { /* Best effort only. */ }
            }
          },
          onDiagnostic,
          guardSend,
        }).catch(error => {
          if (boundaryFailure !== undefined) { providerFailure = boundaryFailure; throw boundaryFailure; }
          // Explicit capability refusal is the only safe retry signal; do not expose provider text.
          if (!callSignal.aborted && request.stream !== false && !receivedDelta && explicitStreamRejection(error)) {
            providerFailure = new Error("MEMORY_CONTEXT_STREAM_UNSUPPORTED"); throw providerFailure;
          }
          if (!callSignal.aborted && !receivedDelta && prepared.request.inputTypes.includes("image") && explicitImageRejection(error)) {
            providerFailure = new Error("MEMORY_CONTEXT_IMAGE_UNSUPPORTED"); throw providerFailure;
          }
          providerFailure = error; throw error;
        })); };
        try {
          if (temporary) {
            let captured: Awaited<ReturnType<MainMemoryTemporaryCapture["captureTemporary"]>>;
            try { captured = await (capture as MainMemoryTemporaryCapture).captureTemporary(request, callSignal); }
            catch (error) { return safeFailure(error, "MEMORY_CONTEXT_CAPTURE_FAILED", callSignal); }
            if (!captured || !Array.isArray(captured.units) || !captured.units.length || typeof captured.assertCurrent !== "function") contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
            const validate = () => { assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED"); captured.assertCurrent(); };
            validate(); active.validateCurrent = validate;
            const units = copyResponseJson(captured.units, true); assertContextSecretFree(units);
            const selected = await selectBudget({ counter, budget, units, prepare: units => prepare(units, []), prepareS: units => prepare(units, [], true), signal: callSignal });
            const prepared = active.calls.get(selected.requestDigest); if (!prepared || !selected.selectedIds.length) contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
            // Private preparation handle is the one-use permit for an entirely ephemeral run.
            // Return a wrapper so the shared queue does not await the model operation.
            const sent = await options.actorAuthority.coordinate(() => {
              validate(); active!.calls.delete(selected.requestDigest);
              return { result: sendPrepared(prepared) };
            });
            const response = await sent.result; validate(); return response;
          }
          let sources: MainMemoryCapturedContext;
          try { sources = await (capture as MainMemoryCapture).capture(request, callSignal); }
          catch (error) { return safeFailure(error, "MEMORY_CONTEXT_CAPTURE_FAILED", callSignal); }
          assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
          if (!sources || typeof sources.assertCurrent !== "function" || !Array.isArray(sources.sourceRefs) || !sources.transcriptTokens?.length && !sources.sourceRefs.length) contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
          if (sources.contextNotice !== undefined && typeof sources.contextNotice !== "string") contextFail("MEMORY_CONTEXT_INPUT_INVALID");
          active.contextNotice = sources.contextNotice;
          const validate = () => { assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED"); sources.assertCurrent(); };
          validate(); active.validateCurrent = validate;
          // History capabilities are genuine Main objects, but their selected sessions still need this run's scope.
          for (const token of sources.historyTokens ?? []) {
            for (const dependency of readHistoryEvidence(options.actorAuthority, run.actorToken, token).dependencies) {
              authorizeRead(dependency); for (const target of dependency.partition.sessions) authorizeRead(target);
            }
          }
          const { assertCurrent: _captureFence, contextNotice: _contextNotice, ...evidence } = sources;
          const snapshot = await context!.assemble(run.actorToken, { ...evidence, sessionId: run.identity.sessionId, signal: callSignal });
          if (!snapshot.selectedIds.length) contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
          const prepared = active.calls.get(snapshot.requestDigest); if (!prepared) contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
          const permit = await context!.validateForDispatch(run.actorToken, snapshot, callSignal);
          const sent = await context!.dispatch(run.actorToken, permit, approved => {
            assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
            if (requestDigest(approved) !== snapshot.requestDigest || JSON.stringify(approved.body) !== prepared.serializedBody) contextFail("MEMORY_CONTEXT_REQUEST_CHANGED");
            return sendPrepared(prepared, send => context!.invokeClaimedRequest(run.actorToken, snapshot, send, callSignal, validate));
          }, callSignal);
          if (sent.status !== "sent") {
            if (providerFailure instanceof Error && ["MEMORY_CONTEXT_STREAM_UNSUPPORTED", "MEMORY_CONTEXT_IMAGE_UNSUPPORTED"].includes(providerFailure.message)) contextFail(providerFailure.message);
            // Timeout identifies why the result is unknown; it never authorizes replay.
            if (providerFailure instanceof AgentRuntimeError && providerFailure.code === "E_MODEL_REQUEST_TIMEOUT") contextFail("E_MODEL_REQUEST_TIMEOUT");
            contextFail("MEMORY_CONTEXT_SEND_UNKNOWN");
          }
          assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
          try { await track(() => Promise.resolve((capture as MainMemoryCapture).onResponse?.({ snapshot, signal: callSignal }))); }
          catch (error) { return safeFailure(error, "MEMORY_CONTEXT_RESPONSE_FAILED", callSignal); }
          assertCurrent(); if (callSignal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
          responsePreparation = active;
          return sent.result;
        } catch (error) { return safeFailure(error, "MEMORY_CONTEXT_RUN_FAILED", callSignal); }
        finally { active = undefined; }
      });
      tail = result.catch(() => undefined); return track(() => result);
    }
    const lifecycle: MainMemoryRunLifecycle = Object.freeze({ signal, assertCurrent, track });
    const owner = {
      quiesce() { if (stopped) return; stopped = true; controller.abort(); options.runAuthority.revoke(grant); },
      close(): Promise<void> { if (!runClose) { owner.quiesce(); runClose = (async () => { await tail; while (pending.size) await Promise.allSettled([...pending]); try { await capture.close?.(); } catch { contextFail("MEMORY_CONTEXT_CLOSE_FAILED"); } responsePreparation = undefined; runs.delete(owner); })(); } return runClose; },
    };
    runs.add(owner);
    const boundSinks = new WeakMap<TranscriptSink, TranscriptSink>();
    const ownFacades = new WeakSet<TranscriptSink>();
    return Object.freeze({ call, bindSink(sink: TranscriptSink) {
      assertCurrent();
      if (!sink || typeof sink !== "object") contextFail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
      if (ownFacades.has(sink)) return sink;
      const cached = boundSinks.get(sink); if (cached) return cached;
      if (!capture.bindSink) contextFail("MEMORY_CONTEXT_STREAM_SINK_UNSUPPORTED");
      try {
        const bound = capture.bindSink(sink, lifecycle);
        if (!bound || typeof bound !== "object" || bound === sink) contextFail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
        boundSinks.set(sink, bound); ownFacades.add(bound); return bound;
      } catch (error) { return safeFailure(error, "MEMORY_CONTEXT_STREAM_SINK_DENIED", signal); }
    }, close: () => owner.close() });
  }
  const runtime: MainMemoryRuntime = {
    openRun,
    quiesce() { if (closing) return; closing = true; for (const run of runs) run.quiesce(); },
    close() { if (!closePromise) { runtime.quiesce(); closePromise = (async () => { const settled = await Promise.allSettled([...runs].map(run => run.close())); try { await options.close?.(); } catch { contextFail("MEMORY_CONTEXT_CLOSE_FAILED"); } if (settled.some(result => result.status === "rejected")) contextFail("MEMORY_CONTEXT_CLOSE_FAILED"); })(); } return closePromise; },
  };
  return Object.freeze(runtime);
}
