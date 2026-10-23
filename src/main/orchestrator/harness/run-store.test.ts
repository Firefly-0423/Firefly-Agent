import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessRunStore } from "./run-store";
import type { AgentState } from "./types";
import type { ChatMessage } from "../vendors/types";

const disposals: Array<() => void> = [];
function storage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-"));
  let timestamp = 730;
  const store = new HarnessRunStore(root, { now: () => timestamp });
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
    const reopened = new HarnessRunStore(root);
    expect(reopened.get("audit-bronze")).toMatchObject({ runId: "audit-bronze", status: "interrupted" });
    expect(reopened.getLatestInterrupted("dialog-bronze")?.runId).toEqual("audit-bronze");
  });

  it("rejects a live duplicate but permits replacement of a terminal record", () => {
    const { store, create } = storage();
    expect(create).toThrow("HARNESS_RUN_EXISTS");
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
    new HarnessRunStore(root);
    expect(index()).toEqual([expect.objectContaining({ runId: "audit-bronze", status: "completed" })]);
    fs.rmSync(location("sessions/audit-bronze.json"));
    new HarnessRunStore(root);
    expect(index()).toEqual([]);
  });

  it("reports run identity and terminal status in write metrics", () => {
    const { store } = storage();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    store.recordTool("audit-bronze", readCall("scan-east", "committed"));
    store.checkpoint("audit-bronze", { rounds: 1 });
    store.markTerminal("audit-bronze", "completed");
    const metric = log.mock.calls.map(args => args.join(" ")).find(line => line.includes("HarnessRunStore"));
    expect(metric).toBeDefined();
    expect(metric).toMatch(/audit-bronze/);
    expect(metric).toMatch(/completed/);
  });
});
