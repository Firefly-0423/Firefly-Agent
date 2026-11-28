import type { ChatStoreApi } from "./chat-page-bridge";
import type { AgentRunInput } from "./run/AgentRunController";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { toUiMessages } from "./chat-page-normalizers";

type Revision = {
  sessionId: string; userId: string; assistantId: string;
  disposition: "replace_user" | "keep_user"; content?: string;
};
type RevisionHost = {
  store: Pick<ChatStoreApi, "get" | "replaceTail">;
  publish(sessionId: string, messages: ChatMessageItem[]): void;
  start(input: AgentRunInput): void;
  newId(): string;
  now(): number;
};

/** Validate against disk immediately before replacing the last turn. */
export async function reviseLastTurn(revision: Revision, host: RevisionHost): Promise<boolean> {
  const session = await host.store.get(revision.sessionId);
  if (!session || session.mode !== "chat") return false;
  const pair = resolveRevisableLastTurn(session.messages, "chat");
  if (pair?.userMessageId !== revision.userId || pair.assistantMessageId !== revision.assistantId) return false;
  const content = revision.content?.trim();
  if (revision.content !== undefined && !content) return false;
  const index = session.messages.length - 2;
  const previous = session.messages[index];
  const user = content === undefined ? previous : { ...previous, content, at: host.now() };
  const saved = await host.store.replaceTail(revision.sessionId, index, [user]);
  if (!saved) return false;
  const assistantId = host.newId();
  const pending: ChatMessageItem = {
    id: assistantId, role: "assistant", content: "", loading: true,
    waitingForFirstEvent: true, streaming: false, responseStarted: false,
  };
  host.publish(revision.sessionId, [...toUiMessages(saved), pending]);
  host.start({
    targetMode: "chat", sessionId: revision.sessionId, userMessageId: user.id,
    assistantId, session: saved, attachments: (user.attachments ?? []).map(item => ({ ...item })),
    transcriptRewind: { anchorUserTurnId: revision.userId, disposition: revision.disposition },
  });
  return true;
}
