import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatSession } from "../../shared/chat-types";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { prepareTranscriptDispatch } from "./conversation-transcript-coordinator";

const directories: string[] = [];
function setup(bound = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-dispatch-")); directories.push(directory);
  const store = new ConversationTranscriptStore(directory, { now: () => 840 });
  const session: ChatSession = { id: "agenda", title: "Calendar planning", mode: "chat", identityId: null, createdAt: 10, updatedAt: 80, schemaVersion: 1, messages: bound ? [
    { id: "question-now", role: "user", content: "Tuesday appointments", at: 70 },
    { id: "answer-now", role: "model", content: "", answersUserMessageId: "question-now", at: 71 },
  ] : [
    { id: "question-old", role: "user", content: "Monday appointments", at: 10 },
    { id: "answer-old", role: "model", content: "Monday is full", at: 20, toolExecutions: [{ id: "display-preview", name: "calendar_read", status: "success", result: "Display only" }] },
    { id: "question-now", role: "user", content: "Tuesday appointments", at: 70 },
  ] };
  const dispatch = (runId = "agenda-run", rewind?: { anchorUserTurnId: string; disposition: "keep_user" | "replace_user" }) => prepareTranscriptDispatch({ store, session, userTurnId: "question-now", ...(bound ? { assistantTurnId: "answer-now" } : {}), runId, rewind });
  const entries = async () => (await store.read(session.id)).entries;
  return { store, session, dispatch, entries };
}
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("Canonical transcript dispatch", () => {
  it("backfills once, strips display tool previews, and appends the current turn after the boundary", async () => {
    const { dispatch, entries } = setup();
    await dispatch(); await dispatch();
    const rows = await entries(), boundary = rows.filter(({ kind }) => kind === "backfill_boundary");
    expect(boundary).toHaveLength(1);
    const current = rows.filter((row) => row.kind === "user" && row.turnId === "question-now");
    expect(current).toHaveLength(1); expect(current[0].seq).toBeGreaterThan(boundary[0].seq);
    expect(rows.find(({ kind }) => kind === "assistant")?.payload).toEqual({ role: "assistant", content: "Monday is full" });
  });

  it("resumes partially backfilled history and reuses the stable user ID across new run IDs", async () => {
    const { store, dispatch, entries } = setup();
    await store.append("agenda", { id: "backfill:v1:question-old", kind: "user", turnId: "question-old", revision: 1, at: 10, payload: { text: "Monday appointments" } });
    await dispatch(); await dispatch("agenda-retry");
    const rows = await entries();
    expect(rows.filter(({ id }) => id === "backfill:v1:question-old")).toHaveLength(1);
    expect(rows.filter(({ kind }) => kind === "backfill_boundary")).toHaveLength(1);
    const users = rows.filter((row) => row.kind === "user" && row.turnId === "question-now");
    expect(users).toHaveLength(1);
    expect(users[0].id).toEqual("user:v1:question-now:r1");
    expect(users[0]).not.toHaveProperty("runId");
  });

  it("writes edit and regenerate as one rewind each without extra user rows", async () => {
    const { session, dispatch, entries } = setup();
    session.messages[2].content = "Wednesday appointments";
    await dispatch("agenda-edit", { anchorUserTurnId: "question-now", disposition: "replace_user" });
    await dispatch("agenda-regenerate", { anchorUserTurnId: "question-now", disposition: "keep_user" });
    const rows = await entries(), rewinds = rows.filter(({ kind }) => kind === "turn_rewind");
    expect(rewinds[0]).toMatchObject({ turnId: "question-now", revision: 2, payload: { disposition: "replace_user", reason: "edit", replacementUser: { text: "Wednesday appointments" } } });
    expect(rewinds[1]).toMatchObject({ turnId: "question-now", payload: { disposition: "keep_user", reason: "regenerate" } });
    expect(rewinds[1].payload).not.toHaveProperty("replacementUser");
    expect(rows.filter((row) => row.kind === "user" && row.turnId === "question-now")).toHaveLength(1);
  });

  it.each(["absent-turn", "answer-old"])("rejects a missing or non-user anchor %s", async (userTurnId) => {
    const { store, session } = setup();
    await expect(prepareTranscriptDispatch({ store, session, userTurnId, runId: "agenda-run" })).rejects.toThrow("TRANSCRIPT_USER_TURN_NOT_FOUND");
  });
});

