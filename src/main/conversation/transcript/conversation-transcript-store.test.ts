import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptAppendInput, TranscriptSnapshot } from "./conversation-transcript-types";

const directories: string[] = [];
function storage() {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-agenda-log-contract-"));
  directories.push(directory);
  return { store: new ConversationTranscriptStore(directory, { now: () => 840 }), directory, file: (room = "agenda") => path.join(directory, "transcripts", room, "transcript.jsonl") };
}
const user = (id: string, text = "Show appointments", turnId = id, revision = 1): TranscriptAppendInput => ({ id, at: 840, kind: "user", turnId, revision, payload: { text } });
const assistant = (): TranscriptAppendInput => ({ at: 840, kind: "assistant", id: "agenda-answer", payload: { role: "assistant", content: "Tuesday is available" } });
function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("Durable transcript sequencing and recovery", () => {
  it("absorbs entry retries, rejects conflicting user revisions and sequences concurrent appends", async () => {
    const { store } = storage();
    const first = await store.append("agenda", user("question-original"));
    expect(first.seq).toEqual(1);
    expect((await store.append("agenda", user("question-original"))).id).toEqual("question-original");
    expect((await store.read("agenda")).entries).toHaveLength(1);
    await expect(store.append("agenda", user("question-conflict", "Different schedule", "question-original"))).rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.append("parallel", user("question-" + index, "Day " + index))));
    expect((await store.read("parallel")).entries.map(({ seq }) => seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("repairs a partial last line and replays subsequent rows after a checkpoint", async () => {
    const { store, file } = storage();
    await store.append("agenda", user("question-morning"));
    await fs.promises.appendFile(file(), '{"seq":2,"id":"unfinished-agenda"', "utf8");
    await store.append("agenda", user("question-evening"));
    expect((await store.read("agenda")).entries.map(({ id }) => id)).toEqual(["question-morning", "question-evening"]);
    await store.checkpoint("agenda");
    await store.append("agenda", user("question-tomorrow"));
    const replay = await store.read("agenda");
    expect(replay.throughSeq).toEqual(3);
    expect(replay.entries.map(({ id }) => id)).toEqual(["question-morning", "question-evening", "question-tomorrow"]);
    expect((await store.append("agenda", user("question-morning", "Retry text"))).id).toEqual("question-morning");
  });

  it("rejects escaping IDs and deletes only the specified conversation", async () => {
    const { store, directory } = storage();
    for (const invalid of ["../outside", "agenda/nested"]) await expect(store.append(invalid, user("question"))).rejects.toThrow();
    await store.append("agenda", user("question-blue"));
    await store.append("other-agenda", user("question-gold"));
    await store.deleteConversation("agenda");
    expect(fs.existsSync(path.join(directory, "transcripts", "agenda"))).toEqual(false);
    expect((await store.read("other-agenda")).entries).toHaveLength(1);
  });
});

describe("Read leases and mutation observers", () => {
  it("holds an immutable read view until release and denies an escaped reader", async () => {
    const { store } = storage();
    await store.append("agenda", user("question-first"));
    const entered = latch(), held = latch();
    let escaped!: () => Promise<TranscriptSnapshot>;
    const lease = store.withReadLease("agenda", async (read) => {
      escaped = read;
      (await read()).entries[0].id = "mutated-copy";
      entered.release(); await held.promise;
      expect((await read()).entries[0].id).toEqual("question-first");
    });
    await entered.promise;
    let appended = false;
    const writing = store.append("agenda", user("question-second")).then(() => { appended = true; });
    await Promise.resolve(); expect(appended).toEqual(false);
    held.release(); await lease; await writing;
    await expect(escaped()).rejects.toThrow("TRANSCRIPT_LEASE_EXPIRED");
    expect((await store.read("agenda")).entries).toHaveLength(2);
  });

  it("leaves the transcript bytes intact if an observer refuses append or deletion", async () => {
    const { store, file } = storage();
    await store.append("agenda", user("question-first"));
    const original = fs.readFileSync(file());
    const unsubscribe = store.observeMutations("agenda", async () => { throw Error("S_INVALIDATION_REFUSED"); });
    await expect(store.append("agenda", user("question-second"))).rejects.toThrow("S_INVALIDATION_REFUSED");
    expect(fs.readFileSync(file())).toEqual(original);
    await expect(store.deleteConversation("agenda")).rejects.toThrow("S_INVALIDATION_REFUSED");
    expect(fs.readFileSync(file())).toEqual(original);
    unsubscribe();
    await store.append("agenda", user("question-second"));
    expect((await store.read("agenda")).entries).toHaveLength(2);
  });

  it("does no filesystem work under a readonly barrier even for missing or broken data", async () => {
    const { store, directory, file } = storage();
    await store.append("damaged", user("question-first"));
    await fs.promises.appendFile(file("damaged"), '{"incomplete-agenda"');
    const bytes = fs.readFileSync(file("damaged"));
    const probes = ["mkdir", "readFile", "writeFile", "appendFile", "truncate", "rename", "rm", "open"].map((method) => vi.spyOn(fs.promises, method as "readFile"));
    try {
      await store.withReadonlyBarrier("absent", async () => undefined);
      await store.withReadonlyBarrier("damaged", async () => undefined);
      probes.forEach((probe) => expect(probe).not.toHaveBeenCalled());
    } finally { probes.forEach((probe) => probe.mockRestore()); }
    expect(fs.existsSync(path.join(directory, "transcripts", "absent"))).toEqual(false);
    expect(fs.readFileSync(file("damaged"))).toEqual(bytes);
  });

  it("queues append and deletion behind a failing barrier and recovers for the next operation", async () => {
    const { store } = storage(), entered = latch(), held = latch();
    const barrier = store.withReadonlyBarrier("agenda", async () => { entered.release(); await held.promise; throw Error("Agenda barrier failed"); });
    const rejection = expect(barrier).rejects.toThrow("Agenda barrier failed");
    await entered.promise;
    const completed: string[] = [];
    const writing = store.append("agenda", user("question-first")).then(() => { completed.push("append"); });
    const deletion = store.deleteConversation("agenda").then(() => { completed.push("delete"); });
    await Promise.resolve(); expect(completed).toEqual([]);
    held.release(); await rejection; await writing; await deletion;
    expect(completed).toEqual(["append", "delete"]);
    expect(await store.withReadonlyBarrier("agenda", async () => 84)).toEqual(84);
    expect(() => store.withReadonlyBarrier("../outside", async () => 84)).toThrow("TRANSCRIPT_INVALID_CONVERSATION_ID");
  });
});

describe("S settlement envelope admission", () => {
  it.each([NaN, 2, 0])("rejects settlement version %s without storing an assistant", async (version) => {
    const { store } = storage();
    expect(() => store.append("agenda", { kind: "assistant", id: "agenda-answer", runId: "agenda-run", turnId: "answer-turn", sSettlement: { version, userTurnId: "question-turn", userRevision: 1 }, payload: { role: "assistant", content: "Schedule complete" } } as any)).toThrow("TRANSCRIPT_S_BINDING_INVALID");
    expect((await store.read("agenda")).entries).toEqual([]);
  });
  it("refuses a completed marker without its matching assistant", async () => {
    const { store } = storage();
    await expect(store.append("agenda", { kind: "assistant_settlement", id: "agenda-marker", runId: "agenda-run", turnId: "answer-turn", payload: { binding: { runId: "agenda-run", assistantTurnId: "answer-turn", userTurnId: "question-turn", userRevision: 1, assistantEntryId: "absent-answer" }, result: "success", safeReason: "completed" } } as any)).rejects.toThrow("TRANSCRIPT_S_BINDING_INVALID");
    expect((await store.read("agenda")).entries).toEqual([]);
  });
});

describe("Guarded append read ownership", () => {
  it("supports source reads in validation and commit but expires the exact ownership ticket", async () => {
    const { store } = storage();
    await store.append("agenda", user("question-first"));
    let ticket!: object;
    await store.append("agenda", assistant(), { throughSeq: 1,
      validate: async (issued) => { ticket = issued; expect((await store.withReadLease("agenda", (read) => read())).throughSeq).toEqual(1); },
      commit: async (write) => { expect((await store.withReadLease("agenda", (read) => read())).entries).toHaveLength(1); return write(); },
    });
    expect((await store.read("agenda")).throughSeq).toEqual(2);
    await expect(store.withHeldReadLease(ticket, "agenda", (read) => read())).rejects.toThrow("TRANSCRIPT_HELD_TICKET_DENIED");
  });

  it("does not grant an outside async chain or a forged ticket the guard's read scope", async () => {
    const { store } = storage(), entered = latch(), held = latch();
    await store.append("agenda", user("question-first"));
    const writing = store.append("agenda", assistant(), { throughSeq: 1,
      validate: async (ticket) => {
        await expect(store.withHeldReadLease({}, "agenda", (read) => read())).rejects.toThrow("TRANSCRIPT_HELD_TICKET_DENIED");
        await expect(store.withHeldReadLease(ticket, "another-agenda", (read) => read())).rejects.toThrow("TRANSCRIPT_HELD_TICKET_DENIED");
        entered.release(); await held.promise;
        expect((await store.withReadLease("agenda", (read) => read())).throughSeq).toEqual(1);
      }, commit: (write) => write(),
    });
    await entered.promise;
    let outside = false;
    const reading = store.withReadLease("agenda", async (read) => { outside = true; return read(); });
    await tick(); expect(outside).toEqual(false);
    held.release(); await writing;
    expect((await reading).throughSeq).toEqual(2);
  });

  it("drains forgotten validation reads before invoking commit or releasing outside readers", async () => {
    const { store } = storage(), entered = latch(), held = latch();
    await store.append("agenda", user("question-first"));
    let readDone = false, committed = false, outside = false;
    const writing = store.append("agenda", assistant(), { throughSeq: 1,
      validate: async () => { void store.withReadLease("agenda", async (read) => { await read(); entered.release(); await held.promise; readDone = true; }); },
      commit: (write) => { expect(readDone).toEqual(true); committed = true; return write(); },
    });
    await entered.promise;
    const reading = store.withReadLease("agenda", async (read) => { outside = true; return read(); });
    await tick(); expect(committed).toEqual(false); expect(outside).toEqual(false);
    held.release(); await writing;
    expect((await reading).throughSeq).toEqual(2);
  });

  it("rejects commit while an unawaited read remains and drains it before later work", async () => {
    const { store } = storage(), entered = latch(), held = latch();
    await store.append("agenda", user("question-first"));
    let settled = false, outside = false;
    const writing = store.append("agenda", assistant(), { throughSeq: 1, validate: async () => {},
      commit: async (write) => { void store.withReadLease("agenda", async () => { entered.release(); await held.promise; }); await entered.promise; return write(); },
    });
    const rejection = expect(writing).rejects.toThrow("TRANSCRIPT_HELD_READ_PENDING").then(() => { settled = true; });
    await entered.promise;
    const reading = store.withReadLease("agenda", async (read) => { outside = true; return read(); });
    await tick(); expect(settled).toEqual(false); expect(outside).toEqual(false);
    held.release(); await rejection;
    expect((await reading).entries.map(({ id }) => id)).toEqual(["question-first"]);
  });

  it("denies inherited async reads after append completion and propagates swallowed source failures", async () => {
    const { store } = storage(), held = latch();
    await store.append("agenda", user("question-first"));
    let late!: Promise<unknown>;
    await store.append("agenda", assistant(), { throughSeq: 1,
      validate: async () => { late = held.promise.then(() => store.withReadLease("agenda", (read) => read())); }, commit: (write) => write(),
    });
    const denied = expect(late).rejects.toThrow("TRANSCRIPT_HELD_TICKET_DENIED");
    held.release(); await denied;
    expect((await store.read("agenda")).throughSeq).toEqual(2);
    await expect(store.append("agenda", { ...assistant(), id: "agenda-second-answer" }, { throughSeq: 2, validate: async () => {},
      commit: async (write) => { await store.withReadLease("agenda", async () => { throw Error("Agenda source validation failed"); }).catch(() => {}); return write(); },
    })).rejects.toThrow("Agenda source validation failed");
    expect((await store.read("agenda")).entries.map(({ id }) => id)).toEqual(["question-first", "agenda-answer"]);
  });
});
