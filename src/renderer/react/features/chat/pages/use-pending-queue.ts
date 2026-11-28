import { useEffect, useRef, useState } from "react";
import type { PendingChatMessage } from "../../../../../shared/chat-types";
import { createPendingQueueFlow, type PendingQueueFlow, type PendingQueueFlowHost } from "./pending-queue-flow";

/** Owns the renderer projection while the flow keeps its retry and claim state. */
export function usePendingQueue(host: Omit<PendingQueueFlowHost, "replaceProjection">) {
  const [queues, setQueues] = useState<Record<string, PendingChatMessage[]>>({});
  const queuesRef = useRef(queues);
  useEffect(() => { queuesRef.current = queues; }, [queues]);
  const ports = useRef<PendingQueueFlowHost>(null!);
  ports.current = {
    ...host,
    replaceProjection(sessionId, entries) {
      setQueues(previous => {
        if (entries !== null) return { ...previous, [sessionId]: entries.map(entry => ({ ...entry })) };
        if (!(sessionId in previous)) return previous;
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
    },
  };
  const instance = useRef<PendingQueueFlow | null>(null);
  if (!instance.current) instance.current = createPendingQueueFlow(() => ports.current);
  return { queues, queuesRef, flow: instance.current };
}
