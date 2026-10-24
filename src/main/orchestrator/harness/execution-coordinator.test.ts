import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceExecutionCoordinator, type ExecutionScope, type LeafPermit } from "./execution-coordinator";

const roots: string[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-coordinator-")); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { force: true, recursive: true }); });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function scope(workspaceId: string, toolCallId: string, extra: Partial<ExecutionScope> = {}): ExecutionScope {
  return { workspaceId, parentRunId: "parent", groupId: "group", agentId: "role", childRunId: "child", toolCallId, ...extra };
}

describe("workspace leaf execution coordinator (synthetic)", () => {
  it("shared_read_overlap_writer_fairness", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const reads = deferred();
    const writer = deferred();
    const entered: string[] = [];
    let activeReads = 0;
    let activeWrites = 0;
    const first = coordinator.runLeaf(scope(coordinator.workspaceId, "read-a"), "shared", undefined, async () => {
      entered.push("read-a"); activeReads++; expect(activeWrites).toBe(0);
      await reads.promise; activeReads--;
    });
    const second = coordinator.runLeaf(scope(coordinator.workspaceId, "read-b"), "shared", undefined, async () => {
      entered.push("read-b"); activeReads++; expect(activeWrites).toBe(0);
      await reads.promise; activeReads--;
    });
    const exclusive = coordinator.runLeaf(scope(coordinator.workspaceId, "write"), "exclusive", undefined, async () => {
      entered.push("write"); activeWrites++;
      expect(activeReads).toBe(0); expect(activeWrites).toBe(1);
      await writer.promise; activeWrites--;
    });
    const late = coordinator.runLeaf(scope(coordinator.workspaceId, "read-late"), "shared", undefined, async () => {
      entered.push("read-late"); expect(activeWrites).toBe(0);
    });
    for (const operation of [first, second, exclusive, late]) void operation.catch(() => undefined);
    await flush();
    expect(entered).toEqual(["read-a", "read-b"]);
    expect(activeReads).toBe(2);
    reads.resolve(); await Promise.all([first, second]); await flush();
    expect(entered).toEqual(["read-a", "read-b", "write"]);
    writer.resolve(); await Promise.all([exclusive, late]);
    expect(entered).toEqual(["read-a", "read-b", "write", "read-late"]);
    await coordinator.closeGroup("group");
  });

  it("same_workspace_top_level_runs_share_coordinator", async () => {
    const workspace = root();
    const aliasParent = root();
    const alias = path.join(aliasParent, "alias");
    fs.symlinkSync(workspace, alias, "junction");
    const coordinator = getWorkspaceExecutionCoordinator(workspace);
    const other = getWorkspaceExecutionCoordinator(path.join(alias, "."));
    expect(other).toBe(coordinator);
    const blocked = deferred();
    let readStarted = false;
    const shell = coordinator.runLeaf(scope(coordinator.workspaceId, "shell"), "exclusive", undefined, async () => blocked.promise);
    const read = other.runLeaf(scope(other.workspaceId, "read", { parentRunId: "other-parent", groupId: "other-group" }), "shared", undefined, async () => { readStarted = true; });
    await flush(); expect(readStarted).toBe(false);
    blocked.resolve(); await Promise.all([shell, read]);
    expect(readStarted).toBe(true);
    await Promise.all([coordinator.closeGroup("group"), coordinator.closeGroup("other-group")]);
    expect(getWorkspaceExecutionCoordinator(alias)).toBe(coordinator);
  });

  it("aborted_waiter_does_not_release_running_operation", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const operation = deferred();
    const runningAbort = new AbortController();
    const queuedAbort = new AbortController();
    let queuedCalls = 0;
    let nextCalls = 0;
    const running = coordinator.runLeaf(scope(coordinator.workspaceId, "running"), "exclusive", runningAbort.signal, async () => operation.promise);
    const queued = coordinator.runLeaf(scope(coordinator.workspaceId, "queued"), "exclusive", queuedAbort.signal, async () => { queuedCalls++; });
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    queuedAbort.abort(); runningAbort.abort(); await rejected;
    const next = coordinator.runLeaf(scope(coordinator.workspaceId, "next"), "shared", undefined, async () => { nextCalls++; });
    let drained = false;
    const settlement = coordinator.whenChildSettled("child").then(() => { drained = true; });
    await flush();
    expect(queuedCalls).toBe(0); expect(nextCalls).toBe(0); expect(drained).toBe(false);
    operation.resolve(); await Promise.all([running, next, settlement]);
    expect(nextCalls).toBe(1); expect(drained).toBe(true);
    await coordinator.closeGroup("group");
  });

  it("releases_rejected_actual_operations_without_an_unhandled_rejection", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const operation = deferred();
    const first = coordinator.runLeaf(scope(coordinator.workspaceId, "failure"), "exclusive", undefined, async () => operation.promise);
    const failure = expect(first).rejects.toThrow("synthetic failure");
    let readStarted = false;
    const read = coordinator.runLeaf(scope(coordinator.workspaceId, "read"), "shared", undefined, async () => { readStarted = true; });
    await flush(); expect(readStarted).toBe(false);
    operation.reject(new Error("synthetic failure"));
    await Promise.all([failure, read, coordinator.whenSettled("group")]);
    expect(readStarted).toBe(true);
    await coordinator.closeGroup("group");
  });

  it("retains_detached_actual_completion_after_the_immediate_response", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const actualCompletion = deferred();
    const response = await coordinator.runLeaf(scope(coordinator.workspaceId, "job"), "exclusive", undefined, async permit => {
      coordinator.retainUntil(permit, actualCompletion.promise);
      return "job-created";
    });
    expect(response).toBe("job-created");
    let readStarted = false;
    let childDrained = false;
    const drain = coordinator.whenChildSettled("child").then(() => { childDrained = true; });
    const read = coordinator.runLeaf(scope(coordinator.workspaceId, "read", { childRunId: "reader" }), "shared", undefined, async () => { readStarted = true; });
    await flush(); expect(readStarted).toBe(false); expect(childDrained).toBe(false);
    actualCompletion.reject(new Error("synthetic process close failure"));
    await Promise.all([read, drain]);
    expect(readStarted).toBe(true); expect(childDrained).toBe(true);
    await coordinator.closeGroup("group");
  });

  it("close_stops_new_and_queued_group_work_and_drains_actual_operations", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const completion = deferred();
    const started = coordinator.runLeaf(scope(coordinator.workspaceId, "started"), "exclusive", undefined, async () => completion.promise);
    let queuedCalls = 0;
    const queued = coordinator.runLeaf(scope(coordinator.workspaceId, "queued"), "exclusive", undefined, async () => { queuedCalls++; });
    const queuedFailure = expect(queued).rejects.toMatchObject({ code: "AGENT_EXECUTION_GROUP_CLOSED", effectState: "not_applied" });
    let closed = false;
    const closing = coordinator.closeGroup("group").then(() => { closed = true; });
    await queuedFailure;
    await expect(coordinator.runLeaf(scope(coordinator.workspaceId, "new"), "shared", undefined, async () => undefined)).rejects.toMatchObject({ code: "AGENT_EXECUTION_GROUP_CLOSED" });
    await flush(); expect(closed).toBe(false); expect(queuedCalls).toBe(0);
    completion.resolve(); await Promise.all([started, closing]);
    expect(closed).toBe(true);
  });

  it("records_immediate_defensive_write_snapshots_and_rejects_identity_spoofing", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const target = path.join(coordinator.workspaceId, "file.txt");
    const snapshots: unknown[] = [];
    const unsubscribe = coordinator.onChildWrites("child", writes => snapshots.push(writes));
    const evidence = {
      path: target, canonicalPath: target, agentId: "role", childRunId: "child", toolCallId: "write",
      state: "not_applied" as const, before: { version: "absent", secret: "discard" }, eventIds: ["tool-start"], secret: "discard",
    };
    await coordinator.runLeaf(scope(coordinator.workspaceId, "write"), "exclusive", undefined, async permit => {
      coordinator.recordWriteEvidence(permit, evidence);
      expect(snapshots).toHaveLength(1);
      expect(coordinator.getChildWrites("child")[0]).not.toHaveProperty("secret");
      expect(coordinator.getChildWrites("child")[0].before).not.toHaveProperty("secret");
      evidence.eventIds.push("caller-mutation");
      expect(coordinator.getChildWrites("child")[0].eventIds).toEqual(["tool-start"]);
      expect(() => coordinator.recordWriteEvidence(permit, { ...evidence, childRunId: "spoofed" })).toThrow("does not belong");
      const invalid = { ...evidence, state: "pretend_applied" as never };
      expect(() => coordinator.recordWriteEvidence(permit, invalid)).toThrow("Invalid write evidence");
      coordinator.recordWriteEvidence(permit, { ...evidence, state: "applied", after: { version: "observed-version" }, eventIds: ["tool-start", "tool-end"] });
      const received = coordinator.getWriteEvidence({ groupId: "group", toolCallId: "write" });
      received[0].eventIds.push("reader-mutation");
      expect(coordinator.getChildWrites("child")[0].eventIds).toEqual(["tool-start", "tool-end"]);
      expect(coordinator.getWriteEvidence({ childRunId: "unrelated" })).toEqual([]);
    });
    unsubscribe();
    await coordinator.closeGroup("group");
    expect(coordinator.getChildWrites("child")[0].state).toBe("applied");
  });

  it("keeps_distinct_actual_paths_for_one_canonical_target_and_updates_same_path_in_place", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const directory = path.join(coordinator.workspaceId, "real");
    const aliasDirectory = path.join(coordinator.workspaceId, "alias");
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, aliasDirectory, "junction");
    const target = path.join(directory, "real.txt");
    const alias = path.join(aliasDirectory, "real.txt");
    fs.writeFileSync(target, "original");
    expect(fs.realpathSync.native(alias)).toBe(fs.realpathSync.native(target));
    const originalHash = "0".repeat(64);
    const updatedHash = "1".repeat(64);
    await coordinator.runLeaf(scope(coordinator.workspaceId, "patch"), "exclusive", undefined, async permit => {
      const identity = { canonicalPath: target, agentId: "role", childRunId: "child", toolCallId: "patch" };
      coordinator.recordWriteEvidence(permit, { ...identity, path: alias, state: "not_applied", before: { sha256: originalHash, version: "present" }, eventIds: ["alias-start"] });
      coordinator.recordWriteEvidence(permit, { ...identity, path: target, state: "applied", before: { sha256: originalHash, version: "present" }, after: { sha256: updatedHash, version: "present" }, eventIds: ["target-start", "target-end"] });
      expect(coordinator.getWriteEvidence({ groupId: "group", toolCallId: "patch" })).toHaveLength(2);
      coordinator.recordWriteEvidence(permit, { ...identity, path: alias, state: "applied", before: { sha256: originalHash, version: "present" }, after: { version: "absent" }, eventIds: ["alias-start", "alias-end"] });
      const writes = coordinator.getChildWrites("child");
      expect(writes).toHaveLength(2);
      expect(writes.find(write => write.path === alias)).toMatchObject({ canonicalPath: target, state: "applied", after: { version: "absent" }, eventIds: ["alias-start", "alias-end"] });
      expect(writes.find(write => write.path === target)).toMatchObject({ canonicalPath: target, state: "applied", after: { sha256: updatedHash, version: "present" }, eventIds: ["target-start", "target-end"] });
    });
    await coordinator.closeGroup("group");
  });

  it("completed_callback_cannot_attach_a_new_lifetime_to_a_retained_permit", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const actual = deferred();
    let retained!: LeafPermit;
    await coordinator.runLeaf(scope(coordinator.workspaceId, "job"), "exclusive", undefined, async permit => {
      retained = permit; coordinator.retainUntil(permit, actual.promise);
    });
    expect(() => coordinator.retainUntil(retained, Promise.resolve())).toThrow("no longer accepts");
    actual.resolve(); await coordinator.closeGroup("group");
  });

  it("rejects_workspace_mismatch_and_forged_or_expired_permits", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    await expect(coordinator.runLeaf(scope("other-workspace", "wrong"), "exclusive", undefined, async () => undefined)).rejects.toMatchObject({ code: "AGENT_EXECUTION_SCOPE_INVALID" });
    expect(() => coordinator.assertPermit({} as LeafPermit, "exclusive")).toThrow("permit");
    let retained!: LeafPermit;
    await coordinator.runLeaf(scope(coordinator.workspaceId, "real"), "exclusive", undefined, async permit => {
      retained = permit;
      expect(coordinator.assertPermit(permit, "exclusive").toolCallId).toBe("real");
    });
    expect(() => coordinator.assertPermit(retained)).toThrow("permit");
    await coordinator.closeGroup("group");
  });
});
