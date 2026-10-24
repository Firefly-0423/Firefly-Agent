import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephemeralConversations } from "../ephemeral-conversations";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptAppendInput } from "./conversation-transcript-types";

const roots: string[] = [], marked: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const id of marked.splice(0)) ephemeralConversations.release(id);
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-transcript-ephemeral-"));
  roots.push(root);
  const ephemeral = "temp-" + Math.random().toString(36).slice(2), persistent = "keep-" + Math.random().toString(36).slice(2);
  ephemeralConversations.mark(ephemeral); marked.push(ephemeral);
  return { root, store: new ConversationTranscriptStore(root, { now: () => 1_000 }), ephemeral, persistent, dir: path.join(root, "transcripts") };
}
const user = (id: string, turnId: string, text: string): TranscriptAppendInput => ({ id, at: 1_000, kind: "user", turnId, revision: 1, payload: { text } });
const assistant = (id: string, text: string): TranscriptAppendInput => ({ id, at: 1_000, kind: "assistant", runId: "run-1", turnId: "a1", payload: { role: "assistant", content: text } });

describe("ConversationTranscriptStore for a temporary conversation", () => {
  it("keeps every entry readable in memory without creating any file or directory", async () => {
    const f = setup();
    const first = await f.store.append(f.ephemeral, user("e1", "u1", "secret plan"));
    await f.store.append(f.ephemeral, assistant("e2", "ok"));
    expect(first.seq).toBe(1);
    expect((await f.store.read(f.ephemeral)).entries.map(entry => entry.id)).toEqual(["e1", "e2"]);
    await f.store.checkpoint(f.ephemeral);
    expect((await f.store.read(f.ephemeral)).throughSeq).toBe(2);
    expect(fs.existsSync(f.dir)).toBe(false);
  });

  it("keeps idempotence, conflict detection and read leases working", async () => {
    const f = setup();
    await f.store.append(f.ephemeral, user("e1", "u1", "hello"));
    expect((await f.store.append(f.ephemeral, user("e1", "u1", "hello"))).id).toBe("e1");
    await expect(f.store.append(f.ephemeral, user("e2", "u1", "changed"))).rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
    const seen = await f.store.withReadLease(f.ephemeral, async read => (await read()).entries.length);
    expect(seen).toBe(1);
  });

  it("notifies the mutation observer exactly as the file-backed store does", async () => {
    const f = setup(), kinds: string[] = [];
    f.store.observeMutations(f.ephemeral, async kind => { kinds.push(kind); });
    await f.store.append(f.ephemeral, user("e1", "u1", "hello"));
    await f.store.deleteConversation(f.ephemeral);
    expect(kinds).toEqual(["append", "delete"]);
  });

  it("forgets everything on delete and starts empty again", async () => {
    const f = setup();
    await f.store.append(f.ephemeral, user("e1", "u1", "hello"));
    await f.store.deleteConversation(f.ephemeral);
    expect((await f.store.read(f.ephemeral)).entries).toEqual([]);
    expect(fs.existsSync(f.dir)).toBe(false);
  });

  it("does not leak into another store instance (nothing durable exists)", async () => {
    const f = setup();
    await f.store.append(f.ephemeral, user("e1", "u1", "hello"));
    const reopened = new ConversationTranscriptStore(f.root, { now: () => 1_000 });
    expect((await reopened.read(f.ephemeral)).entries).toEqual([]);
  });

  it("leaves ordinary conversations on disk exactly as before", async () => {
    const f = setup();
    await f.store.append(f.persistent, user("e1", "u1", "hello"));
    expect(fs.existsSync(path.join(f.dir, f.persistent, "transcript.jsonl"))).toBe(true);
    const reopened = new ConversationTranscriptStore(f.root, { now: () => 1_000 });
    expect((await reopened.read(f.persistent)).entries.map(entry => entry.id)).toEqual(["e1"]);
  });
});
