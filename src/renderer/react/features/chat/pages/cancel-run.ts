import type { ConversationMode } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";

type ActiveRun = { assistantId: string; mode: ConversationMode; runId?: string };
type CancelHost = {
  patch(scope: string, id: string, change: Partial<ChatMessageItem>): void;
  pending: Set<string>;
  cancelUnscoped(): Promise<unknown> | undefined;
  cancelRun(id: string): Promise<unknown> | undefined;
};

export async function cancelSelectedRun(sessionId: string, run: ActiveRun, host: CancelHost): Promise<void> {
  host.patch(run.mode, run.assistantId, {
    streaming: false, loading: false, waitingForFirstEvent: false, responseStarted: false,
  });
  if (run.runId) {
    await host.cancelRun(run.runId);
  } else {
    // Keep the intent until the run acknowledgement arrives.
    host.pending.add(sessionId);
    await host.cancelUnscoped();
  }
}
