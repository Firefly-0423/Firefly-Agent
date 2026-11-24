import type { ChatMessage } from "../../../../../shared/chat-types";
import type { RunStatusItem, RunStatusRequest } from "../../../../../shared/run-status";

export function isRunStatusCandidate(message: ChatMessage, activeRunTurnIds?: readonly string[]): boolean {
  // Main still holds this turn as running or settling, even if its text already reads as final.
  if (message.role === "model" && activeRunTurnIds?.includes(message.id)) return true;
  if (message.role !== "model" || message.sSettlement || message.runSnapshot?.status === "terminal") return false;
  if (message.runSnapshot) return true;
  return !message.content.trim() && !message.sticker || Boolean(
    message.toolExecutions?.some(tool => tool.status === "running")
    || message.agentRounds?.some(round => round.status === "running")
    || message.runActivity && message.runActivity.completedAt === undefined);
}

export async function querySessionRunStatus(query: (request: RunStatusRequest) => Promise<RunStatusItem[]>, request: RunStatusRequest): Promise<RunStatusItem[]> {
  const statuses: RunStatusItem[] = [];
  for (let offset = 0; offset < request.candidates.length; offset += 512) {
    statuses.push(...await query({ sessionId: request.sessionId, candidates: request.candidates.slice(offset, offset + 512) }));
  }
  return statuses;
}

/** Observes presentation only: it never acquires execution, approval or queue ownership. */
export function observeSessionRunStatus(deps: {
  sessionId: string;
  candidates: RunStatusRequest["candidates"];
  query: (request: RunStatusRequest) => Promise<RunStatusItem[]>;
  listen: (changed: () => void) => () => void;
  publish: (items: RunStatusItem[]) => void;
}) {
  let disposed = false;
  let querying = false;
  let dirty = false;
  let polls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const versions = new Map<string, RunStatusItem>();
  const candidates = new Map(deps.candidates.map(candidate => [candidate.assistantTurnId, candidate]));
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  async function refresh() {
    if (disposed) return;
    if (querying) { dirty = true; return; }
    querying = true;
    clearTimer();
    try {
      const response = await querySessionRunStatus(deps.query, { sessionId: deps.sessionId, candidates: deps.candidates });
      if (disposed) return;
      let changed = false;
      for (const item of response) {
        const candidate = candidates.get(item.assistantTurnId);
        if (!candidate) continue;
        const previous = versions.get(item.assistantTurnId);
        if (item.phase === "unavailable") {
          if (previous) continue;
        } else {
          if (item.sessionId !== deps.sessionId || candidate.runId && candidate.runId !== item.runId) continue;
          if (previous?.phase !== "unavailable" && previous && (previous.runId !== item.runId || previous.seq >= item.seq)) continue;
          if (item.phase === "finished" && (item.message.id !== item.assistantTurnId || item.message.role !== "model")) continue;
        }
        versions.set(item.assistantTurnId, item);
        changed = true;
      }
      for (const { assistantTurnId } of deps.candidates) {
        if (versions.has(assistantTurnId)) continue;
        versions.set(assistantTurnId, { assistantTurnId, phase: "unavailable" });
        changed = true;
      }
      if (changed || deps.candidates.length === 0) deps.publish([...versions.values()]);
      if (deps.candidates.every(candidate => {
        const phase = versions.get(candidate.assistantTurnId)?.phase;
        return phase === "finished" || phase === "interrupted";
      })) dispose();
    } catch {
      // An unavailable IPC is not evidence that execution stopped.
      if (!disposed && versions.size === 0) {
        for (const { assistantTurnId } of deps.candidates) versions.set(assistantTurnId, { assistantTurnId, phase: "unavailable" });
        deps.publish([...versions.values()]);
      }
    } finally {
      querying = false;
      if (!disposed && dirty) { dirty = false; void refresh(); }
      else if (!disposed && polls < 12 && [...versions.values()].some(item => item.phase === "running" || item.phase === "settling" || item.phase === "unavailable")) {
        timer = setTimeout(() => { polls++; void refresh(); }, 5_000);
      }
    }
  }
  const off = deps.listen(() => { void refresh(); });
  function dispose() { if (disposed) return; disposed = true; clearTimer(); off(); }
  const ready = refresh();
  return { ready, refresh, dispose };
}
