import type { ToolContext } from "../../tooling/registry/tool-context";
import type { BrowserRunLease, createBrowserService, TrustedBrowserOwner } from "../../platform/browser/browser-service";
import type { BrowserObservation, BrowserPageDto, BrowserReply } from "../../../shared/manual-browser";
export type BrowserWorkspaceExecutor = (command: Record<string, unknown>, context?: ToolContext) => Promise<BrowserReply<BrowserPageDto | BrowserObservation | null>>;
/** Main composition injects the real host binding and active-run registry. No
 * renderer WebContents IDs, browser DTOs or model-supplied owners are authority. */
export function createBrowserWorkspaceExecutor(options: {
  currentOwner(conversationId?: string): TrustedBrowserOwner | null;
  service(): Pick<ReturnType<typeof createBrowserService>, "executeAgent">;
  isRunCurrent(conversationId: string, runId: string): boolean;
  getRunLease?(conversationId: string, runId: string): BrowserRunLease | null;
  retainRunLease?(owner: TrustedBrowserOwner, input: { conversationId: string; runId: string }): BrowserRunLease | null;
}): BrowserWorkspaceExecutor {
  return async (command, context) => {
    const conversationId = context?.conversationId, runId = context?.runId, signal = context?.signal;
    if (signal?.aborted) return { ok: false, code: "cancelled" };
    if (!conversationId || !runId || !(signal instanceof AbortSignal) || !options.isRunCurrent(conversationId, runId)) {
      return { ok: false, code: "owner_mismatch" };
    }
    let result: Awaited<ReturnType<ReturnType<typeof options.service>["executeAgent"]>>;
    if (options.retainRunLease || options.getRunLease) {
      let lease = options.getRunLease?.(conversationId, runId) ?? null;
      if (!lease) {
        const owner = options.currentOwner(conversationId);
        if (!owner || owner.conversationId !== conversationId || owner.signal.aborted) {
          return { ok: false, code: "owner_mismatch" };
        }
        lease = options.retainRunLease?.(owner, { conversationId, runId }) ?? null;
      }
      if (!lease || lease.signal.aborted || !lease.isCurrent()) {
        return { ok: false, code: "owner_mismatch" };
      }
      const activeLease = lease;
      result = await options.service().executeAgent(activeLease, command, {
        conversationId, runId, signal,
        isCurrent: () => !signal.aborted && !activeLease.signal.aborted && activeLease.isCurrent() && options.isRunCurrent(conversationId, runId),
      });
    } else {
      const owner = options.currentOwner(conversationId);
      if (!owner || owner.conversationId !== conversationId || owner.signal.aborted) {
        return { ok: false, code: "owner_mismatch" };
      }
      result = await options.service().executeAgent(owner, command, {
        conversationId, runId, signal,
        isCurrent: () => !signal.aborted && !owner.signal.aborted && options.currentOwner(conversationId) === owner && options.isRunCurrent(conversationId, runId),
      });
    }
    if (!result.ok) return result;
    const value = result.value;
    // A manual workspace page can never become Agent authority, even if a
    // composed service mistakenly returns one across the shared DTO boundary.
    if (value && ("workspaceId" in value || ("conversationId" in value && value.conversationId !== conversationId))) {
      return { ok: false, code: "owner_mismatch" };
    }
    return { ok: true, value };
  };
}
