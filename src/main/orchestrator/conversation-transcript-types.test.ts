import { expect, it } from "vitest";
import { assertValidTranscriptDraft, copySAssistantBinding, copySAssistantMessage, copySAssistantSettlementBinding, copySAssistantSettlementPayload, userRevisionKey, type TranscriptAppendInput } from "./conversation-transcript-types";
const binding = { runId: "r", assistantTurnId: "a", userTurnId: "u", userRevision: 1 };
const settlement = { ...binding, assistantEntryId: "entry" };
const draft = (patch: object = {}) => ({ id: "entry", at: 1, kind: "user", turnId: "u", revision: 1, payload: { text: "hello" }, ...patch }) as TranscriptAppendInput;
const invalid = (run: () => unknown) => expect(run).toThrow(/^TRANSCRIPT_S_BINDING_INVALID$/);
it("copies bindings and settlement payloads without retaining caller objects", () => {
  expect(copySAssistantBinding(binding)).toEqual(binding); expect(copySAssistantBinding(binding)).not.toBe(binding);
  expect(copySAssistantSettlementBinding(settlement)).toEqual(settlement);
  for (const result of ["success", "interrupted"]) {
    const value = { binding: settlement, result, safeReason: "Done_1-ok" }; const copied = copySAssistantSettlementPayload(value); expect(copied).toEqual(value); expect(copied.binding).not.toBe(settlement);
  }
});
it.each([null, [], Object.create(null), { ...binding, extra: 1 }, { ...binding, [Symbol("extra")]: 1 }, Object.assign(Object.create({}), binding)])("rejects non-plain or non-exact binding shape %j", value => invalid(() => copySAssistantBinding(value)));
it("rejects accessor properties without invoking their getters", () => {
  let reads = 0; const value = { ...binding }; Object.defineProperty(value, "runId", { get() { reads++; return "r"; } }); invalid(() => copySAssistantBinding(value)); expect(reads).toBe(0);
});
it.each(["", "x\n", "x\u007f", "x".repeat(1025), 1, null])("rejects invalid binding ID %j", runId => invalid(() => copySAssistantBinding({ ...binding, runId })));
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, "1"])("rejects invalid revision %s", userRevision => invalid(() => copySAssistantBinding({ ...binding, userRevision })));
it("accepts ID and revision boundaries but rejects identical turns", () => {
  expect(copySAssistantBinding({ ...binding, runId: "x".repeat(1024), userRevision: Number.MAX_SAFE_INTEGER }).userRevision).toBe(Number.MAX_SAFE_INTEGER);
  invalid(() => copySAssistantBinding({ ...binding, assistantTurnId: "u" })); invalid(() => copySAssistantSettlementBinding({ ...settlement, assistantEntryId: "" }));
});
it.each(["", " ", 123])("rejects empty or non-text assistant content %j", content => invalid(() => copySAssistantMessage({ role: "assistant", content })));
it("copies assistant text verbatim with a UTF-8 byte limit", () => {
  expect(copySAssistantMessage({ role: "assistant", content: " hi \n" })).toEqual({ role: "assistant", content: " hi \n" });
  invalid(() => copySAssistantMessage({ role: "user", content: "hi" }));
  const content = "a".repeat(8 * 1024 * 1024); expect(copySAssistantMessage({ role: "assistant", content }).content).toBe(content);
  invalid(() => copySAssistantMessage({ role: "assistant", content: content + "中" }));
});
it.each(["", "1start", "bad reason", "x".repeat(97), null])("rejects unsafe settlement reason %j", safeReason => invalid(() => copySAssistantSettlementPayload({ binding: settlement, result: "success", safeReason })));
it("rejects unsupported settlement results", () => invalid(() => copySAssistantSettlementPayload({ binding: settlement, result: "pending", safeReason: "ok" })));
it("separates user revision keys unambiguously", () => { expect(userRevisionKey("turn", 2)).toBe("turn\u00002"); expect(userRevisionKey("turn1", 2)).not.toBe(userRevisionKey("turn", 12)); });
it("accepts ordinary user, assistant and keep-user rewind drafts", () => {
  expect(() => assertValidTranscriptDraft(draft())).not.toThrow(); expect(() => assertValidTranscriptDraft(draft({ kind: "assistant", payload: { role: "assistant", content: "hi" } }))).not.toThrow();
  expect(() => assertValidTranscriptDraft(draft({ kind: "turn_rewind", payload: { disposition: "keep_user", anchorUserTurnId: "u", reason: "regenerate" } }))).not.toThrow();
});
it.each(["", "bad\nid"])("rejects entry ID %j", id => expect(() => assertValidTranscriptDraft(draft({ id }))).toThrow(/^TRANSCRIPT_INVALID_ENTRY_ID$/));
it.each([{ turnId: "" }, { revision: 0 }, { revision: -1 }])("rejects missing user revision metadata %j", patch => expect(() => assertValidTranscriptDraft(draft(patch))).toThrow(/^TRANSCRIPT_INVALID_USER_REVISION$/));
it("requires replacement data and revision metadata", () => {
  const payload = { disposition: "replace_user", anchorUserTurnId: "u", reason: "edit" };
  expect(() => assertValidTranscriptDraft(draft({ kind: "turn_rewind", payload }))).toThrow(/^TRANSCRIPT_REPLACEMENT_REQUIRED$/);
  expect(() => assertValidTranscriptDraft(draft({ kind: "turn_rewind", payload: { ...payload, replacementUser: { text: "new" } } }))).not.toThrow();
});
it("validates S-response assistant drafts and matching settlement envelopes", () => {
  const assistant = draft({ kind: "assistant", turnId: "a", runId: "r", roundId: "s-response", payload: { role: "assistant", content: "hi" }, sSettlement: { version: 1, userTurnId: "u", userRevision: 1 } });
  expect(() => assertValidTranscriptDraft(assistant)).not.toThrow(); invalid(() => assertValidTranscriptDraft({ ...assistant, roundId: "other" }));
  invalid(() => assertValidTranscriptDraft({ ...assistant, sSettlement: { version: 2, userTurnId: "u", userRevision: 1 } } as never));
  const done = draft({ kind: "assistant_settlement", runId: "r", turnId: "a", payload: { binding: settlement, result: "success", safeReason: "done" } });
  expect(() => assertValidTranscriptDraft(done)).not.toThrow(); invalid(() => assertValidTranscriptDraft({ ...done, runId: "different" })); invalid(() => assertValidTranscriptDraft({ ...done, turnId: "different" }));
});
