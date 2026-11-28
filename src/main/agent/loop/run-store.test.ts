import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunStore } from "./run-store";
import { logger } from "../../base/logging/logger";
import type { AgentState } from "./types";
import type { ChatMessage } from "../../model/providers/types";

const disposals: Array<() => void> = [];
function storage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-"));
  let timestamp = 730;
  const store = new AgentRunStore(root, { now: () => timestamp });
  const create = () => store.create({
    runId: "audit-bronze", conversationId: "dialog-bronze", messages: [{ role: "user", content: "Inventory contracts" }],
    request: { provider: "custom", model: "fixture-model", mode: "work", contextWindowTokens: 64000, promptFingerprint: "prompt-bronze", toolSchemaFingerprint: "tools-bronze" },
  });
  create();
  disposals.push(() => { if (store.get("audit-bronze")?.status === "running") store.markTerminal("audit-bronze", "completed"); fs.rmSync(root, { recursive: true, force: true }); });
  const location = (name: string) => path.join(root, "firefly-runs", name);
  const index = () => JSON.parse(fs.readFileSync(location("index.json"), "utf8"));
  return { root, store, create, location, index, tick: () => ++timestamp };
}
const readCall = (toolCallId: string, status: "planned" | "started" | "committed" = "planned") =>
  ({ toolCallId, status, toolName: "read_file", sideEffect: "read_only" as const });

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of disposals.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("loaded-run cache and evidence reads", () => {
  it("serves repeated reads and checkpoints from memory instead of re-reading the session file", () => {
    const { store } = storage();
    const read = vi.spyOn(fs, "readFileSync");
    for (let i = 0; i < 5; i++) { store.get("audit-bronze"); store.evidence("audit-bronze"); }
    store.checkpoint("audit-bronze", { rounds: 2 });
    expect(read.mock.calls.filter(([file]) => String(file).endsWith("audit-bronze.json"))).toHaveLength(0);
  });
  it("evidence carries identity, status and tool calls only, and reflects every write", () => {
    const { store } = storage();
    store.recordTools("audit-bronze", [readCall("scan-east")]);
    const evidence = store.evidence("audit-bronze")!;
    expect(Object.keys(evidence).sort()).toEqual(["conversationId", "runId", "status", "toolCalls"]);
    expect(evidence.toolCalls.map(call => call.toolCallId)).toEqual(["scan-east"]);
    evidence.toolCalls.length = 0;
    store.markTerminal("audit-bronze", "completed");
    expect(store.evidence("audit-bronze")).toMatchObject({ status: "completed", toolCalls: [expect.objectContaining({ toolCallId: "scan-east" })] });
  });
  it("evidence for more runs than the session cache holds is still served without re-reading run files", () => {
    // A long conversation references dozens of runs; reading them in a cycle must not thrash back to disk.
    const { root } = storage();
    const writer = new AgentRunStore(root);
    const ids = Array.from({ length: 40 }, (_, index) => `cycle-${index}`);
    for (const runId of ids) writer.create({ runId, conversationId: "dialog-cycle", messages: [{ role: "user", content: runId }],
      request: { provider: "custom", model: "fixture-model", contextWindowTokens: 64000, promptFingerprint: "p", toolSchemaFingerprint: "t" } });
    const reader = new AgentRunStore(root);
    for (const runId of ids) expect(reader.evidence(runId)?.runId).toBe(runId);
    const read = vi.spyOn(fs, "readFileSync");
    for (let pass = 0; pass < 3; pass++) for (const runId of ids) reader.evidence(runId);
    expect(read.mock.calls.filter(([file]) => String(file).includes("cycle-"))).toHaveLength(0);
    for (const runId of ids) writer.markTerminal(runId, "completed");
  });
  it("a failed write leaves memory at what disk holds, not ahead of it", () => {
    const { store } = storage();
    const rename = fs.renameSync.bind(fs);
    const failing = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.recordTools("audit-bronze", [readCall("lost-call")])).toThrow("disk full");
    failing.mockImplementation(rename);
    expect(store.get("audit-bronze")?.toolCalls).toEqual([]);
    expect(store.evidence("audit-bronze")?.toolCalls).toEqual([]);
    store.recordTools("audit-bronze", [readCall("kept-call")]);
    expect(store.get("audit-bronze")?.toolCalls.map(call => call.toolCallId)).toEqual(["kept-call"]);
  });
  it("a new store instance reads what the previous one wrote, and deletion is not served from memory", () => {
    const { root, store } = storage();
    store.checkpoint("audit-bronze", { rounds: 3 });
    expect(new AgentRunStore(root).get("audit-bronze")?.rounds).toBe(3);
    store.deleteConversation("dialog-bronze");
    expect(store.get("audit-bronze")).toBeNull();
    expect(store.evidence("audit-bronze")).toBeNull();
  });
});

