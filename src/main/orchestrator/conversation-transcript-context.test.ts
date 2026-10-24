import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeTranscript, buildModelContext, resolveTranscriptRetainTokens, type TranscriptRunReader } from "./conversation-transcript-context";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { prepareTranscriptDispatch } from "./conversation-transcript-coordinator";
import { createTranscriptSink } from "./transcript-sink";
import type { TranscriptEntry, TranscriptAppendInput } from "./conversation-transcript-types";
import type { HarnessRunSession } from "./harness/run-store";
import type { ChatMessage, ToolCall } from "./vendors/types";

const unavailable: TranscriptRunReader = { get: () => null };
const roots: string[] = [];
function storeForTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-materialization-")); roots.push(root);
  return new ConversationTranscriptStore(root, { now: () => 840 });
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function rows() {
  let sequence = 0;
  const wrap = (draft: TranscriptAppendInput) => ({ ...draft, seq: ++sequence } as TranscriptEntry);
  return {
    question: (id: string, revision: number, text: string) => wrap({ at: 840, id: id + "-r" + revision, kind: "user", turnId: id, revision, payload: { text } }),
    answer: (id: string, content: string, toolCalls?: ToolCall[]) => wrap({ at: 840, id, kind: "assistant", runId: "agenda-run", payload: { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) } }),
    edit: (revision: number, text: string) => wrap({ at: 840, id: "agenda-edit-" + revision, kind: "turn_rewind", turnId: "question", revision, payload: { anchorUserTurnId: "question", disposition: "replace_user", reason: "edit", replacementUser: { text } } }),
    result: (assistantEntryId: string, message: ChatMessage) => wrap({ at: 840, id: "result-" + message.toolCallId, kind: "tool_result", payload: { assistantEntryId, toolCallId: message.toolCallId!, outcome: "success", message } }),
  };
}
function evidence(toolCalls: unknown[]): TranscriptRunReader { return { get: () => ({ toolCalls }) as HarnessRunSession }; }
const outcome = (messages: ChatMessage[], id: string) => JSON.parse(String(messages.find(({ toolCallId }) => toolCallId === id)?.content)).outcome;

