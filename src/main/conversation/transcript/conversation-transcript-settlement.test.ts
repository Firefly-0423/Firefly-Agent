import { describe, expect, it } from "vitest";
import { classifySAssistantSettlement } from "./conversation-transcript-settlement";
import type { TranscriptEntry } from "./conversation-transcript-types";
const binding = { runId: "s-run", assistantTurnId: "s-a", userTurnId: "s-u", userRevision: 1, assistantEntryId: "s-entry" };
const rows = (): TranscriptEntry[] => [
  { id: "u-entry", kind: "user", seq: 1, at: 10, turnId: "s-u", revision: 1, payload: { text: "synthetic user" } },
  { id: "s-entry", kind: "assistant", seq: 2, at: 11, runId: "s-run", turnId: "s-a", roundId: "s-response", sSettlement: { version: 1, userTurnId: "s-u", userRevision: 1 }, payload: { role: "assistant", content: "synthetic complete reply" } },
] as any;
const marker = (result = "success", extra: any = {}): any => ({ id: "s-marker", kind: "assistant_settlement", seq: 3, at: 12, runId: "s-run", turnId: "s-a", payload: { binding: { ...binding }, result, safeReason: "completed" }, ...extra });
describe("classifySAssistantSettlement", () => {
  it("requires a persisted marker, not complete text or response status", () => { expect(classifySAssistantSettlement(rows(), "s-entry")).toBe("pending"); });
  it.each(["success", "interrupted"] as const)("classifies reliable %s using the exact original binding", result => { expect(classifySAssistantSettlement([...rows(), marker(result)], "s-entry")).toBe(result); });
  it("preserves legacy non-S assistant semantics without manufacturing success", () => { const input = rows() as any[]; delete input[1].sSettlement; input[1].roundId = "legacy-round"; expect(classifySAssistantSettlement(input, "s-entry")).toBe("legacy"); });
  it("older controlled S with no proof is unknown, not legacy success", () => { const input = rows() as any[]; delete input[1].sSettlement; expect(classifySAssistantSettlement(input, "s-entry")).toBe("unknown"); });
  it.each(["runId", "assistantTurnId", "userTurnId", "userRevision", "assistantEntryId"])("forged marker %s never grants success", key => { const item = marker(); item.payload.binding[key] = key === "userRevision" ? 2 : "other"; expect(classifySAssistantSettlement([...rows(), item], "s-entry")).toBe("unknown"); });
  it.each(["missing-user", "unsupported-version", "wrong-role", "wrong-revision", "tool-message", "duplicate-entry", "duplicate-marker", "before-reply", "bad-seq", "unsafe-reason"])("%s is unknown and never mutates input", kind => {
    let input = rows() as any[];
    const settled = marker();
    if (kind === "missing-user")
      input = input.slice(1);
    if (kind === "unsupported-version")
      input[1].sSettlement.version = 2;
    if (kind === "wrong-role")
      input[1].payload.role = "user";
    if (kind === "wrong-revision")
      input[0].revision = 2;
    if (kind === "tool-message")
      input[1].payload.toolCalls = [{ id: "t", name: "noop", arguments: "{}" }];
    if (kind === "duplicate-entry")
      input.push({ ...input[1], seq: 3 });
    if (kind === "before-reply")
      settled.seq = 1;
    if (kind === "bad-seq")
      settled.seq = NaN;
    if (kind === "unsafe-reason")
      settled.payload.safeReason = "Authorization: Bearer synthetic";
    input.push(settled);
    if (kind === "duplicate-marker")
      input.push({ ...settled, id: "second-marker", seq: 4 });
    const copy = structuredClone(input);
    expect(classifySAssistantSettlement(input, "s-entry")).toBe("unknown");
    expect(input).toEqual(copy);
  });
  it("an unrelated run's interruption does not downgrade an exact success", () => { expect(classifySAssistantSettlement([...rows(), marker(), { id: "other-interruption", kind: "interruption", seq: 4, at: 13, runId: "other-run", payload: { reason: "user_cancel" } }], "s-entry")).toBe("success"); });
  it("a success forged after replacement cannot complete the old active user revision", () => { const input: any[] = [...rows(), { id: "rewind", kind: "turn_rewind", seq: 3, at: 12, runId: "new-run", turnId: "s-u", revision: 2, payload: { anchorUserTurnId: "s-u", disposition: "replace_user", reason: "edit", replacementUser: { text: "edited" } } }, marker("success", { seq: 4 })]; expect(classifySAssistantSettlement(input, "s-entry")).toBe("unknown"); });
  it("a genuine success stays a genuine historical result after later rewind", () => { const input: any[] = [...rows(), marker(), { id: "rewind", kind: "turn_rewind", seq: 4, at: 13, runId: "new-run", turnId: "s-u", payload: { anchorUserTurnId: "s-u", disposition: "keep_user", reason: "regenerate" } }]; expect(classifySAssistantSettlement(input, "s-entry")).toBe("success"); });
  it("does not classify an unknown ID as a successful legacy reply", () => { expect(classifySAssistantSettlement(rows(), "missing")).toBe("unknown"); });
});