describe("insertion receipt evidence", () => {
  const receipt = { messageId: "inserted-message", sourceRunId: "audit-bronze", revision: 2, round: 3, order: 1 };

  it("projects only the saved receipt after reopening and evicting a run with a megabyte of messages", () => {
    const { root, store, location } = storage();
    store.checkpoint("audit-bronze", { messages: [{ role: "user", content: "a".repeat(1024 * 1024) }], insertions: [receipt] });
    store.markTerminal("audit-bronze", "completed");
    const request = { provider: "custom", model: "fixture-model", contextWindowTokens: 64000, promptFingerprint: "p", toolSchemaFingerprint: "t" };
    for (let index = 0; index < 30; index++) {
      const runId = `later-run-${index}`;
      store.create({ runId, conversationId: "dialog-later", messages: [], request });
      store.markTerminal(runId, "completed");
    }
    const reopened = new AgentRunStore(root);
    const read = vi.spyOn(fs, "readFileSync");
    const evidence = reopened.insertionEvidence("audit-bronze");
    expect(evidence).toEqual({ conversationId: "dialog-bronze", insertions: [receipt] });
    evidence!.insertions![0].round = 99;
    expect(reopened.insertionEvidence("audit-bronze")).toEqual({ conversationId: "dialog-bronze", insertions: [receipt] });
    expect(read.mock.calls.filter(([file]) => file === location("sessions/audit-bronze.json"))).toHaveLength(0);
  });

  it("keeps the last persisted receipt after a failed write and clears it after deletion", () => {
    const { store } = storage();
    expect(store.insertionEvidence("audit-bronze")).toEqual({ conversationId: "dialog-bronze", insertions: [] });
    store.checkpoint("audit-bronze", { insertions: [receipt] });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.checkpoint("audit-bronze", { insertions: [{ ...receipt, round: 9 }] })).toThrow("disk full");
    expect(store.insertionEvidence("audit-bronze")).toEqual({ conversationId: "dialog-bronze", insertions: [receipt] });
    store.deleteConversation("dialog-bronze");
    expect(store.insertionEvidence("audit-bronze")).toBeNull();
  });

  it("returns null for an unreadable snapshot without rewriting it", () => {
    const { store, location } = storage();
    const damaged = location("sessions/damaged-run.json");
    fs.writeFileSync(damaged, '{"schemaVersion":1,"conversationId":"dialog-bronze","messages":[', "utf8");
    expect(store.insertionEvidence("damaged-run")).toBeNull();
    expect(fs.readFileSync(damaged, "utf8")).toBe('{"schemaVersion":1,"conversationId":"dialog-bronze","messages":[');
  });
});

