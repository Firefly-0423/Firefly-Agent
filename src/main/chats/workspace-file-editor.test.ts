import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectWorkspaceText, saveWorkspaceText } from "./workspace-file-editor";
import { getWorkspaceExecutionCoordinator } from "../orchestrator/harness/execution-coordinator";

let root: string;
let outside: string;
let binding: { workspaceRoot: string; boundAt: number } | undefined;
let confirm: ReturnType<typeof vi.fn>;
const current = () => true;
const write = (rel: string, value: string | Buffer) => fs.writeFileSync(path.join(root, rel), value);
const read = (rel = "notes.txt") => fs.readFileSync(path.join(root, rel), "utf8");
const payload = (content = "edited") => ({ sessionId: "s", relPath: "notes.txt", content, editVersion: inspectWorkspaceText(root, "notes.txt").editVersion });
const save = (value = payload(), isCurrent = current) => saveWorkspaceText({ getBinding: () => binding, confirm: details => confirm(details), isCurrent }, value);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "firefly-editor-")); outside = fs.mkdtempSync(path.join(tmpdir(), "firefly-editor-out-"));
  binding = { workspaceRoot: root, boundAt: 1 }; confirm = vi.fn(async () => true); write("notes.txt", "original\r\n");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

describe("workspace text save", () => {
  it("saves only after explicit one-time confirmation and updates its version", async () => {
    const request = payload("你好\r\n"); const result = await save(request);
    expect(confirm).toHaveBeenCalledWith({ workspaceRoot: root, relPath: "notes.txt", size: Buffer.byteLength("你好\r\n") });
    expect(result).toMatchObject({ ok: true, content: "你好\r\n", size: 8 });
    if (result.ok) expect(result.editVersion).not.toBe(request.editVersion);
    expect(read()).toBe("你好\r\n"); expect(fs.readdirSync(root)).toEqual(["notes.txt"]);
  });
  it("cancellation preserves the file", async () => { confirm.mockResolvedValue(false); expect(await save()).toEqual({ ok: false, code: "CANCELLED" }); expect(read()).toBe("original\r\n"); });
  it("detects external changes even when size and mtime are restored", async () => {
    const request = payload(); const stat = fs.statSync(path.join(root, "notes.txt")); write("notes.txt", "different\n"); fs.utimesSync(path.join(root, "notes.txt"), stat.atime, stat.mtime);
    expect(await save(request)).toEqual({ ok: false, code: "CONFLICT" }); expect(read()).toBe("different\n"); expect(confirm).not.toHaveBeenCalled();
  });
  it("rejects binding changes during approval", async () => {
    const request = payload(); fs.writeFileSync(path.join(outside, "notes.txt"), "other");
    confirm.mockImplementation(async () => { binding = { workspaceRoot: outside, boundAt: 2 }; return true; });
    expect(await save(request)).toEqual({ ok: false, code: "WORKSPACE_CHANGED" }); expect(read()).toBe("original\r\n"); expect(fs.readFileSync(path.join(outside, "notes.txt"), "utf8")).toBe("other");
  });
  it("rejects stale sender after approval", async () => {
    let active = true; confirm.mockImplementation(async () => { active = false; return true; });
    expect(await save(payload(), () => active)).toEqual({ ok: false, code: "FORBIDDEN" }); expect(read()).toBe("original\r\n");
  });
  it("rejects bad payloads without showing approval", async () => {
    for (const request of [null, {}, { ...payload(), content: 1 }, { ...payload(), editVersion: "fake" }]) expect((await save(request as never)).ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled(); expect(read()).toBe("original\r\n");
  });
  it.each(["../notes.txt", "/notes.txt", "C:/notes.txt", "folder/../notes.txt", "\\\\host\\notes.txt", "notes.txt:stream"])("rejects unsafe relative path %s", async relPath => {
    expect(await save({ ...payload(), relPath })).toEqual({ ok: false, code: "OUT_OF_ROOT" }); expect(confirm).not.toHaveBeenCalled();
  });
  it("rejects symlink or junction parents and hardlinks", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret"); fs.symlinkSync(outside, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir"); fs.linkSync(path.join(outside, "secret.txt"), path.join(root, "hard.txt"));
    for (const relPath of ["alias/secret.txt", "hard.txt"]) expect(await save({ ...payload(), relPath })).toEqual({ ok: false, code: "LINK_READ_ONLY" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
  it("rejects symlink leaves when file symlinks are available", async context => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    try { fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt")); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows file symlink creation requires a privilege unavailable to this test process (EPERM)");
        return;
      }
      throw error;
    }
    expect(await save({ ...payload(), relPath: "link.txt" })).toEqual({ ok: false, code: "LINK_READ_ONLY" });
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });
  it("rejects malformed UTF-8, any binary NUL, oversized text and new files", async () => {
    for (const [name, bytes, code] of [["invalid.txt", Buffer.from([0xc3, 0x28]), "UNSUPPORTED_TEXT"], ["binary.txt", Buffer.from("x\0y"), "UNSUPPORTED_TEXT"], ["large.txt", Buffer.alloc(1024 * 1024 + 1, 65), "TOO_LARGE"]] as const) {
      write(name, bytes); expect(await save({ ...payload(), relPath: name })).toEqual({ ok: false, code });
    }
    expect(await save({ ...payload(), relPath: "new.txt" })).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await save(payload("界".repeat(400000)))).toEqual({ ok: false, code: "TOO_LARGE" });
    expect(await save(payload("x\0y"))).toEqual({ ok: false, code: "UNSUPPORTED_TEXT" }); expect(confirm).not.toHaveBeenCalled();
  });
  it("waits for the existing agent exclusive queue then rechecks the version", async () => {
    const request = payload(); const coordinator = getWorkspaceExecutionCoordinator(root); let release!: () => void;
    const running = coordinator.runLeaf({ workspaceId: coordinator.workspaceId, parentRunId: "agent", groupId: "agent-group", agentId: "agent", childRunId: "child", toolCallId: "tool" }, "exclusive", undefined, async () => { await new Promise<void>(resolve => { release = resolve; }); write("notes.txt", "agent update"); });
    let settled = false; const saving = save(request).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false); expect(read()).toBe("original\r\n");
    release(); await running; expect(await saving).toEqual({ ok: false, code: "CONFLICT" }); expect(read()).toBe("agent update"); await coordinator.closeGroup("agent-group");
  });
  it("cleans up temporary files and preserves original on replacement failure", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture rename failure"); });
    expect(await save()).toEqual({ ok: false, code: "WRITE_FAILED" }); expect(read()).toBe("original\r\n"); expect(fs.readdirSync(root)).toEqual(["notes.txt"]);
  });
  it("preserves file mode and UTF-8 BOM", async () => {
    write("notes.txt", "\ufefforiginal\r\n"); fs.chmodSync(path.join(root, "notes.txt"), 0o640);
    expect((await save(payload("\ufeffnew\r\n"))).ok).toBe(true); expect(read()).toBe("\ufeffnew\r\n");
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, "notes.txt")).mode & 0o777).toBe(0o640);
  });
});

it("times out a queued save and never writes late after the agent releases its permit", async () => {
  vi.useFakeTimers(); const request = payload(); const coordinator = getWorkspaceExecutionCoordinator(root); let release!: () => void;
  const running = coordinator.runLeaf({ workspaceId: coordinator.workspaceId, parentRunId: "timeout-agent", groupId: "timeout-group", agentId: "agent", childRunId: "timeout-child", toolCallId: "tool" }, "exclusive", undefined, async () => { await new Promise<void>(resolve => { release = resolve; }); });
  let result: unknown; const saving = save(request).then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(15000);
  try { expect(result).toEqual({ ok: false, code: "WRITE_BUSY" }); }
  finally { release(); await running; await saving; await coordinator.closeGroup("timeout-group"); }
  expect(read()).toBe("original\r\n"); expect(fs.readdirSync(root)).toEqual(["notes.txt"]);
});
