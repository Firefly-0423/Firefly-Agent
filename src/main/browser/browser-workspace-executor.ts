import type { ToolContext } from "../orchestrator/tools/registry/tool-context";
import type { createBrowserService, TrustedBrowserOwner } from "./browser-service";
import type { BrowserObservation, BrowserPageDto, BrowserReply } from "../../shared/manual-browser";
export type BrowserWorkspaceExecutor = (command: Record<string, unknown>, context?: ToolContext) => Promise<BrowserReply<BrowserPageDto | BrowserObservation | null>>;
/** Main composition injects the real host binding and active-run registry. No
 * renderer WebContents IDs, browser DTOs or model-supplied owners are authority. */
export function createBrowserWorkspaceExecutor(options: {
  currentOwner(): TrustedBrowserOwner | null;
  service(): Pick<ReturnType<typeof createBrowserService>, "executeAgent">;
  isRunCurrent(conversationId: string, runId: string): boolean;
}): BrowserWorkspaceExecutor {
  return async (command, context) => {
    const owner = options.currentOwner();
    const conversationId = context?.conversationId, runId = context?.runId, signal = context?.signal;
    if (signal?.aborted) return { ok: false, code: "cancelled" };
    if (!owner || !conversationId || !runId || !(signal instanceof AbortSignal) || owner.conversationId !== conversationId
      || owner.signal.aborted || !options.isRunCurrent(conversationId, runId)) return { ok: false, code: "owner_mismatch" };
    const result = await options.service().executeAgent(owner, command, {
      conversationId, runId, signal,
      isCurrent: () => !signal.aborted && !owner.signal.aborted && options.currentOwner() === owner && options.isRunCurrent(conversationId, runId),
    });
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
