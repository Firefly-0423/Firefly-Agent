import { expect, it } from "vitest";
import { createQueueEntry } from "./queue-entry";

it("freezes attachments and retains the original message and optional rewind", () => {
  const attachments = [{ kind: "document" as const, name: "notes", filePath: "C:/notes" }];
  const entry = createQueueEntry({ rawContent: "text", visibleContent: "shown", userSticker: "wave" }, attachments, "id", true, "run");
  expect(entry).toEqual({ id: "id", rawContent: "text", visibleContent: "shown", userSticker: "wave", attachments, requireDocumentRead: true, resumeFromRunId: "run" });
  expect(entry.attachments).not.toBe(attachments);
  expect(entry.attachments[0]).not.toBe(attachments[0]);
  expect(createQueueEntry({ rawContent: "x", visibleContent: "x" }, [], "id2", false)).not.toHaveProperty("resumeFromRunId");
});