describe("Canonical transcript materialization", () => {
  it("applies consecutive edits to the latest active user revision and removes stale answers", () => {
    const entry = rows();
    const built = materializeTranscript([entry.question("question", 1, "Monday"), entry.answer("answer-monday", "Monday appointments"), entry.edit(2, "Tuesday"), entry.answer("answer-tuesday", "Tuesday appointments"), entry.edit(3, "Wednesday")], unavailable);
    expect(built.messages.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: "Wednesday" }]);
    expect(built.messages.some(({ content }) => content === "Monday appointments")).toEqual(false);
  });

  it("replays the complete canonical tool message", () => {
    const entry = rows(), message: ChatMessage = { role: "tool", name: "ask_user", toolCallId: "agenda-question", content: JSON.stringify({ outcome: "success", output: { answers: ["Tuesday morning"] } }) };
    expect(materializeTranscript([entry.answer("agenda-answer", "Checking details", [{ id: "agenda-question", name: "ask_user", arguments: "{}" }]), entry.result("agenda-answer", message)], unavailable).messages).toEqual([expect.objectContaining({ role: "assistant" }), message]);
  });

  it.each(["{", "null", "[]", '"calendar"', "84", "true"])("marks started effects with invalid object arguments %s as unknown", (argumentsText) => {
    const entry = rows();
    const built = materializeTranscript([entry.answer("agenda-answer", "Send schedule", [{ id: "agenda-send", name: "send_email", arguments: argumentsText }])], evidence([{ toolCallId: "agenda-send", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 840 }]));
    expect(outcome(built.messages, "agenda-send")).toEqual("unknown");
    expect(built.messages.filter(({ toolCallId }) => toolCallId === "agenda-send")).toHaveLength(1);
    expect(built.uncertainEffects).toContainEqual(expect.objectContaining({ toolCallId: "agenda-send", toolName: "send_email", argumentsUnavailable: true }));
  });

  it("distinguishes started side effects, absent queued calls and read-only uncertainty", () => {
    const entry = rows();
    const built = materializeTranscript([entry.answer("agenda-answer", "Check calendar", [
      { id: "agenda-send", name: "send_email", arguments: '{"to":"calendar@example.invalid"}' },
      { id: "agenda-queued", name: "read_file", arguments: '{"path":"agenda.txt"}' },
    ])], evidence([{ toolCallId: "agenda-send", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started" }]));
    expect(outcome(built.messages, "agenda-send")).toEqual("unknown");
    expect(outcome(built.messages, "agenda-queued")).toEqual("not_executed");
    expect(built.uncertainEffects).toEqual([expect.objectContaining({ toolCallId: "agenda-send" })]);
    const readonly = materializeTranscript([entry.answer("readonly-answer", "Read agenda", [{ id: "agenda-read", name: "read_file", arguments: "{}" }])], evidence([{ toolCallId: "agenda-read", sideEffect: "read_only", status: "started" }]));
    expect(outcome(readonly.messages, "agenda-read")).toEqual("unknown");
    expect(readonly.uncertainEffects).toEqual([]);
  });

  it("treats missing Main evidence conservatively and guards started idempotent writes", () => {
    const entry = rows(), calls = [{ id: "agenda-write", name: "write_file", arguments: '{"path":"agenda.txt","content":"Tuesday"}' }];
    const missing = materializeTranscript([entry.question("question", 1, "Export"), entry.answer("agenda-answer", "Exporting", calls)], unavailable, { missingRunEvidence: "unknown" });
    expect(outcome(missing.messages, "agenda-write")).toEqual("unknown");
    expect(missing.uncertainEffects).toEqual([expect.objectContaining({ toolCallId: "agenda-write", toolName: "write_file" })]);
    const planned = { id: "agenda-planned", name: "write_file", arguments: '{"path":"later.txt","content":"Wednesday"}' };
    const built = materializeTranscript([entry.answer("mutating-answer", "Exporting", [...calls, planned])], evidence([
      { toolCallId: "agenda-write", status: "started", sideEffect: "idempotent_mutation" }, { toolCallId: "agenda-planned", status: "planned", sideEffect: "idempotent_mutation" },
    ]));
    expect(outcome(built.messages, "agenda-write")).toEqual("unknown");
    expect(outcome(built.messages, "agenda-planned")).toEqual("not_executed");
    expect(built.uncertainEffects.map(({ toolCallId }) => toolCallId)).toEqual(["agenda-write"]);
  });
});

describe("Transcript context window and persistence gates", () => {
  it("retains the newest user without separating retained tool results from their declarations", async () => {
    const store = storeForTest(), entry = rows();
    const calls = [{ id: "agenda-read-one", name: "read_file", arguments: "{}" }, { id: "agenda-read-two", name: "read_file", arguments: "{}" }];
    const drafts = [entry.question("early-question", 1, "Earlier calendar context ".repeat(50)), entry.answer("early-answer", "Earlier calendar answer ".repeat(50)), entry.question("middle-question", 1, "Middle calendar request ".repeat(50)), entry.answer("middle-answer", "Middle calendar answer ".repeat(50)), entry.answer("tool-answer", "Read calendar files", calls),
      ...calls.map((call) => entry.result("tool-answer", { role: "tool", name: "read_file", toolCallId: call.id, content: "Calendar file " + call.id })),
      entry.question("latest-question", 1, "Latest calendar request"),
    ];
    for (const { seq: _sequence, ...draft } of drafts) await store.append("agenda", draft as TranscriptAppendInput);
    const built = await buildModelContext({ store, conversationId: "agenda", retainTokens: 30, runReader: unavailable });
    for (const tool of built.messages.filter(({ role }) => role === "tool")) expect(built.messages.some((message) => message.role === "assistant" && message.toolCalls?.some(({ id }) => id === tool.toolCallId))).toEqual(true);
    expect(built.messages.some(({ role, content }) => role === "user" && content === "Latest calendar request")).toEqual(true);
  });

  it("derives retention from the compact threshold while respecting output reservation", () => {
    expect(resolveTranscriptRetainTokens(256_000)).toEqual(Math.floor(256_000 * 0.85));
    expect(resolveTranscriptRetainTokens(1_000_000)).toEqual(850_000);
    expect(resolveTranscriptRetainTokens(8_800)).toEqual(8_800 - 8_192 - 512);
    expect(resolveTranscriptRetainTokens(0)).toEqual(1);
  });

  it("fails closed at every dispatch and sink write boundary and reads behind queued writes", async () => {
    const store = storeForTest();
    function refusing(kind: TranscriptEntry["kind"]) {
      return { append: (room: string, draft: TranscriptAppendInput) => draft.kind === kind ? Promise.reject(Error("Agenda " + kind + " write refused")) : store.append(room, draft),
        read: (room: string) => store.read(room), checkpoint: (room: string) => store.checkpoint(room), waitForIdle: (room: string) => store.waitForIdle(room),
      } as unknown as ConversationTranscriptStore;
    }
    const session = { id: "agenda", messages: [{ id: "question", role: "user", content: "Calendar request", at: 840 }] } as Parameters<typeof prepareTranscriptDispatch>[0]["session"];
    await expect(prepareTranscriptDispatch({ store: refusing("user"), session, userTurnId: "question", runId: "agenda-run" })).rejects.toThrow("Agenda user write refused");
    await expect(prepareTranscriptDispatch({ store: refusing("turn_rewind"), session, userTurnId: "question", runId: "agenda-edit", rewind: { anchorUserTurnId: "question", disposition: "replace_user" } })).rejects.toThrow("Agenda turn_rewind write refused");
    await expect(createTranscriptSink({ store: refusing("assistant"), conversationId: "agenda", runId: "agenda-answer" }).appendAssistant({ message: { role: "assistant", content: "Reading calendar" } })).rejects.toThrow("Agenda assistant write refused");
    const sink = createTranscriptSink({ store, conversationId: "agenda", runId: "agenda-tools" });
    const anchor = await sink.appendAssistant({ message: { role: "assistant", content: "Read calendar", toolCalls: [{ id: "calendar-call", name: "read_file", arguments: "{}" }] } });
    await expect(createTranscriptSink({ store: refusing("tool_result"), conversationId: "agenda", runId: "agenda-tools" }).appendToolResult({ assistantEntryId: anchor, message: { role: "tool", toolCallId: "calendar-call", name: "read_file", content: "Calendar content" }, outcome: "success" })).rejects.toThrow("Agenda tool_result write refused");
    await expect(createTranscriptSink({ store: refusing("interruption"), conversationId: "agenda", runId: "agenda-interrupted" }).closeInterruption({ reason: "user_cancel", runSession: null })).rejects.toThrow("Agenda interruption write refused");
    const writing = store.append("agenda", { kind: "user", id: "queued-question", turnId: "queued-turn", revision: 1, at: 840, payload: { text: "Concurrent calendar request" } });
    expect((await store.read("agenda")).entries.some(({ id }) => id === "queued-question")).toEqual(true);
    await writing;
  });
});
