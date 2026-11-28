import type { ComposerAttachment } from "../components/ChatComposer";

type Parsed = { rawContent: string; visibleContent: string; userSticker?: string };

/** Freeze the draft's attachment list before any asynchronous session or queue work. */
export function createQueueEntry(parsed: Parsed, attachments: ComposerAttachment[], id: string, requireDocumentRead: boolean, resumeFromRunId?: string) {
  return {
    id, rawContent: parsed.rawContent, visibleContent: parsed.visibleContent,
    attachments: attachments.map(item => ({ ...item })), requireDocumentRead,
    userSticker: parsed.userSticker,
    ...(resumeFromRunId ? { resumeFromRunId } : {}),
  };
}
