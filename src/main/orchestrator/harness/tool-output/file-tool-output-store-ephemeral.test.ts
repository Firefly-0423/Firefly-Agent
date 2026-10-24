import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephemeralConversations } from "../../../ephemeral-conversations";
import { FileToolOutputStore } from "./file-tool-output-store";

const roots: string[] = [], marked: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const id of marked.splice(0)) ephemeralConversations.release(id);
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-tool-output-ephemeral-"));
  roots.push(root);
  const temp = "temp-" + Math.random().toString(36).slice(2);
  ephemeralConversations.mark(temp); marked.push(temp);
  return { root, temp };
}
const put = (conversationId: string, output: string, toolCallId = "call-1") => ({
  conversationId, runId: "run-1", toolCallId, toolName: "web_fetch", outcome: "success" as const, output, truncatedForModel: false,
});
const files = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);

describe("FileToolOutputStore for a temporary conversation", () => {
  it("serves put, read and find from memory and writes no file", async () => {
    const { root, temp } = setup();
    const store = new FileToolOutputStore(root);
    const ref = await store.put(put(temp, "alpha beta gamma private"));
    expect(ref.codePoints).toBe(24);
    expect(await store.read({ conversationId: temp, resultRef: ref.resultRef, offset: 6, length: 4 })).toMatchObject({ content: "beta", totalCodePoints: 24 });
    expect((await store.find({ conversationId: temp, resultRef: ref.resultRef, query: "gamma" }))?.matches[0].offset).toBe(11);
    expect(files(root)).toEqual([]);
  });

  it("is idempotent for the same call and enforces the owner session", async () => {
    const { root, temp } = setup();
    const store = new FileToolOutputStore(root);
    const first = await store.put({ ...put(temp, "same"), ownerSessionId: "owner-a" });
    expect(await store.put({ ...put(temp, "same"), ownerSessionId: "owner-a" })).toEqual(first);
    expect(await store.read({ conversationId: temp, resultRef: first.resultRef, offset: 0, length: 4, ownerSessionId: "owner-b" })).toBeNull();
    expect(await store.read({ conversationId: temp, resultRef: first.resultRef, offset: 0, length: 4, ownerSessionId: "owner-a" })).toMatchObject({ content: "same" });
  });

  it("is shared by every store instance of the process and gone after conversation delete", async () => {
    const { root, temp } = setup();
    const store = new FileToolOutputStore(root);
    const ref = await store.put(put(temp, "short-lived"));
    expect(await new FileToolOutputStore(root).read({ conversationId: temp, resultRef: ref.resultRef, offset: 0, length: 5 })).toMatchObject({ content: "short" });
    expect(files(root)).toEqual([]);
    await store.deleteConversation(temp);
    expect(await store.read({ conversationId: temp, resultRef: ref.resultRef, offset: 0, length: 5 })).toBeNull();
  });

  it("keeps ordinary conversations on disk", async () => {
    const { root } = setup();
    const ref = await new FileToolOutputStore(root).put(put("ordinary", "kept"));
    expect(files(root).sort()).toEqual(["meta.json", "output.txt"]);
    expect(await new FileToolOutputStore(root).read({ conversationId: "ordinary", resultRef: ref.resultRef, offset: 0, length: 4 })).toMatchObject({ content: "kept" });
  });
});
