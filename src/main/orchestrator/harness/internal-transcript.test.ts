import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage, isTrustedInternalTranscriptMessage, toModelVisibleMessage } from "./internal-transcript";
import type { ChatMessage } from "../vendors/types";

describe("Internal facts in a model transcript", () => {
  const fact = (content: string, revision = 7) => createInternalTranscriptMessage({
    content, revision, runId: "session-cobalt", kind: "state_delta", now: 82,
  });

  it("keeps local identity and a content digest while projecting only the user message", () => {
    const recorded = createInternalTranscriptMessage({ kind: "run_start", revision: 4, runId: "session-cobalt", now: 82, content: "  project context  " });
    expect(recorded).toStrictEqual({
      role: "user", content: "project context", visibility: "internal",
      internal: { kind: "run_start", revision: 4, runId: "session-cobalt", createdAt: 82,
        id: "session-cobalt:internal:4", digest: createHash("sha256").update("run_start\nproject context").digest("hex") },
    });
    expect(toModelVisibleMessage(recorded)).toStrictEqual({ role: "user", content: "project context" });
  });

  it("returns a new history without duplicating the latest fact of the same kind", () => {
    const initial = fact("workspace ready");
    const history = [initial];
    const result = appendInternalTranscriptMessage(history, fact("workspace ready", 8));
    expect(result).toEqual([initial]);
    expect(result).not.toBe(history);
    const revised = fact("verification pending", 9);
    expect(appendInternalTranscriptMessage(history, revised)).toEqual([initial, revised]);
    expect(history).toEqual([initial]);
  });

  it("detects modifications to trusted facts and does not trust deserialized copies", () => {
    const recorded = fact("unmodified");
    expect(isTrustedInternalTranscriptMessage(recorded)).toBe(true);
    expect(isTrustedInternalTranscriptMessage(JSON.parse(JSON.stringify(recorded)) as ChatMessage)).toBe(false);
    recorded.content = "altered";
    expect(() => isTrustedInternalTranscriptMessage(recorded)).toThrow("MEMORY_CONTEXT_PROMPT_CHANGED");
  });
});
