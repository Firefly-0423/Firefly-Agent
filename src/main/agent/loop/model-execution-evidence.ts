import { randomUUID } from "node:crypto";
import type { ModelExecutionEvent } from "../../../shared/agent-execution-evidence";

export interface ModelExecutionIdentity {
  agentId: string;
  parentRunId: string;
  childRunId: string;
  executionId: string;
}
export interface ModelExecutionRecorder {
  subscribe(listener: (event: ModelExecutionEvent) => void): () => void;
  observe(identity: ModelExecutionIdentity): (phase: "start" | "end", terminal?: "completed" | "failed" | "cancelled") => void;
}

/** One recorder belongs to a parent run; only the prepared SDK wire boundary invokes it. */
export function createModelExecutionRecorder(
  clock: { domainId: string; now: () => number },
  emit: (event: ModelExecutionEvent) => void,
): ModelExecutionRecorder {
  let seq = 0;
  const listeners = new Set<(event: ModelExecutionEvent) => void>();
  const notify = (listener: (event: ModelExecutionEvent) => void, event: ModelExecutionEvent): void => {
    try { void Promise.resolve(listener({ ...event })).catch(() => undefined); } catch { /* Best effort only. */ }
  };
  return Object.freeze({
    subscribe(listener: (event: ModelExecutionEvent) => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    observe(identity: ModelExecutionIdentity) {
      const captured = { ...identity };
      let started = false, ended = false;
      return (phase: "start" | "end", terminal?: "completed" | "failed" | "cancelled"): void => {
        if (phase === "start" ? started || ended : !started || ended) return;
        if (phase === "start") started = true; else ended = true;
        try {
          const event: ModelExecutionEvent = {
            ...captured, id: randomUUID(), seq: ++seq, monotonicMs: clock.now(), clockDomainId: clock.domainId,
            phase, ...(phase === "end" && terminal ? { terminal } : {}),
          };
          // An async observer is legal for a void callback. Consume its rejection too.
          notify(emit, event);
          for (const listener of listeners) notify(listener, event);
        } catch { /* Evidence must never change authorization, dispatch, or settlement. */ }
      };
    },
  });
}
