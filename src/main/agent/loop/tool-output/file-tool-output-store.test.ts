import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileToolOutputStore, ToolOutputCorruptError, ToolOutputInvalidInputError, toolOutputRecordId } from "./file-tool-output-store";

const temporaryRoots: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const invocation = (output = "Saved analysis"): Parameters<FileToolOutputStore["put"]>[0] => ({
  conversationId: "dialog-silver", runId: "run-silver", toolCallId: "lookup-silver", toolName: "search_code", outcome: "success", output, truncatedForModel: output.length > 8192,
});
async function openStore() {
  const root = await mkdtemp(path.join(tmpdir(), "output-vault-"));
  temporaryRoots.push(root);
  return { root, store: new FileToolOutputStore(root, { now: () => 970 }) };
}
const range = (resultRef: string, offset = 0, length = 8192) => ({ resultRef, conversationId: "dialog-silver", offset, length });
const recordPath = (root: string, recordId: string, file: string) => path.join(root, "firefly-runs", "tool-results", digest("dialog-silver"), "records", recordId, file);
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("Opaque durable tool output", () => {
  it("hashes the complete invocation identity with zero-byte separators", () => {
    const id = toolOutputRecordId("dialog-silver", "run-silver", "lookup-silver");
    expect(id).toEqual(digest("dialog-silver\0run-silver\0lookup-silver"));
    expect(toolOutputRecordId("dialog-silver", "run-silver", "lookup-silver")).toEqual(id);
    expect(toolOutputRecordId("dialog-silver", "another-run", "lookup-silver")).not.toBe(id);
  });

  it("preserves the first complete output on replay and persists verifiable metadata", async () => {
    const { root, store } = await openStore();
    const text = "OPEN😀CENTER流萤CLOSE";
    const first = await store.put(invocation(text));
    expect(await store.put(invocation("A later retry must not overwrite saved facts"))).toEqual(first);
    expect(first).toMatchObject({ resultRef: `tool-result://v1/${first.recordId}`, bytes: Buffer.byteLength(text), codePoints: 18, createdAt: 970 });
    expect(first.codePoints).toEqual([...text].length);
    await expect(store.read(range(first.resultRef))).resolves.toMatchObject({ content: text, totalCodePoints: 18 });
    expect(JSON.parse(await readFile(recordPath(root, first.recordId, "meta.json"), "utf8"))).toMatchObject({
      schemaVersion: 1, recordId: first.recordId, toolCallId: "lookup-silver", sha256: digest(text),
    });
    expect(await readFile(recordPath(root, first.recordId, "output.txt"), "utf8")).toEqual(text);
  });

  it("uses code points for page starts, lengths and offsets past the end", async () => {
    const { store } = await openStore();
    const ref = await store.put(invocation("Q🪁R𠮷S"));
    const pages = await Promise.all([[0, 3], [1, 3], [4, 8], [20, 3]].map(([offset, length]) => store.read(range(ref.resultRef, offset, length))));
    expect(pages.map(page => [page?.content, page?.totalCodePoints])).toEqual([["Q🪁R", 5], ["🪁R𠮷", 5], ["S", 5], ["", 5]]);
  });

  it("reads the tail of a large result without constructing an array for the entire text", async () => {
    const { store } = await openStore();
    const output = "🪁q".repeat(40000);
    const ref = await store.put(invocation(output));
    const originalFrom = Array.from;
    const allocation = vi.spyOn(Array, "from").mockImplementation(function (value: unknown, ...rest: unknown[]) {
      if (value === output) throw new Error("Unbounded full-output allocation");
      return Reflect.apply(originalFrom, Array, [value, ...rest]);
    } as typeof Array.from);
    try {
      await expect(store.read(range(ref.resultRef, 79997, 3))).resolves.toMatchObject({ content: "q🪁q", totalCodePoints: 80000 });
    } finally { allocation.mockRestore(); }
  });

  it("detects same-size tampering even after the original output has been read", async () => {
    const { root, store } = await openStore();
    const ref = await store.put(invocation("verified"));
    await expect(store.read(range(ref.resultRef, 0, 8))).resolves.toMatchObject({ content: "verified" });
    await writeFile(recordPath(root, ref.recordId, "output.txt"), "modified");
    await expect(store.read(range(ref.resultRef, 0, 8))).rejects.toBeInstanceOf(ToolOutputCorruptError);
  });

  it("enforces owner identity across reopen, replay and ownerless legacy records", async () => {
    const { root, store } = await openStore();
    const owned = { ...invocation(), ownerSessionId: "specialist-silver" };
    const ref = await store.put(owned);
    const reopened = new FileToolOutputStore(root);
    const request = range(ref.resultRef, 0, 100);
    await expect(reopened.read({ ...request, ownerSessionId: "specialist-gold" })).resolves.toBeNull();
    await expect(reopened.find({ ...request, query: "Saved", ownerSessionId: "specialist-gold" })).resolves.toBeNull();
    await expect(reopened.read({ ...request, ownerSessionId: owned.ownerSessionId })).resolves.toMatchObject({ content: owned.output });
    await expect(reopened.put({ ...owned, ownerSessionId: "specialist-gold" })).rejects.toBeInstanceOf(ToolOutputCorruptError);
    await expect(reopened.put(invocation())).rejects.toBeInstanceOf(ToolOutputCorruptError);
    expect(await reopened.put(owned)).toEqual(ref);
    const legacy = await reopened.put({ ...invocation(), toolCallId: "ownerless-silver" });
    await expect(reopened.put({ ...owned, toolCallId: "ownerless-silver" })).rejects.toBeInstanceOf(ToolOutputCorruptError);
    await expect(reopened.read({ ...request, resultRef: legacy.resultRef, ownerSessionId: owned.ownerSessionId })).resolves.toBeNull();
    await expect(reopened.read(request)).resolves.toMatchObject({ content: owned.output });
  });

  it("does not resolve an opaque reference in another conversation", async () => {
    const { store } = await openStore();
    const ref = await store.put(invocation());
    await expect(store.read({ ...range(ref.resultRef, 0, 100), conversationId: "dialog-gold" })).resolves.toBeNull();
  });

  it("reports search positions in the same Unicode coordinates consumed by reads", async () => {
    const { store } = await openStore();
    const ref = await store.put(invocation("abc🪁def星海ghi"));
    const found = await store.find({ conversationId: "dialog-silver", resultRef: ref.resultRef, query: "星海" });
    expect(found?.matches).toHaveLength(1);
    expect(found?.matches[0].offset).toEqual(7);
    await expect(store.read(range(ref.resultRef, found!.matches[0].offset, 2))).resolves.toMatchObject({ content: "星海" });
  });

  it("rejects invalid ranges and changed-size corruption with their typed errors", async () => {
    const { root, store } = await openStore();
    const ref = await store.put(invocation("Known data"));
    await expect(store.read(range(ref.resultRef, -1, 10))).rejects.toBeInstanceOf(ToolOutputInvalidInputError);
    await writeFile(recordPath(root, ref.recordId, "output.txt"), "Unexpected replacement data");
    await expect(store.read(range(ref.resultRef, 0, 10))).rejects.toBeInstanceOf(ToolOutputCorruptError);
  });
});
