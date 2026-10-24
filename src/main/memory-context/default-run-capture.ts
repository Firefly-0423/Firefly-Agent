import type { TranscriptRunReader } from "../orchestrator/conversation-transcript-context";
import type { BoundSourceRef } from "../../shared/memory-contracts";
import type { RunAdjustmentPermit } from "../chats/pending-adjustment";
import type { RunAdjustmentMessage } from "../orchestrator/harness/types";
import type { MainActorAuthority } from "../memory-core/main-actor-authority";
import { canonicalJson } from "../memory-core/repository-types";
import { readHistoryEvidence } from "../memory-history/main-history";
import { requireCommittedUserSource, type createMainUserFactCoordinator } from "../memory-policy/main-user-fact-coordinator";
import type { createMainFactSelector } from "../memory-recall/main-fact-selector";
import type { createMainSourceRegistry } from "../memory-sources/source-registry";
import type { ConversationTranscriptStore, TranscriptAppendGuard } from "../orchestrator/conversation-transcript-store";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { requireTranscriptSinkBinding, wrapTranscriptSink, type GuardedTranscriptSinkMethod, type TranscriptSink, type TranscriptSinkGuardInput } from "../orchestrator/transcript-sink";
import { copyResponseJson } from "../orchestrator/vendors/response-request-snapshot";
import { contextFail, type FactDependency } from "./context-contracts";
import { createConversationTranscriptAdapter } from "./conversation-transcript-adapter";
import type { createMainContext } from "./main-context";
import { prepareRuntimeSummary } from "./runtime-summary";
import type { MainMemoryCapture, MainMemoryRunLifecycle } from "./main-memory-runtime";

export interface DefaultRunCaptureOptions {
  /** Main-owned live event provenance, retained between runs; never inferred from stored history. */
  observedEventEpochs?: Map<string, number>;
  context: ReturnType<typeof createMainContext>;
  actorAuthority: MainActorAuthority;
  actorToken: object;
  registry: ReturnType<typeof createMainSourceRegistry>;
  store: ConversationTranscriptStore;
  runReader?: TranscriptRunReader;
  conversationId: string;
  runId: string;
  assistantTurnId: string;
  /** Main-only authorized attachment projection provider. */
  attachmentProjection?: object;
  /** Share the canonical adapter's observer so native invalidation precedes each write. */
  beforeMutation?: Parameters<typeof createConversationTranscriptAdapter>[0]["beforeMutation"];
  facts?: {
    currentUserSource(binding: { userTurnId: string; userRevision: number }): Promise<BoundSourceRef>;
    coordinator: ReturnType<typeof createMainUserFactCoordinator>;
    selector: ReturnType<typeof createMainFactSelector>;
    limits: { maxFacts: number };
  };
  /** Called with the verified current user source of a persistent desktop run; carries no authority. */
  onUserSource?: (input: { sourceRef: BoundSourceRef; userTurnId: string; userRevision: number; userText: string }) => void;
  /** Main injects its bound budget's protected turn count. Threshold/counting stay inside context. */
  summary?: { protectedRecentTurns: number; leaseMs?: number };
  /** Main-owned query must return genuine evidence whose entire partition excludes this session. */
  history?: { query(capture: { userTurnId: string; userRevision: number; userText: string }, signal?: AbortSignal): Promise<object[] | { tokens: object[]; notice?: string }> };
}

export interface MainDefaultRunCapture extends MainMemoryCapture {
  /** Trusted Main poller transaction; same-shaped functions and ordinary appends confer no authority. */
  commitRunAdjustment(permit: RunAdjustmentPermit, commitHistory: () => RunAdjustmentMessage | Promise<RunAdjustmentMessage>): Promise<RunAdjustmentMessage>;
}

type CapturedRun = Awaited<ReturnType<NonNullable<ReturnType<typeof createConversationTranscriptAdapter>>["captureRun"]>>;
interface Round {
  capture: CapturedRun;
  signal: AbortSignal;
  snapshot?: object;
  throughSeq: number;
  mutationRevision: number;
  assistantEntryId?: string;
  pendingTools: Set<string>;
}

