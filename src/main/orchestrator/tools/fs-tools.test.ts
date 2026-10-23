import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";

const fixture = vi.hoisted(() => ({ root: "", tools: new Map<string, ToolDefinition>(), fail: "" }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: {
  register: (value: ToolDefinition) => fixture.tools.set(value.id, value),
  getById: (id: string) => fixture.tools.get(id), getEnabledTools: () => [...fixture.tools.values()],
} }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("../vision-captioner", () => ({ captionImage: vi.fn() }));
vi.mock("fs", async original => {
  const actual = await original<typeof import("fs")>();
  const intercept = (method: "mkdirSync" | "writeFileSync" | "statSync") => (...args: unknown[]) => {
    if (fixture.fail === method) { fixture.fail = ""; throw new Error("Injected " + method + " failure"); }
    return (actual[method] as (...values: unknown[]) => unknown)(...args);
  };
  return { ...actual, mkdirSync: intercept("mkdirSync"), writeFileSync: intercept("writeFileSync"), statSync: intercept("statSync") };
});
import "./fs-tools";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";
import { beginWriteBatch } from "./registry/file-write-evidence";
import { inspectWorkReadFile } from "../../chats/work-read-scope";

const tool = (id: string) => fixture.tools.get(id)!;
const read = async (path: string, args = {}, context?: ToolContext) => JSON.parse(await tool("read_file").execute({ path, ...args }, context));
const write = async (path: string, content: string, args = {}, context?: ToolContext) => JSON.parse(await tool("write_file").execute({ path, content, ...args }, context));
const prepare = (text: string, name = "observations.txt") => { const file = join(fixture.root, name); fs.writeFileSync(file, text); return file; };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const records = (count: number) => Array.from({ length: count }, (_, n) => "record-" + (n + 73)).join("\n");
const baselines = (run: string) => {
  const before = join(fixture.root, "firefly-runs/reviews", run, "before");
  return fs.existsSync(before) ? fs.readdirSync(before).map(name => join(before, name)) : [];
};
beforeEach(() => { fixture.root = fs.mkdtempSync(join(tmpdir(), "filesystem-contract-73-")); });
afterEach(() => {
  fixture.fail = "";
  const target = resolve(fixture.root);
  if (target.startsWith(resolve(tmpdir()) + sep)) fs.rmSync(target, { recursive: true, force: true });
});

describe("observable filesystem read contracts", () => {
  it("advertises concurrent text and directory reads but does not classify vision reads as safe", () => {
    expect(tool("read_file").isConcurrencySafe?.({ path: "E:\\workspace\\observations.txt" })).toBe(true);
    expect(tool("list_dir").isConcurrencySafe?.({ path: "E:\\workspace" })).toBe(true);
    expect(tool("read_image").isConcurrencySafe).toBeUndefined();
  });
  it("returns the complete numbered content, pagination facts and actual byte identity", async () => {
    const text = "north\neast\ncentre\nwest\nsouth";
    const path = prepare(text);
    expect(await read(path)).toEqual({
      path, canonicalPath: fs.realpathSync(path), startLine: 1, endLine: 5, totalLines: 5, sha256: hash(text),
      content: "    1 | north\n    2 | east\n    3 | centre\n    4 | west\n    5 | south", truncated: false,
    });
  });
  it("honors both the starting line and the requested page length", async () => {
    const path = prepare("north\neast\ncentre\nwest\nsouth");
    const tail = await read(path, { startLine: 3 });
    expect(tail).toMatchObject({ startLine: 3, endLine: 5 });
    expect(tail.content).toContain("centre");
    expect(tail.content).not.toContain("    1 | north");
    expect(await read(path, { startLine: 2, maxLines: 2 })).toMatchObject({ startLine: 2, endLine: 3, totalLines: 5 });
  });
  it("counts an empty file as one line and recognizes CRLF boundaries", async () => {
    expect(await read(prepare("", "empty.txt"))).toMatchObject({ totalLines: 1, startLine: 1 });
    expect((await read(prepare("north\r\ncentre\r\nsouth", "crlf.txt"))).totalLines).toBe(3);
  });
  it("diagnoses missing files, relative paths and directories", async () => {
    expect((await read(join(fixture.root, "absent.txt"))).error).toContain("文件不存在");
    expect((await read("unbound/observations.txt")).error).toContain("绝对路径");
    expect((await read(fixture.root)).error).toContain("不是文件");
  });
  it("enforces the user-confirmed content version and line range", async () => {
    const path = prepare("north\ncentre\nsouth\nlast");
    const confirmed = { ...inspectWorkReadFile(path), endLine: 2, partialAccepted: true };
    const context = { userQuery: "Read approved lines", workReadScopes: [confirmed] };
    const limited = await read(path, { maxLines: 500 }, context);
    expect(limited).toMatchObject({ startLine: 1, endLine: 2, scopeLimited: true });
    expect(limited.content).not.toContain("south");
    expect(await read(path, { startLine: 3 }, context)).toMatchObject({ success: false, errorCode: "OUTSIDE_CONFIRMED_RANGE" });
    fs.writeFileSync(path, "updated\ncentre\nsouth\nlast");
    expect(await read(path, {}, context)).toMatchObject({ success: false, errorCode: "FILE_CHANGED" });
  });
});

describe("filesystem writes and append behavior", () => {
  it("resolves a plain relative filename against the desktop fallback", async () => {
    const target = join(fixture.root, "journal.md");
    expect(await write("journal.md", "# Observations")).toMatchObject({ success: true, path: target });
    expect(fs.readFileSync(target, "utf8")).toBe("# Observations");
  });
  it("creates missing parent directories for relative filenames", async () => {
    expect((await write("notes/journal.md", "Night observation")).success).toBe(true);
    expect(fs.existsSync(join(fixture.root, "notes/journal.md"))).toBe(true);
  });
  it("prefers the trusted workspace root for relative output", async () => {
    const root = join(fixture.root, "bound-project");
    fs.mkdirSync(root);
    expect(await write("notes/journal.txt", "Night observation", {}, { userQuery: "", resolvedWorkspaceRoot: root }))
      .toMatchObject({ success: true, path: join(root, "notes/journal.txt") });
  });
  it("rejects traversal with typed failure metadata and no escaped file", async () => {
    await expect(tool("write_file").execute({ path: "../outside-contract-73.txt", content: "Must not escape" })).rejects.toMatchObject({
      name: "ToolExecutionError", code: "E_PATH_NOT_ABSOLUTE", category: "invalid_arguments", effectState: "not_applied",
    });
    expect(fs.existsSync(join(dirname(fixture.root), "outside-contract-73.txt"))).toBe(false);
  });
  it("allows zero-byte output with stat-backed size and exact diff evidence", async () => {
    const path = join(fixture.root, "new/empty.txt");
    expect(await write(path, "")).toEqual({
      success: true, tool: "write_file", path, append: false, exists: true, sizeBytes: 0, writtenBytes: 0,
      changes: [{ file: path, kind: "added", insertions: 0, deletions: 0, diff: [] }],
    });
    expect(fs.existsSync(path)).toBe(true);
  });
  it.each([
    ["mkdirSync", { code: "E_CREATE_PARENT_FAILED", category: "permission_denied" }],
    ["writeFileSync", { code: "E_WRITE_FILE_FAILED", effectState: "unknown" }],
    ["statSync", { code: "E_WRITE_EVIDENCE_FAILED", effectState: "unknown" }],
  ] as const)("propagates typed %s failure facts", async (method, expected) => {
    fixture.fail = method;
    await expect(tool("write_file").execute({ path: join(fixture.root, "new/record.txt"), content: "Observation" })).rejects.toMatchObject(expected);
  });
  it("blocks a severe whole-file shrink before touching the original bytes", async () => {
    const original = records(100);
    const path = prepare(original);
    await expect(tool("write_file").execute({ path, content: "truncated record" })).rejects.toMatchObject({
      code: "E_OVERWRITE_DROP_BLOCKED", category: "runtime_safety", retryable: false, effectState: "not_applied",
    });
    expect(fs.readFileSync(path, "utf8")).toBe(original);
  });
  it("allows substantial compression of a small file", async () => {
    const path = prepare(records(10));
    expect((await write(path, "north\nsouth")).success).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe("north\nsouth");
  });
  it("reports every removed row before the added rows when overwriting", async () => {
    const path = prepare("earlier north\nearlier south");
    const result = await write(path, "later north\nlater centre\nlater south");
    expect(result.changes[0]).toEqual({ file: path, kind: "modified", insertions: 3, deletions: 2, diff: [
      { type: "remove", text: "earlier north" }, { type: "remove", text: "earlier south" },
      { type: "add", text: "later north" }, { type: "add", text: "later centre" }, { type: "add", text: "later south" },
    ] });
  });
  it("appends to a large file without shrink rejection and supplies a missing newline", async () => {
    const original = records(60);
    const path = prepare(original);
    expect((await write(path, "final observation", { append: true })).success).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe(original + "\nfinal observation");
  });
  it("does not duplicate an existing terminal newline", async () => {
    const path = prepare("first observation\n");
    await write(path, "second observation", { append: true });
    expect(fs.readFileSync(path, "utf8")).toBe("first observation\nsecond observation");
  });
  it("creates an added file when appending to an absent target", async () => {
    const path = join(fixture.root, "append-new.txt");
    const result = await write(path, "first observation", { append: true });
    expect(result.success).toBe(true);
    expect(result.changes[0].kind).toBe("added");
    expect(fs.readFileSync(path, "utf8")).toBe("first observation");
  });
});

describe("write-ahead review snapshots", () => {
  it("captures original text before an overwrite", async () => {
    const path = prepare("earlier observation\nsecond observation\n");
    expect((await write(path, "revised observation", {}, { userQuery: "", runId: "text-review-73" })).success).toBe(true);
    const files = baselines("text-review-73");
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(files[0], "utf8")).toBe("earlier observation\nsecond observation\n");
  });
  it("captures absence once per run even when the file is later rewritten", async () => {
    const path = join(fixture.root, "new-review.md");
    const context = { userQuery: "", runId: "absent-review-73" };
    await write(path, "first observation", {}, context);
    expect(baselines(context.runId)).toHaveLength(1);
    expect(baselines(context.runId)[0]).toMatch(/\.absent$/);
    await write(path, "second observation", {}, context);
    expect(baselines(context.runId)).toHaveLength(1);
  });
  it("creates no review directory without a run id", async () => {
    await write(join(fixture.root, "no-review.md"), "untracked observation");
    expect(fs.existsSync(join(fixture.root, "firefly-runs"))).toBe(false);
  });
});

