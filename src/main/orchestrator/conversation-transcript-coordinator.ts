import type { ChatMessage as UiChatMessage, ChatSession, PendingChatAttachment } from "../../shared/chat-types";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";

export interface TranscriptRewindRequest { disposition: "keep_user" | "replace_user"; anchorUserTurnId: string }
function modelText(message: UiChatMessage, forceUserContent = false): string {
  if (forceUserContent) return message.content;
  return message.modelContext?.trim() || message.content;
}
function stableAttachments(message: UiChatMessage): PendingChatAttachment[] | undefined {
  const attachments = message.attachments?.map(({ kind, name, filePath, ...extra }) => ({
    kind, name, filePath,
    ...(kind === "image" && "mime" in extra && extra.mime ? { mime: extra.mime } : {}),
    ...(kind === "image" && "caption" in extra && extra.caption ? { caption: extra.caption } : {}),
    ...(kind === "image" && "hasAnnotations" in extra && extra.hasAnnotations ? { hasAnnotations: true } : {}),
  }));
  return attachments?.length ? attachments : undefined;
}

export async function prepareTranscriptDispatch(input: {
  store: ConversationTranscriptStore; session: ChatSession; userTurnId: string; assistantTurnId?: string; runId: string;
  rewind?: TranscriptRewindRequest; forceUserContent?: boolean;
}): Promise<void> {
  const { store: transcript, session: conversation, userTurnId: userId, runId: run, rewind: revisionRequest } = input;
  const user = conversation.messages.find((entry) => entry.id === userId && entry.role === "user");
  if (!user) throw new Error("TRANSCRIPT_USER_TURN_NOT_FOUND");
  const position = conversation.messages.indexOf(user);
  if (input.assistantTurnId !== undefined) {
    const following = conversation.messages[position + 1];
    if (!input.assistantTurnId || input.assistantTurnId === userId || position !== conversation.messages.length - 2
      || conversation.messages.filter((entry) => entry.id === userId).length !== 1
      || conversation.messages.filter((entry) => entry.id === input.assistantTurnId).length !== 1
      || following?.id !== input.assistantTurnId || following.role !== "model" || following.answersUserMessageId !== userId
      || following.content !== "" || following.modelContext?.trim() || revisionRequest && revisionRequest.anchorUserTurnId !== userId) {
      throw Error("TRANSCRIPT_DISPATCH_BINDING_INVALID");
    }
  }
  const persisted = await transcript.read(conversation.id);
  const known: TranscriptEntry[] = [...persisted.entries];
  const identities = new Set(persisted.entries.map((entry) => entry.id));
  const marker = `backfill:v1:${conversation.id}`;
  if (!identities.has(marker)) {
    const history = input.assistantTurnId === undefined ? conversation.messages : conversation.messages.slice(0, position + (revisionRequest ? 1 : 0));
    for (const display of history) {
      if (!revisionRequest && display.id === userId) continue;
      if (input.assistantTurnId !== undefined && known.some((entry) => entry.turnId === display.id
        && (display.role === "user" ? entry.kind === "user" || entry.kind === "turn_rewind" && entry.payload.disposition === "replace_user" : entry.kind === "assistant"))) continue;
      const id = `backfill:v1:${display.id}`;
      if (identities.has(id)) continue;
      const draft: TranscriptAppendInput = display.role === "user"
        ? { id, at: display.at, kind: "user", turnId: display.id, revision: 1, payload: { text: modelText(display, input.forceUserContent), attachments: stableAttachments(display) } }
        : { id, at: display.at, kind: "assistant", payload: { role: "assistant", content: modelText(display, input.forceUserContent) } };
      const saved = await transcript.append(conversation.id, draft);
      identities.add(saved.id);
      known.push(saved);
    }
    const saved = await transcript.append(conversation.id, { id: marker, at: user.at, kind: "backfill_boundary", payload: { note: "UI 会话历史确定性回填边界" } });
    identities.add(saved.id);
    known.push(saved);
  }
  if (revisionRequest) {
    const id = `${run}:rewind:${revisionRequest.anchorUserTurnId}`;
    if (!identities.has(id)) {
      if (revisionRequest.disposition === "replace_user") {
        const previous = known.filter((entry) => entry.turnId === revisionRequest.anchorUserTurnId && typeof entry.revision === "number"
          && (input.assistantTurnId === undefined || entry.kind === "user" || entry.kind === "turn_rewind" && entry.payload.disposition === "replace_user"))
          .reduce((highest, entry) => Math.max(highest, entry.revision ?? 0), 0);
        await transcript.append(conversation.id, {
          id, at: user.at, kind: "turn_rewind", runId: run, turnId: revisionRequest.anchorUserTurnId, revision: previous + 1,
          payload: { anchorUserTurnId: revisionRequest.anchorUserTurnId, disposition: "replace_user", reason: "edit",
            replacementUser: { text: modelText(user, input.forceUserContent), attachments: stableAttachments(user) } },
        });
      } else await transcript.append(conversation.id, {
        id, at: user.at, kind: "turn_rewind", runId: run, turnId: revisionRequest.anchorUserTurnId,
        payload: { anchorUserTurnId: revisionRequest.anchorUserTurnId, disposition: "keep_user", reason: "regenerate" },
      });
    }
    return;
  }
  await transcript.append(conversation.id, { id: `user:v1:${userId}:r1`, at: user.at, kind: "user", turnId: userId, revision: 1,
    payload: { text: modelText(user, input.forceUserContent), attachments: stableAttachments(user) } });
}