describe("Durable main-run ledger", () => {
  it("writes one session for a planned batch while journaling each call in order", () => {
    const { store, location } = storage();
    const batch = ["scan-east", "scan-west", "scan-north"].map(id => readCall(id));
    const rename = vi.spyOn(fs, "renameSync");
    store.recordTools("audit-bronze", batch);
    expect(rename.mock.calls.filter(([, target]) => target === location("sessions/audit-bronze.json"))).toHaveLength(1);
    const persisted = JSON.parse(fs.readFileSync(location("sessions/audit-bronze.json"), "utf8"));
    expect(persisted.toolCalls.map((c: {toolCallId: string; status: string}) => [c.toolCallId, c.status])).toEqual([
      ["scan-east", "planned"], ["scan-west", "planned"], ["scan-north", "planned"],
    ]);
    const events = fs.readFileSync(location("sessions/audit-bronze.events.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
    expect(events.filter(row => row.type === "tool_planned").map(row => row.toolCallId)).toEqual(["scan-east", "scan-west", "scan-north"]);
    batch[0].toolName = "mutated-caller-reference";
    expect(store.get("audit-bronze")?.toolCalls[0].toolName).toEqual("read_file");
  });

  it("updates an existing call in place and appends new lifecycle identities only once", () => {
    const { store } = storage();
    store.recordTool("audit-bronze", readCall("scan-east"));
    store.recordTools("audit-bronze", [readCall("scan-east", "started"), { toolCallId: "write-summary", status: "planned", toolName: "write_file", sideEffect: "idempotent_mutation" }]);
    expect(store.get("audit-bronze")?.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: "scan-east", status: "started" }),
      expect.objectContaining({ toolCallId: "write-summary", status: "planned" }),
    ]);
  });

  it("checkpoints rounds, notebook, full-output references and committed cache epochs independently of chat", () => {
    const { store, tick, location } = storage();
    tick();
    const output = { recordId: "b".repeat(64), resultRef: "tool-result://v1/bronze", runId: "audit-bronze", toolCallId: "scan-east", toolName: "read_file", bytes: 12, codePoints: 12, truncatedForModel: false, createdAt: 731 };
    store.checkpoint("audit-bronze", { rounds: 4, todoItems: [{ id: "audit", content: "Inspect contracts", status: "in_progress" }], toolOutputs: [output], cache: { cacheEpoch: 3, epochReason: "compaction" } });
    expect(store.get("audit-bronze")).toMatchObject({
      status: "running", rounds: 4, state: { todoItems: [{ id: "audit", status: "in_progress" }] }, toolOutputs: [output], cache: { cacheEpoch: 3, epochReason: "compaction" },
    });
    expect(fs.existsSync(location("sessions/audit-bronze.json"))).toBe(true);
  });

  it("isolates both returned snapshots and live checkpoint inputs", () => {
    const { store } = storage();
    store.recordTool("audit-bronze", { toolCallId: "save-note", toolName: "write_file", sideEffect: "idempotent_mutation", status: "started" });
    store.get("audit-bronze")!.messages.push({ role: "assistant", content: "Caller-only text" });
    expect(store.get("audit-bronze")?.messages).toEqual([{ role: "user", content: "Inventory contracts" }]);
    expect(store.get("audit-bronze")?.toolCalls).toEqual([expect.objectContaining({ toolCallId: "save-note", status: "started" })]);
    const messages: ChatMessage[] = [{ role: "user", content: "checkpoint input" }];
    const state: AgentState = { uncertainEffects: [], todoItems: [] };
    store.checkpoint("audit-bronze", { messages, state });
    messages.push({ role: "assistant", content: "Later mutation" });
    state.todoItems.push({ id: "later-note", content: "Later task", status: "pending" });
    expect(store.get("audit-bronze")?.messages).toEqual([{ role: "user", content: "checkpoint input" }]);
    expect(store.get("audit-bronze")?.state.todoItems).toEqual([]);
  });

  it("interrupts a running record on restart and locates it by conversation", () => {
    const { root } = storage();
    const reopened = new AgentRunStore(root);
    expect(reopened.get("audit-bronze")).toMatchObject({ runId: "audit-bronze", status: "interrupted" });
    expect(reopened.getLatestInterrupted("dialog-bronze")?.runId).toEqual("audit-bronze");
  });

  it("rejects a live duplicate but permits replacement of a terminal record", () => {
    const { store, create } = storage();
    expect(create).toThrow("AGENT_RUN_EXISTS");
    store.markTerminal("audit-bronze", "completed");
    expect(create()).toMatchObject({ runId: "audit-bronze", status: "running", rounds: 0 });
  });

  it("serializes session and index as valid JSON without formatting newlines", () => {
    const { location } = storage();
    const rawSession = fs.readFileSync(location("sessions/audit-bronze.json"), "utf8");
    const rawIndex = fs.readFileSync(location("index.json"), "utf8");
    expect(rawSession).not.toContain("\n");
    expect(rawIndex).not.toContain("\n");
    expect(JSON.parse(rawSession)).toMatchObject({ runId: "audit-bronze" });
    expect(JSON.parse(rawIndex)).toEqual([expect.objectContaining({ runId: "audit-bronze" })]);
  });

  it("coalesces hot-path index updates until 500ms while session reads remain current", () => {
    vi.useFakeTimers();
    const { store, location, tick, index } = storage();
    const initial = fs.readFileSync(location("index.json"), "utf8");
    const rename = vi.spyOn(fs, "renameSync");
    tick();
    store.recordTool("audit-bronze", readCall("scan-east", "started"));
    store.recordTool("audit-bronze", readCall("scan-east", "committed"));
    store.checkpoint("audit-bronze", { rounds: 4 });
    expect(fs.readFileSync(location("index.json"), "utf8")).toEqual(initial);
    vi.advanceTimersByTime(499);
    expect(fs.readFileSync(location("index.json"), "utf8")).toEqual(initial);
    vi.advanceTimersByTime(1);
    expect(index()).toEqual([expect.objectContaining({ runId: "audit-bronze", status: "running", updatedAt: 731 })]);
    expect(rename.mock.calls.filter(([, target]) => target === location("index.json"))).toHaveLength(1);
    expect(store.get("audit-bronze")).toMatchObject({ rounds: 4 });
    expect(store.get("audit-bronze")?.toolCalls).toHaveLength(1);
  });

  it("flushes terminal state immediately and prevents a deferred callback from restoring stale state", () => {
    vi.useFakeTimers();
    const { store, index } = storage();
    store.recordTool("audit-bronze", readCall("scan-east", "committed"));
    store.markTerminal("audit-bronze", "completed");
    expect(index()).toEqual([expect.objectContaining({ runId: "audit-bronze", status: "completed" })]);
    vi.advanceTimersByTime(1000);
    expect(index()).toEqual([expect.objectContaining({ runId: "audit-bronze", status: "completed" })]);
  });

  it("repairs stale index status from session truth and removes rows without session files", () => {
    const { root, store, index, location } = storage();
    store.markTerminal("audit-bronze", "completed");
    const stale = index();
    stale[0].status = "running";
    fs.writeFileSync(location("index.json"), JSON.stringify(stale));
    new AgentRunStore(root);
    expect(index()).toEqual([expect.objectContaining({ runId: "audit-bronze", status: "completed" })]);
    fs.rmSync(location("sessions/audit-bronze.json"));
    new AgentRunStore(root);
    expect(index()).toEqual([]);
  });

  it("reports run identity and terminal status in write metrics", () => {
    const { store } = storage();
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    store.recordTool("audit-bronze", readCall("scan-east", "committed"));
    store.checkpoint("audit-bronze", { rounds: 1 });
    store.markTerminal("audit-bronze", "completed");
    const metric = log.mock.calls.map(args => args.join(" ")).find(line => line.includes("terminal="));
    expect(metric).toBeDefined();
    expect(metric).toMatch(/audit-bronze/);
    expect(metric).toMatch(/completed/);
  });
});