describe("coordinated reads and trusted versions", () => {
  function identity(coordinator: ReturnType<typeof getWorkspaceExecutionCoordinator>, agentId: string) {
    return { workspaceId: coordinator.workspaceId, parentRunId: "parent-73", groupId: "fs-group-73", agentId, childRunId: "child-" + agentId, toolCallId: "call-" + agentId };
  }
  it("queues a reader until the writer settles and hashes the final bytes", async () => {
    const path = prepare("earlier bytes");
    const old = await read(path);
    const coordinator = getWorkspaceExecutionCoordinator(fixture.root);
    let release!: () => void;
    let notify!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { notify = resolve; });
    const owner = identity(coordinator, "writer-73");
    const writer = coordinator.runLeaf(owner, "exclusive", undefined, async permit => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: owner, permit } }, [path]);
      await batch.run([path], async () => {
        fs.writeFileSync(path, "intermediate bytes");
        notify();
        await gate;
        fs.writeFileSync(path, "final bytes");
      });
    });
    await began;
    let entered = false;
    const reader = coordinator.runLeaf(identity(coordinator, "reader-91"), "shared", undefined, async () => { entered = true; return read(path); });
    await Promise.resolve();
    expect(entered).toBe(false);
    release();
    await writer;
    const current = await reader;
    expect(current.sha256).toBe(hash("final bytes"));
    expect(old.sha256).toBe(hash("earlier bytes"));
    expect(current.canonicalPath).toBe(fs.realpathSync(path));
    await coordinator.closeGroup(owner.groupId);
  });
  it("records no invalid write claim and permits another agent to write", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(fixture.root);
    const invalid = identity(coordinator, "invalid-73");
    await coordinator.runLeaf(invalid, "exclusive", undefined, async permit => {
      await expect(tool("write_file").execute({ path: "../outside.txt", content: "invalid" },
        { userQuery: "", resolvedWorkspaceRoot: fixture.root, execution: { coordinator, scope: invalid, permit } })).rejects.toMatchObject({ code: "E_PATH_NOT_ABSOLUTE" });
    });
    expect(coordinator.getWriteEvidence({ childRunId: invalid.childRunId })).toEqual([]);
    const valid = identity(coordinator, "valid-91");
    await coordinator.runLeaf(valid, "exclusive", undefined, async permit => {
      await write("accepted.txt", "actual bytes", {}, { userQuery: "", resolvedWorkspaceRoot: fixture.root, execution: { coordinator, scope: valid, permit } });
    });
    expect(coordinator.getWriteEvidence({ childRunId: valid.childRunId })[0]).toMatchObject({ state: "applied", after: { sha256: hash("actual bytes") } });
    await coordinator.closeGroup(valid.groupId);
  });
});
