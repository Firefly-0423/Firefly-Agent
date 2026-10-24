import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it as portableIt, vi } from "vitest";
import type { ToolDefinition } from "./registry/tool-registry";
// Native caller routing is Windows-only; the direct full-access case below and
// the bridge's explicit non-Windows fallback tests remain portable.
const it = portableIt.runIf(process.platform === "win32");
const { state, registry } = vi.hoisted(() => ({ state: { workspace: "", userData: "", blockPaths: false, failCommit: false, liveLevel: "full", downgradeOnRead: false, alias: "", unsafeCalls: [] as string[], identity: { deviceId: "00000000000000000000000000000007", fileId: "00000000000000000000000000000042" }, bytes: Buffer.from("native original"), commands: [] as Record<string, unknown>[] }, registry: new Map<string, ToolDefinition>() }));
vi.mock("fs", async original => {
  const actual = await original<typeof import("fs")>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ["openSync", "readFileSync", "writeFileSync", "appendFileSync", "statSync", "existsSync", "mkdirSync", "realpathSync", "readdirSync"] as const) {
    wrapped[name] = (...args: unknown[]) => {
      if (state.blockPaths && typeof args[0] === "string" && (args[0] === state.workspace || args[0].startsWith(state.workspace + path.sep))) { state.unsafeCalls.push(name); throw Error("UNSAFE_WORKSPACE_PATH_IO: " + name); }
      if (name === "readFileSync" && state.downgradeOnRead && typeof args[0] === "string" && args[0].startsWith(state.workspace + path.sep)) { state.downgradeOnRead = false; state.liveLevel = "scoped"; }
      if (state.alias && args[0] === state.alias) args[0] = path.join(state.workspace, "file.txt");
      return (actual[name] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped;
});
vi.mock("../../permission/permission", () => ({ getCurrentLevel: () => state.liveLevel }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => state.userData, getPath: () => state.userData } }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: { register: (t: ToolDefinition) => registry.set(t.id, t) } }));
vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "UTC" }));
vi.mock("../vision-captioner", () => ({ captionImage: vi.fn(async () => "native image") }));
vi.mock("../../settings/model-settings", () => ({ loadModelSettings: () => ({}), resolveModelSettingsProfile: () => ({}) }));
vi.mock("../image-router", () => ({ resolveCaptionVisionConfig: () => ({ ok: true, config: {} }) }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn(() => {
  const child = new EventEmitter(); const stdout = new PassThrough(), stderr = new PassThrough();
  const send = (v: unknown) => stdout.write(JSON.stringify(v) + "\n");
  const snap = () => ({ exists: true, kind: "file", size: state.bytes.length, identity: state.identity, canonicalPath: path.join(state.workspace, "file.txt"), bytesHex: state.bytes.toString("hex") });
  const stdin = new Writable({ write(bytes, _encoding, done) {
    const c = JSON.parse(bytes.toString()); state.commands.push(c);
    queueMicrotask(() => {
      if (c.type === "release") { send({ type: "released", version: 1 }); stdout.end(); child.emit("close", 0); }
      else if (c.type === "list") send({ type: "entries", version: 1, entries: [{ name: "native.png", kind: "file", size: 1234, identity: { deviceId: "00000000000000000000000000000007", fileId: "00000000000000000000000000000043" } }] });
      else {
        if (c.type === "commit") {
          state.bytes = c.mode === "append" ? Buffer.concat([state.bytes, Buffer.from(c.bytesHex, "hex")]) : Buffer.from(c.bytesHex, "hex");
          if (state.failCommit) { child.emit("close", 8); return; }
        }
        send({ type: "snapshot", version: 1, snapshot: snap() });
      }
    }); done();
  } });
  Object.assign(child, { stdin, stdout, stderr, kill: () => { queueMicrotask(() => child.emit("close", null)); return true; } });
  queueMicrotask(() => send({ type: "ready", version: 1 })); return child;
}) }));
import "./fs-tools";
import { registerLifeTools } from "./life-tools";
import { captionImage } from "../vision-captioner";
import { getRunReviewTracker, RunReviewTracker } from "../review/run-review-tracker";
import { WriteOwnership } from "../harness/write-ownership";
import type { ToolContext } from "./registry/tool-context";
import { beginWriteBatch } from "./registry/file-write-evidence";
registerLifeTools();
let fixture: string;
beforeEach(() => {
  state.blockPaths = false; state.failCommit = false; state.liveLevel = "full"; state.downgradeOnRead = false; state.alias = ""; state.unsafeCalls = []; state.commands = []; state.bytes = Buffer.from("native original");
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-handle-callers-"));
  state.workspace = path.join(fixture, "workspace"); state.userData = path.join(fixture, "userdata");
  fs.mkdirSync(state.workspace); fs.mkdirSync(state.userData); fs.writeFileSync(path.join(state.workspace, "file.txt"), "disk sentinel");
  const identity = fs.statSync(path.join(state.workspace, "file.txt"), { bigint: true });
  state.identity = { deviceId: identity.dev.toString(16).padStart(32, "0"), fileId: identity.ino.toString(16).padStart(32, "0") };
  state.blockPaths = true;
});
afterEach(() => { state.blockPaths = false; fs.rmSync(fixture, { recursive: true, force: true }); vi.clearAllMocks(); });
const run = (id: string, args: Record<string, unknown>, write = false, runId?: string) => registry.get(id)!.execute(args, { userQuery: "test", resolvedWorkspaceRoot: state.workspace, fileAccessLevel: write ? "scoped" : "project-read-only", ...(runId ? { runId } : {}) });
it("read_file uses native bytes and metadata without workspace stat/read/realpath", async () => {
  const result = JSON.parse(await run("read_file", { path: path.join(state.workspace, "file.txt") }));
  expect(result.content).toContain("native original"); expect(result.content).not.toContain("disk sentinel");
  expect(state.commands[0]).toMatchObject({ type: "read", components: ["file.txt"] });
});
it("list_dir uses native enumeration and child sizes without workspace readdir/stat", async () => {
  const text = await run("list_dir", { path: state.workspace });
  expect(text).toContain("[F] native.png  1.2KB  [图片]"); expect(state.commands[0].type).toBe("list");
});
it("read_image passes only handle bytes to captioning", async () => {
  expect(await run("read_image", { path: path.join(state.workspace, "file.png") })).toBe("native image");
  expect(captionImage).toHaveBeenCalledWith({ base64: Buffer.from("native original").toString("base64"), mime: "image/png" }, "test", {});
});
it.each([false, true])("write_file append=%s derives checks, diff and review from the leased bytes", async append => {
  const file = path.join(state.workspace, "file.txt"); const runId = "handle-write-" + String(append);
  const result = JSON.parse(await run("write_file", { path: file, content: "native updated", append }, true, runId));
  expect(result.success).toBe(true); expect(result.sizeBytes).toBe(append ? 30 : 14);
  expect(state.bytes.toString()).toBe(append ? "native original\nnative updated" : "native updated");
  expect(state.commands.map(c => c.type)).toEqual(["prepare-write", "commit", "release"]);
  const tracker = new RunReviewTracker(state.userData); // Persisted review survives a fresh tracker.
  const review = tracker.finalizeReview(runId, 1, "completed");
  expect(JSON.stringify(review)).toContain("native original"); expect(JSON.stringify(review)).toContain("native updated"); expect(JSON.stringify(review)).not.toContain("disk sentinel");
});
it("str_replace uses one leased preimage and commit, including persisted review", async () => {
  const file = path.join(state.workspace, "file.txt");
  const result = JSON.parse(await run("str_replace", { file_path: file, old_string: "original", new_string: "replaced" }, true, "handle-replace"));
  expect(result.success).toBe(true); expect(state.bytes.toString()).toBe("native replaced");
  const review = getRunReviewTracker(state.userData).finalizeReview("handle-replace", 1, "completed");
  expect(JSON.stringify(review)).toContain("native replaced"); expect(state.commands.filter(c => c.type === "commit")).toHaveLength(1);
});
portableIt("unrestricted full write preserves direct filesystem output and never spawns the helper", async () => {
  state.blockPaths = false; const file = path.join(state.workspace, "file.txt");
  const result = JSON.parse(await registry.get("write_file")!.execute({ path: file, content: "full direct", append: true }, { userQuery: "full", fileAccessLevel: "full" }));
  expect(result.success).toBe(true); expect(fs.readFileSync(file, "utf8")).toBe("disk sentinel\nfull direct"); expect(state.commands).toEqual([]);
});
it("restricted execution ownership and evidence use the native canonical name and observed bytes", async () => {
  const scope = { workspaceId: "w", parentRunId: "parent", groupId: "g", agentId: "a", childRunId: "child", toolCallId: "call" };
  const facts: unknown[] = [];
  const port = { assertPermit: () => scope, terminateChild: () => { throw Error("unexpected conflict"); } };
  const coordinator = { ...port, writeOwnership: new WriteOwnership(port), recordWriteEvidence: (_permit: unknown, fact: unknown) => facts.push(fact) };
  const file = path.join(state.workspace, "file.txt");
  const context: ToolContext = { userQuery: "evidence", fileAccessLevel: "scoped", resolvedWorkspaceRoot: state.workspace,
    execution: { coordinator, scope, permit: {} } as unknown as ToolContext["execution"] };
  const result = JSON.parse(await registry.get("write_file")!.execute({ path: file, content: "native updated" }, context));
  expect(result.success).toBe(true);
  expect(facts.at(-1)).toMatchObject({ state: "applied", canonicalPath: file.toLowerCase(),
    before: { sha256: createHash("sha256").update("native original").digest("hex") },
    after: { sha256: createHash("sha256").update("native updated").digest("hex") } });
});
it("uses the native canonical name for confirmed read ranges even when the input spelling differs", async () => {
  state.bytes = Buffer.from("one\ntwo\nthree");
  const canonical = path.join(state.workspace, "file.txt");
  const text = await registry.get("read_file")!.execute({ path: path.join(state.workspace, "FILE.TXT"), startLine: 2 }, {
    userQuery: "range", fileAccessLevel: "project-read-only", resolvedWorkspaceRoot: state.workspace,
    workReadScopes: [{ name: "file.txt", path: canonical, sha256: createHash("sha256").update(state.bytes).digest("hex"), totalLines: 3, endLine: 1, partialAccepted: true }],
  });
  expect(JSON.parse(text)).toMatchObject({ errorCode: "OUTSIDE_CONFIRMED_RANGE" });
});
it("an overwrite-drop rejection releases the original lease without committing", async () => {
  state.bytes = Buffer.from(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
  await expect(run("write_file", { path: path.join(state.workspace, "file.txt"), content: "too short" }, true)).rejects.toMatchObject({ code: "E_OVERWRITE_DROP_BLOCKED", effectState: "not_applied" });
  expect(state.commands.map(c => c.type)).toEqual(["prepare-write", "release"]);
  expect(state.bytes.toString()).toContain("line 59");
});
it("an uncertain helper commit leaves review unknown without rereading the workspace", async () => {
  const file = path.join(state.workspace, "file.txt"); state.failCommit = true;
  await expect(run("write_file", { path: file, content: "possibly written" }, true, "uncertain-handle"))
    .rejects.toMatchObject({ code: "E_WORKSPACE_UNKNOWN_EFFECTS", effectState: "unknown" });
  const tracker = new RunReviewTracker(state.userData);
  expect(tracker.finalizeReview("uncertain-handle", 1, "failed")).toBeNull();
  expect(state.commands.filter(c => c.type === "commit")).toHaveLength(1);
});
it("fails closed when a read becomes restricted after its initial async policy check", async () => {
  const pending = registry.get("read_file")!.execute({ path: path.join(state.workspace, "file.txt") }, { userQuery: "downgrade", fileAccessLevel: "full", resolvedWorkspaceRoot: state.workspace });
  state.liveLevel = "project-read-only";
  await expect(pending).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", effectState: "not_applied" });
});
it.each(["write_file", "str_replace"])("%s cannot stay on direct fs after an in-flight downgrade to scoped", async id => {
  state.blockPaths = false; state.downgradeOnRead = true; const file = path.join(state.workspace, "file.txt");
  const args = id === "write_file" ? { path: file, content: "updated" } : { file_path: file, old_string: "disk", new_string: "updated" };
  await expect(registry.get(id)!.execute(args, { userQuery: "downgrade", fileAccessLevel: "full", resolvedWorkspaceRoot: state.workspace }))
    .rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", effectState: "not_applied" });
  expect(fs.readFileSync(file, "utf8")).toBe("disk sentinel");
});
it("later unrestricted writes refresh a previously handle-captured review", async () => {
  const file = path.join(state.workspace, "file.txt"); const runId = "mixed-level-review";
  await run("write_file", { path: file, content: "native updated" }, true, runId);
  state.blockPaths = false;
  await registry.get("write_file")!.execute({ path: file, content: "full direct" }, { userQuery: "full", runId, fileAccessLevel: "full", resolvedWorkspaceRoot: state.workspace });
  const review = new RunReviewTracker(state.userData).finalizeReview(runId, 1, "completed");
  expect(JSON.stringify(review)).toContain("full direct"); expect(JSON.stringify(review)).not.toContain("+native updated");
});
it.each(["FILE.TXT", "controlled-short-name"])("a prior unrestricted %s alias is never reopened after a handle write", async aliasKind => {
  state.blockPaths = false;
  const file = path.join(state.workspace, "file.txt");
  const alias = path.join(state.workspace, aliasKind === "FILE.TXT" ? "FILE.TXT" : "LONGFI~1.TXT");
  if (aliasKind !== "FILE.TXT") state.alias = alias;
  const runId = "alias-" + aliasKind, tracker = getRunReviewTracker(state.userData);
  tracker.captureBefore(runId, alias);
  const fullContext: ToolContext = { userQuery: "before", runId, fileAccessLevel: "full" };
  await beginWriteBatch(fullContext, [alias]).run([alias], () => fs.writeFileSync(alias, "pre-native"));
  state.bytes = Buffer.from("pre-native"); state.blockPaths = true; state.unsafeCalls = [];
  await run("write_file", { path: file, content: "native final" }, true, runId);
  const review = new RunReviewTracker(state.userData).finalizeReview(runId, 1, "completed");
  expect(state.unsafeCalls).toEqual([]);
  expect(review?.files).toHaveLength(1);
  expect(JSON.stringify(review)).toContain("disk sentinel"); expect(JSON.stringify(review)).toContain("native final");
});
it.each(["patch", "delete", "rename"])("shared mutation plumbing refreshes a protected review after unrestricted %s", async action => {
  const file = path.join(state.workspace, "file.txt"), moved = path.join(state.workspace, "moved.txt"), runId = "shared-" + action;
  await run("write_file", { path: file, content: "native updated" }, true, runId);
  state.blockPaths = false; fs.writeFileSync(file, "native updated");
  const tracker = getRunReviewTracker(state.userData), paths = action === "rename" ? [file, moved] : [file];
  const context: ToolContext = { userQuery: "later tool", runId, fileAccessLevel: "full" };
  const batch = beginWriteBatch(context, paths); tracker.captureBefore(runId, file);
  batch.runSync(paths, () => {
    if (action === "patch") fs.writeFileSync(file, "patched by another tool");
    if (action === "delete") fs.unlinkSync(file);
    if (action === "rename") { fs.renameSync(file, moved); tracker.recordRename(runId, file, moved); }
  });
  state.blockPaths = true; state.unsafeCalls = [];
  const review = new RunReviewTracker(state.userData).finalizeReview(runId, 1, "completed");
  expect(state.unsafeCalls).toEqual([]);
  expect(review?.files[0].kind).toBe(action === "patch" ? "modified" : action === "delete" ? "deleted" : "renamed");
  if (action === "patch") expect(JSON.stringify(review)).toContain("patched by another tool");
});