describe("Current assistant placeholder binding", () => {
  it("excludes the live placeholder on first dispatch and preserves ordered historical turns on retry", async () => {
    const fresh = setup(true);
    await fresh.dispatch();
    const rows = await fresh.entries();
    expect(rows.filter(({ kind }) => kind === "assistant")).toEqual([]);
    expect(rows.filter(({ kind }) => kind === "user")).toMatchObject([{ turnId: "question-now", revision: 1, at: 70, payload: { text: "Tuesday appointments" } }]);
    expect(rows.filter(({ kind }) => kind === "backfill_boundary")).toHaveLength(1);
    const historical = setup(true);
    historical.session.messages.unshift({ id: "question-old", role: "user", content: "Monday appointments", at: 10 }, { id: "answer-old", role: "model", content: "Monday is full", at: 20 });
    await historical.dispatch(); await historical.dispatch();
    expect((await historical.entries()).filter(({ kind }) => kind === "user" || kind === "assistant").map(({ kind, at }) => [kind, at])).toEqual([["user", 10], ["assistant", 20], ["user", 70]]);
  });

  it.each(["identity", "parent", "role", "tail", "duplicate"])("rejects invalid placeholder %s before any store mutation", async (invalid) => {
    const { store, session } = setup(true);
    if (invalid === "parent") session.messages[1].answersUserMessageId = "another-question";
    if (invalid === "role") session.messages[1].role = "user";
    if (invalid === "tail") session.messages.push({ id: "late-question", role: "user", content: "Late request", at: 72 });
    if (invalid === "duplicate") session.messages.unshift({ ...session.messages[0] });
    const before = await store.read("agenda");
    await expect(prepareTranscriptDispatch({ store, session, userTurnId: "question-now", assistantTurnId: invalid === "identity" ? "nonexistent-answer" : "answer-now", runId: "agenda-run" })).rejects.toThrow("TRANSCRIPT_DISPATCH_BINDING_INVALID");
    expect(await store.read("agenda")).toEqual(before);
  });

  it.each(["keep_user", "replace_user"] as const)("preserves the real user anchor for a bound %s, with or without a backfill boundary", async (disposition) => {
    for (const boundary of [true, false]) {
      const { store, dispatch, entries } = setup(true);
      const original = await store.append("agenda", { kind: "user", id: "canonical-question", turnId: "question-now", revision: boundary ? 1 : 3, at: 60, payload: { text: "Canonical Tuesday request" } });
      if (boundary) await store.append("agenda", { at: 840, id: "backfill:v1:agenda", kind: "backfill_boundary", payload: { note: "Existing calendar history" } });
      await dispatch("agenda-rewind", { anchorUserTurnId: "question-now", disposition });
      const rows = await entries();
      expect(rows.filter(({ kind }) => kind === "user")).toEqual([original]);
      expect(rows.filter(({ kind }) => kind === "assistant")).toEqual([]);
      expect(rows.at(-1)).toMatchObject({ kind: "turn_rewind", turnId: "question-now", ...(disposition === "replace_user" ? { revision: boundary ? 2 : 4 } : {}), payload: { anchorUserTurnId: "question-now", disposition } });
    }
  });

  it("keeps already committed historical messages when the backfill boundary is missing", async () => {
    const { store, session, dispatch, entries } = setup(true);
    session.messages.unshift({ id: "question-old", role: "user", content: "Display request", at: 10 }, { id: "answer-old", role: "model", content: "Display answer", at: 20 });
    const question = await store.append("agenda", { id: "canonical-old-question", kind: "user", turnId: "question-old", revision: 2, at: 30, payload: { text: "Canonical request" } });
    const answer = await store.append("agenda", { id: "canonical-old-answer", kind: "assistant", turnId: "answer-old", at: 40, payload: { role: "assistant", content: "Canonical answer" } });
    await dispatch();
    const rows = await entries();
    expect(rows.filter(({ turnId }) => turnId === "question-old" || turnId === "answer-old")).toEqual([question, answer]);
    expect(rows.filter(({ kind }) => kind === "assistant")).toEqual([answer]);
  });

  it("uses human text for backfill, new input and edited attachments when forced", async () => {
    const { store, session } = setup();
    const attachment = { kind: "document" as const, name: "agenda.txt", filePath: "/calendar/never-read.txt", status: "pending" as const };
    session.messages = [
      { id: "question-old", role: "user", content: "Original calendar text", modelContext: "UNTRUSTED OLD CONTEXT", at: 10, attachments: [attachment] },
      { id: "question-now", role: "user", content: "Current calendar text", modelContext: "UNTRUSTED CURRENT CONTEXT", at: 70, attachments: [attachment] },
    ];
    const input = { store, session, userTurnId: "question-now", runId: "agenda-run", forceUserContent: true };
    await prepareTranscriptDispatch(input);
    expect((await store.read("agenda")).entries.filter(({ kind }) => kind === "user").map(({ payload }) => (payload as { text: string }).text)).toEqual(["Original calendar text", "Current calendar text"]);
    session.messages[1] = { ...session.messages[1], content: "Edited calendar text", modelContext: "UNTRUSTED EDIT CONTEXT" };
    await prepareTranscriptDispatch({ ...input, runId: "agenda-edit", rewind: { anchorUserTurnId: "question-now", disposition: "replace_user" } });
    const edited = (await store.read("agenda")).entries.at(-1)!;
    expect(edited.kind).toEqual("turn_rewind");
    expect(edited.payload).toMatchObject({ replacementUser: { text: "Edited calendar text", attachments: [{ kind: "document", name: "agenda.txt", filePath: "/calendar/never-read.txt" }] } });
  });
});