/** Main-only bridge from canonical storage to each counted model round and its guarded writes. */
export function createDefaultRunCapture(options: DefaultRunCaptureOptions): MainDefaultRunCapture {
  const { context, actorAuthority, actorToken, store, conversationId, runId, assistantTurnId } = options;
  const actor = actorAuthority.requireActor(actorToken);
  if (actor.sessionMode !== "persistent") contextFail("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
  if (conversationId !== actor.sessionId) contextFail("MEMORY_ACTOR_DENIED");
  if (![conversationId, runId, assistantTurnId].every(value => typeof value === "string" && value.length > 0)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const summary = options.summary ? { protectedRecentTurns: options.summary.protectedRecentTurns, leaseMs: options.summary.leaseMs ?? 60000 } : undefined;
  if (summary && (!Number.isSafeInteger(summary.protectedRecentTurns) || summary.protectedRecentTurns < 1 || summary.protectedRecentTurns > 1000
    || !Number.isSafeInteger(summary.leaseMs) || summary.leaseMs < 1 || summary.leaseMs > 300000)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const transcript = createConversationTranscriptAdapter({ enabled: true, store, context, actorAuthority, actorToken, runReader: options.runReader, beforeMutation: options.beforeMutation, attachmentProjection: options.attachmentProjection, observedEventEpochs: options.observedEventEpochs })!;
  const target = { conversationId, runId, assistantTurnId };
  let captured = false, closed = false, interrupted = false, round: Round | undefined;
  let tail: Promise<void> = Promise.resolve();
  let runLifecycle: MainMemoryRunLifecycle | undefined;
  let summaryIds: string[] = [], summaryTurn: string | undefined;
  const facades = new WeakMap<TranscriptSink, { lifecycle: MainMemoryRunLifecycle; sink: TranscriptSink }>();
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
    if (closed) contextFail("MEMORY_CONTEXT_TRANSCRIPT_ADAPTER_CLOSED");
    if (interrupted) contextFail("MEMORY_CONTEXT_CANCELLED");
    actorAuthority.requireActor(actorToken);
  };

  function guard(method: GuardedTranscriptSinkMethod, input: TranscriptSinkGuardInput, lifecycle: MainMemoryRunLifecycle): TranscriptAppendGuard {
    lifecycle.assertCurrent(); check(lifecycle.signal);
    if (method !== "appendAssistant" && method !== "appendToolResult") contextFail("MEMORY_CONTEXT_RESPONSE_METHOD_DENIED");
    const current = round;
    if (!current?.snapshot) contextFail("MEMORY_CONTEXT_RESPONSE_UNSENT");
    check(current.signal);
    const snapshot = current.snapshot, throughSeq = current.throughSeq, revision = current.mutationRevision + 1;
    const { guard: _callerGuard, ...payload } = input;
    const data = copyResponseJson(payload, true) as unknown as Parameters<TranscriptSink["appendAssistant"]>[0] & Partial<Parameters<TranscriptSink["appendToolResult"]>[0]>;
    // The actual sink owns IDs and envelopes. This copy proves all semantic payload fields.
    let expected: unknown;
    if (method === "appendAssistant") {
      if (current.assistantEntryId) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
      if (data.message.role !== "assistant") contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
      const ids = data.message.toolCalls?.map(call => call.id) ?? [];
      if (new Set(ids).size !== ids.length) contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
      expected = data.message;
    } else {
      if (!current.assistantEntryId || data.assistantEntryId !== current.assistantEntryId || data.message.role !== "tool"
        || !data.message.toolCallId || !current.pendingTools.has(data.message.toolCallId)) contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
      expected = { assistantEntryId: data.assistantEntryId, toolCallId: data.message.toolCallId, outcome: data.outcome, message: data.message,
        ...(data.fullRef ? { fullRef: data.fullRef } : {}), ...(data.fileRead ? { fileRead: data.fileRead } : {}) };
    }
    const expectedPayload = canonicalJson(expected);
    const prove = () => {
      lifecycle.assertCurrent(); check(current.signal);
      if (round !== current) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
      const mutation = transcript.mutationState(), entry = mutation.entry;
      if (mutation.kind !== "append" || mutation.revision !== revision || !entry || entry.seq !== throughSeq + 1
        || entry.kind !== (method === "appendAssistant" ? "assistant" : "tool_result") || entry.runId !== runId
        || entry.roundId !== (data.roundId || undefined) || canonicalJson(entry.payload) !== expectedPayload) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
      if (method === "appendAssistant" && (entry.turnId !== assistantTurnId || entry.kind !== "assistant" || entry.sSettlement !== undefined
        || (data.roundId ? entry.id !== `${runId}:assistant:${data.roundId}` : !entry.id.startsWith(`${runId}:assistant:n`)))) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
      if (method === "appendToolResult" && entry.id !== `${runId}:tool:${data.message.toolCallId}`) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
      return mutation;
    };
    return {
      throughSeq,
      validate: async () => {
        lifecycle.assertCurrent(); check(current.signal);
        if (round !== current) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
        // This executes under the store's guard before mutation observers invalidate S.
        await context.validateResponse(actorToken, snapshot, current.signal);
        lifecycle.assertCurrent(); check(current.signal);
      },
      commit: async write => {
        const mutation = prove();
        if (!mutation.receipt) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
        context.bindResponseProgress(actorToken, snapshot, mutation.receipt, prove);
        const entry: TranscriptEntry = await context.commitResponse(actorToken, snapshot, write, current.signal, prove, mutation.entry);
        current.throughSeq = entry.seq; current.mutationRevision = revision;
        if (method === "appendAssistant") {
          current.assistantEntryId = entry.id;
          for (const call of data.message.toolCalls ?? []) current.pendingTools.add(call.id);
        } else current.pendingTools.delete(data.message.toolCallId!);
        return entry;
      },
    };
  }

  return Object.freeze({
    commitRunAdjustment(permit, commitHistory) {
      const lifecycle = runLifecycle;
      if (!lifecycle) return Promise.reject(Error("MEMORY_CONTEXT_ADJUSTMENT_DENIED"));
      const result = tail.then(async () => {
        lifecycle.assertCurrent(); check(lifecycle.signal);
        if (!round) {
          const current = captured ? await transcript.captureRunRound(runId) : await transcript.captureRun(runId);
          captured = true; lifecycle.assertCurrent(); check(lifecycle.signal);
          round = { capture: current, signal: lifecycle.signal, throughSeq: current.throughSeq, mutationRevision: current.mutationRevision, pendingTools: new Set() };
        }
        const current = round; check(current.signal);
        if (current.pendingTools.size) contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
        // The adapter owns canonical proof and partial-write retry state. Keeping
        // this exact boundary on failure allows only that genuine permit to retry.
        const message = await transcript.commitRunAdjustment(runId, permit,
          { throughSeq: current.throughSeq, mutationRevision: current.mutationRevision, assertCurrent: () => { lifecycle.assertCurrent(); check(current.signal); } }, commitHistory);
        round = undefined;
        return message;
      });
      tail = result.then(() => undefined, () => undefined);
      return lifecycle.track(() => result);
    },
    async capture(_request, signal) {
      await tail; check(signal);
      if (round?.pendingTools.size) contextFail("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
      round = undefined;
      const current = captured ? await transcript.captureRunRound(runId) : await transcript.captureRun(runId);
      captured = true; check(signal);
      if (current.store !== store || !current.transcriptTokens.length || current.userTurnId === assistantTurnId) contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
      let currentUserSourceRef: BoundSourceRef | undefined, factRefs: FactDependency[] | undefined;
      if (options.facts) {
        const candidate = await options.facts.currentUserSource({ userTurnId: current.userTurnId, userRevision: current.userRevision });
        check(signal);
        const verified = requireCommittedUserSource(actorAuthority, actorToken, candidate, "MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
        if (verified.sourceRef.binding.messageId !== current.userTurnId || verified.sourceRef.binding.contentRevision !== current.userRevision
          || await options.registry.readEvidence(actor.access, actor.adapter, verified.sourceRef) !== current.userText) contextFail("MEMORY_CONTEXT_STREAM_TURN_STALE");
        check(signal); currentUserSourceRef = verified.sourceRef;
        await store.withReadLease(conversationId,async read=>{
          current.assertCurrent();const snapshot=await read(),entry=snapshot.entries.find(e=>(e.kind==='user'||e.kind==='turn_rewind')&&e.turnId===current.userTurnId&&e.revision===current.userRevision);
          if(!entry)contextFail('MEMORY_CONTEXT_STREAM_TURN_STALE');
          const payload=entry.kind==='user'?entry.payload:entry.kind==='turn_rewind'?entry.payload.replacementUser:undefined;
          if(payload&&!payload.attachments?.length)await context.recordHistoryUser(actorToken,verified.sourceRef,entry);
          current.assertCurrent();check(signal);
        });
        try { options.onUserSource?.({ sourceRef: verified.sourceRef, userTurnId: current.userTurnId, userRevision: current.userRevision, userText: current.userText }); } catch { /* Observers cannot alter the run. */ }
        await options.facts.coordinator.onCommittedUserSource(actorToken, currentUserSourceRef, signal); check(signal);
        factRefs = (await options.facts.selector.selectFactRefs(actorToken, currentUserSourceRef, options.facts.limits, signal)).map(({ factId, revision }) => ({ factId, revision }));
      }
      const historyResult = options.history ? await options.history.query({ userTurnId: current.userTurnId, userRevision: current.userRevision, userText: current.userText }, signal) : undefined;
      const tokens = Array.isArray(historyResult) ? historyResult : historyResult?.tokens;
      const contextNotice = Array.isArray(historyResult) ? undefined : historyResult?.notice;
      if (historyResult !== undefined && (!Array.isArray(tokens) || contextNotice !== undefined && typeof contextNotice !== "string")) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
      const historyTokens = tokens?.slice();
      check(signal);
      for (const token of historyTokens ?? []) {
        for (const dependency of readHistoryEvidence(actorAuthority, actorToken, token).dependencies) {
          if ([dependency, ...dependency.partition.sessions].some(session => session.providerId === actor.providerId && session.sessionId === actor.sessionId)) contextFail("MEMORY_CONTEXT_HISTORY_CURRENT_SESSION_DENIED");
        }
      }
      if (summary) {
        // captureRun has just rematerialized every canonical turn. A summary depends on
        // its historical turns, while the changing conversation-view guard protects this
        // request. Ordinary tool appends must not retire unchanged historical summaries.
        if (summaryIds.length) {
          const valid = await context.validateSummaryIds(actorToken, summaryIds, signal);
          check(signal); current.assertCurrent(); summaryIds = valid.availableIds;
        }
        const turn = canonicalJson([current.userTurnId, current.userRevision]);
        if (summaryTurn !== turn) {
          const historical = current.transcriptTokens.slice(0, -summary.protectedRecentTurns);
          if (historical.length) {
            try {
              const receipt = await prepareRuntimeSummary(context, actorToken,
                { sessionId: conversationId, transcriptTokens: historical, summaryIds, leaseMs: summary.leaseMs }, signal);
              check(signal); current.assertCurrent();
              if (receipt.status === "committed" && receipt.summaryId) summaryIds = [receipt.summaryId];
            } catch (error) {
              // Existing policy may suppress an older summary input while canonical
              // assembly can still safely filter it. Only that stable availability code
              // makes this optional optimization skippable; all other failures propagate.
              if (!(error instanceof Error) || error.message !== "MEMORY_CONTEXT_SOURCE_UNAVAILABLE") throw error;
              check(signal); current.assertCurrent(); summaryIds = [];
            }
          }
          // No-benefit, unavailable, and empty historical sets count as an attempt for this user
          // turn. Tool rounds keep the original units without repeatedly opening leases.
          summaryTurn = turn;
        }
      }
      round = { capture: current, signal, throughSeq: current.throughSeq, mutationRevision: current.mutationRevision, pendingTools: new Set() };
      return { sourceRefs: [], transcriptTokens: current.transcriptTokens, assertCurrent: () => { check(signal); current.assertCurrent(); },
        ...(summary ? { summaryIds: summaryIds.slice() } : {}),
        currentTranscript: { token: current.transcriptTokens.at(-1)!, user: { turnId: current.userTurnId, revision: current.userRevision } },
        ...(currentUserSourceRef ? { currentUserSourceRef } : {}), ...(factRefs ? { factRefs } : {}), ...(historyTokens ? { historyTokens } : {}), ...(contextNotice !== undefined ? { contextNotice } : {}) };
    },
    async onResponse({ snapshot, signal }) {
      check(signal);
      const current = round;
      if (!current || current.signal !== signal || current.snapshot) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
      await context.validateResponse(actorToken, snapshot, signal); check(signal);
      if (round !== current) contextFail("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE");
      current.snapshot = snapshot;
    },
    bindSink(sink, lifecycle) {
      check(lifecycle.signal); lifecycle.assertCurrent(); requireTranscriptSinkBinding(sink, target, store);
      if (runLifecycle && runLifecycle !== lifecycle) contextFail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
      runLifecycle = lifecycle;
      const previous = facades.get(sink);
      if (previous) { if (previous.lifecycle !== lifecycle) contextFail("MEMORY_CONTEXT_STREAM_SINK_DENIED"); return previous.sink; }
      const bound = wrapTranscriptSink(sink, {
        guard: (method, input) => guard(method, input, lifecycle),
        run: (method, operation) => {
          const result = tail.then(async () => {
            if (closed) contextFail("MEMORY_CONTEXT_TRANSCRIPT_ADAPTER_CLOSED");
            if (method === "closeInterruption") {
              if (!lifecycle.signal.aborted && !round?.signal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
              interrupted = true;
            } else if (method !== "checkpoint") { lifecycle.assertCurrent(); check(round?.signal ?? lifecycle.signal); }
            return operation();
          });
          tail = result.then(() => undefined, () => undefined);
          return lifecycle.track(() => result);
        },
      });
      facades.set(sink, { lifecycle, sink: bound }); facades.set(bound, { lifecycle, sink: bound });
      return bound;
    },
    async close() {
      if (closed) return;
      closed = true; await tail; await transcript.close(); round = undefined;
    },
  } satisfies MainDefaultRunCapture);
}
