import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { executeReadToolResult } from "./read-tool-result";
import { FileToolOutputStore } from "./file-tool-output-store";

const sandboxes: string[] = [];
async function saved(output: string) {
  const root = await mkdtemp(path.join(tmpdir(), "result-reader-"));
  sandboxes.push(root);
  const store = new FileToolOutputStore(root);
  const ref = await store.put({ conversationId: "dialog-indigo", runId: "run-indigo", toolCallId: "query-indigo", toolName: "search_code", output, outcome: "success", truncatedForModel: false });
  const read = (args: object, conversationId = "dialog-indigo") => executeReadToolResult(
    { id: "page-indigo", name: "read_tool_result", arguments: JSON.stringify(args) }, store,
    { userQuery: "", conversationId, runId: "run-indigo" },
  );
  return { ref, read };
}
afterEach(async () => { await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("Model access to stored tool results", () => {
  it("reads the requested bounded range and can resolve a current-run call without leaking storage paths", async () => {
    const { ref, read } = await saved("abcdefghij");
    const page = await read({ result_ref: ref.resultRef, offset: 3, length: 4 });
    expect(page).toMatchObject({ tool: "read_tool_result", outcome: "success" });
    expect(JSON.parse(page.output!)).toMatchObject({ content: "defg", offset: 3 });
    const byCall = await read({ tool_call_id: "query-indigo", length: 20 });
    expect(JSON.parse(byCall.output!)).toMatchObject({ content: "abcdefghij" });
    expect(byCall.message).not.toContain("firefly-runs");
  });

  it("round-trips search offsets through a code-point page read", async () => {
    const { ref, read } = await saved("abc🪁def星海ghi");
    const search = await read({ result_ref: ref.resultRef, query: "星海" });
    const matches = JSON.parse(search.output!).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].offset).toEqual(7);
    const page = await read({ result_ref: ref.resultRef, offset: matches[0].offset, length: 2 });
    expect(JSON.parse(page.output!).content).toEqual("星海");
  });

  it("fails closed for foreign conversations and lengths above 8192 while accepting the boundary", async () => {
    const { ref, read } = await saved("Boundary data");
    expect(await read({ result_ref: ref.resultRef }, "foreign-dialog")).toMatchObject({ category: "not_found", outcome: "failure" });
    expect(await read({ result_ref: ref.resultRef, length: 8193 })).toMatchObject({ category: "invalid_arguments", outcome: "failure" });
    expect(await read({ result_ref: ref.resultRef, length: 8192 })).toMatchObject({ outcome: "success" });
  });
});
