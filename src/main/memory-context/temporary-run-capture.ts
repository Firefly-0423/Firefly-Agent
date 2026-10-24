import type { TranscriptRunReader } from "../orchestrator/conversation-transcript-context";
import type { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { requireTranscriptSinkBinding, wrapTranscriptSink, type TranscriptSink } from "../orchestrator/transcript-sink";
import { contextFail } from "./context-contracts";
import { canonicalTurnUnits } from "./conversation-transcript-adapter";
import type { MainMemoryRunLifecycle, MainMemoryTemporaryCapture } from "./main-memory-runtime";

export interface TemporaryRunCaptureOptions {
  store: ConversationTranscriptStore;
  runReader?: TranscriptRunReader;
  conversationId: string;
  runId: string;
  assistantTurnId: string;
  /** Called once when the run's capture closes. */
  onClose?: () => void;
}

/**
 * Context for a temporary (zero-persistence) chat run. The conversation is read back from the
 * in-memory transcript of that conversation only; it has no summaries, facts, history or ledger,
 * so nothing here touches long-term memory. Writes still go through the genuine run sink.
 */
export function createTemporaryRunCapture(options: TemporaryRunCaptureOptions): MainMemoryTemporaryCapture {
  const { store, conversationId, runId, assistantTurnId } = options;
  if (![conversationId, runId, assistantTurnId].every(value => typeof value === "string" && value.length > 0)) contextFail("MEMORY_CONTEXT_INPUT_INVALID");
  const target = { conversationId, runId, assistantTurnId };
  let epoch = 0, closed = false, tail: Promise<void> = Promise.resolve();
  let runLifecycle: MainMemoryRunLifecycle | undefined;
  const facades = new WeakMap<TranscriptSink, TranscriptSink>();
  // Any canonical write to this conversation, including this run's own, retires an earlier capture.
  // Registered on first use, so a run that fails to open never leaves the single observer slot taken.
  let releaseObserver: (() => void) | undefined;
  const observe = () => { releaseObserver ??= store.observeMutations(conversationId, async () => { epoch++; }); };
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) contextFail("MEMORY_CONTEXT_CANCELLED");
    if (closed) contextFail("MEMORY_CONTEXT_TRANSCRIPT_ADAPTER_CLOSED");
  };
  return {
    async captureTemporary(_request, signal) {
      check(signal); observe();
      const seen = epoch;
      const snapshot = await store.withReadLease(conversationId, read => read());
      check(signal);
      const units = canonicalTurnUnits(snapshot, conversationId, options.runReader);
      if (!units.length) contextFail("MEMORY_CONTEXT_RECENT_INCOMPLETE");
      return { units, assertCurrent: () => { check(signal); if (epoch !== seen) contextFail("MEMORY_CONTEXT_TRANSCRIPT_STALE"); } };
    },
    bindSink(sink, lifecycle) {
      check(lifecycle.signal); lifecycle.assertCurrent(); requireTranscriptSinkBinding(sink, target, store);
      if (runLifecycle && runLifecycle !== lifecycle) contextFail("MEMORY_CONTEXT_STREAM_SINK_DENIED");
      runLifecycle = lifecycle;
      const previous = facades.get(sink);
      if (previous) return previous;
      const bound = wrapTranscriptSink(sink, {
        run: (method, operation) => {
          const result = tail.then(async () => {
            check();
            if (method === "closeInterruption") { if (!lifecycle.signal.aborted) contextFail("MEMORY_CONTEXT_CANCELLED"); }
            else if (method !== "checkpoint") lifecycle.assertCurrent();
            return operation();
          });
          tail = result.then(() => undefined, () => undefined);
          return lifecycle.track(() => result);
        },
      });
      facades.set(sink, bound); facades.set(bound, bound);
      return bound;
    },
    async close() {
      if (closed) return;
      closed = true; await tail; releaseObserver?.(); releaseObserver = undefined;
      try { options.onClose?.(); } catch { /* Cleanup callbacks cannot fail the run's close. */ }
    },
  };
}