describe("insertion receipts (#96)", () => {
  const receipt = (messageId: string, order: number, round = 1) => ({ messageId, revision: 1, sourceRunId: "audit-bronze", round, order });
  const validReceipt = receipt("note-1", 1);
  const neighbour = (store: AgentRunStore) => store.create({
    runId: "audit-silver", conversationId: "dialog-bronze", messages: [{ role: "user", content: "Neighbour" }],
    request: { provider: "custom", model: "fixture-model", contextWindowTokens: 64000, promptFingerprint: "p", toolSchemaFingerprint: "t" },
  });

  it("a new run starts with an empty delivered list", () => {
    const { store } = storage();
    expect(store.get("audit-bronze")?.insertions).toEqual([]);
  });

  it("checkpointed receipts keep their order across a reopen and are copied, not aliased", () => {
    const { root, store } = storage();
    const input = [receipt("note-1", 1, 0), receipt("note-2", 2, 3)];
    store.checkpoint("audit-bronze", { insertions: input });
    input[0].messageId = "mutated-after-call";
    input.pop();
    const expected = [receipt("note-1", 1, 0), receipt("note-2", 2, 3)];
    expect(store.get("audit-bronze")?.insertions).toEqual(expected);
    expect(new AgentRunStore(root).get("audit-bronze")?.insertions).toEqual(expected);
  });

  it("a checkpoint without insertions keeps the stored list exactly", () => {
    const { root, store } = storage();
    const stored = [receipt("note-1", 1), receipt("note-2", 2)];
    store.checkpoint("audit-bronze", { insertions: stored });
    store.checkpoint("audit-bronze", { rounds: 5 });
    expect(store.get("audit-bronze")).toMatchObject({ rounds: 5, insertions: stored });
    expect(new AgentRunStore(root).get("audit-bronze")?.insertions).toEqual(stored);
  });

  it("a checkpoint with an empty list replaces the stored receipts", () => {
    const { store } = storage();
    store.checkpoint("audit-bronze", { insertions: [validReceipt] });
    store.checkpoint("audit-bronze", { insertions: [] });
    expect(store.get("audit-bronze")?.insertions).toEqual([]);
  });

  it("a session file saved before the field existed loads with insertions unknown, not empty", () => {
    const { root, location } = storage();
    const file = location("sessions/audit-bronze.json");
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    delete legacy.insertions;
    fs.writeFileSync(file, JSON.stringify(legacy));
    const loaded = new AgentRunStore(root).get("audit-bronze");
    expect(loaded).toMatchObject({ runId: "audit-bronze", status: "interrupted" });
    expect(loaded?.insertions).toBeUndefined();
  });

  const invalid: Array<[string, unknown]> = [
    ["a non-array value", { messageId: "note-1" }],
    ["a string value", "note-1"],
    ["an empty messageId", [{ ...validReceipt, messageId: "" }]],
    ["a numeric messageId", [{ ...validReceipt, messageId: 7 }]],
    ["a non-string sourceRunId", [{ ...validReceipt, sourceRunId: 1 }]],
    ["a zero revision", [{ ...validReceipt, revision: 0 }]],
    ["a fractional revision", [{ ...validReceipt, revision: 1.5 }]],
    ["a negative round", [{ ...validReceipt, round: -1 }]],
    ["a fractional round", [{ ...validReceipt, round: 0.5 }]],
    ["a zero order", [{ ...validReceipt, order: 0 }]],
    ["a missing order", [{ messageId: "note-1", revision: 1, sourceRunId: "audit-bronze", round: 1 }]],
    ["a null entry", [null]],
    ["a bad entry after a good one", [validReceipt, { ...validReceipt, order: -2 }]],
  ];
  it.each(invalid)("a stored session with %s fails to load while a valid neighbour still loads", (_name, bad) => {
    const { root, store, location } = storage();
    neighbour(store);
    const file = location("sessions/audit-bronze.json");
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    session.insertions = bad;
    const corrupt = JSON.stringify(session);
    fs.writeFileSync(file, corrupt);
    // Opening a store reads every indexed session, so the corrupt run fails the open like any other corrupt file.
    expect(() => new AgentRunStore(root)).toThrow("AGENT_RUN_READ_FAILED");
    // Without its index row the corrupt run is only read on demand, which must fail while its neighbour is unaffected.
    fs.writeFileSync(location("index.json"), JSON.stringify(JSON.parse(fs.readFileSync(location("index.json"), "utf8")).filter((row: { runId: string }) => row.runId !== "audit-bronze")));
    const reopened = new AgentRunStore(root);
    expect(() => reopened.get("audit-bronze")).toThrow("AGENT_RUN_READ_FAILED");
    expect(reopened.get("audit-silver")).toMatchObject({ runId: "audit-silver", insertions: [] });
    expect(fs.readFileSync(file, "utf8")).toBe(corrupt);
    store.markTerminal("audit-silver", "completed");
  });
});
