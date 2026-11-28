import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceExecutionCoordinator, type ExecutionScope, type LeafPermit } from "./execution-coordinator";
import { canonicalWriteIdentity } from "./write-ownership";

const roots: string[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-ownership-")); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
function scope(workspaceId: string, toolCallId: string, extra: Partial<ExecutionScope> = {}): ExecutionScope {
  return { workspaceId, parentRunId: "parent", groupId: "group", agentId: "role-a", childRunId: "child-a", toolCallId, ...extra };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

describe("canonical path write ownership (synthetic)", () => {
  it("aliases_share_owner", async () => {
    const workspace = root();
    const target = path.join(workspace, "file.txt");
    fs.writeFileSync(target, "original");
    const alias = path.join(root(), "alias");
    fs.symlinkSync(workspace, alias, "junction");
    const coordinator = getWorkspaceExecutionCoordinator(workspace);
    const relative = path.relative(process.cwd(), target);
    expect(canonicalWriteIdentity(relative)).toBe(canonicalWriteIdentity(target));
    expect(canonicalWriteIdentity(path.join(alias, "file.txt"))).toBe(canonicalWriteIdentity(target));
    await coordinator.runLeaf(scope(coordinator.workspaceId, "claim-a"), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [target, relative]);
    });
    await expect(coordinator.runLeaf(scope(coordinator.workspaceId, "claim-b", { agentId: "role-b", childRunId: "child-b" }), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [path.join(alias, "file.txt")]);
    })).rejects.toMatchObject({ code: "AGENT_WRITE_CONFLICT", category: "fatal", retryable: false, effectState: "not_applied" });
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    await coordinator.closeGroup("group");
  });

  it("missing_leaf_and_symlink_retarget_revalidate", async () => {
    const workspace = root();
    const first = path.join(workspace, "first");
    const second = path.join(workspace, "second");
    fs.mkdirSync(first); fs.mkdirSync(second);
    const alias = path.join(workspace, "alias");
    fs.symlinkSync(first, alias, "junction");
    const missingAlias = path.join(alias, "missing", "file.txt");
    expect(canonicalWriteIdentity(missingAlias)).toBe(canonicalWriteIdentity(path.join(first, "missing", "file.txt")));
    const coordinator = getWorkspaceExecutionCoordinator(workspace);
    const blocker = deferred();
    const firstOperation = coordinator.runLeaf(scope(coordinator.workspaceId, "block"), "exclusive", undefined, async () => blocker.promise);
    let claimedIdentity: string | undefined;
    const queued = coordinator.runLeaf(scope(coordinator.workspaceId, "queued"), "exclusive", undefined, async permit => {
      claimedIdentity = canonicalWriteIdentity(missingAlias);
      coordinator.writeOwnership.claim(permit, [missingAlias]);
    });
    fs.unlinkSync(alias); fs.symlinkSync(second, alias, "junction");
    blocker.resolve(); await Promise.all([firstOperation, queued]);
    expect(claimedIdentity).toBe(canonicalWriteIdentity(path.join(second, "missing", "file.txt")));
    await coordinator.runLeaf(scope(coordinator.workspaceId, "original-other", { agentId: "role-b", childRunId: "child-b" }), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [path.join(first, "missing", "file.txt")]);
    });
    expect(fs.readdirSync(first)).toEqual([]); expect(fs.readdirSync(second)).toEqual([]);
    await coordinator.closeGroup("group");
  });

  it("claim_all_patch_sources_and_destinations_or_none", async () => {
    const workspace = root();
    const owned = path.join(workspace, "owned.txt");
    const source = path.join(workspace, "source.txt");
    const destination = path.join(workspace, "destination.txt");
    const coordinator = getWorkspaceExecutionCoordinator(workspace);
    await coordinator.runLeaf(scope(coordinator.workspaceId, "first"), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [owned]);
      coordinator.writeOwnership.claim(permit, [owned]);
    });
    await expect(coordinator.runLeaf(scope(coordinator.workspaceId, "conflict", { agentId: "role-b", childRunId: "child-b" }), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [source, destination, owned]);
    })).rejects.toMatchObject({ code: "AGENT_WRITE_CONFLICT" });
    await coordinator.runLeaf(scope(coordinator.workspaceId, "third", { agentId: "role-c", childRunId: "child-c" }), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [source, destination]);
    });
    expect(fs.readdirSync(workspace)).toEqual([]);
    await coordinator.closeGroup("group");
  });

  it("denied_dryrun_invalid_and_queued_cancel_claim_nothing", async () => {
    const workspace = root();
    const target = path.join(workspace, "never-created.txt");
    const coordinator = getWorkspaceExecutionCoordinator(workspace);
    // Denial, preview and invalid arguments never invoke the approved leaf body.
    expect(() => coordinator.writeOwnership.claim({} as LeafPermit, [target])).toThrow("permit");
    await coordinator.runLeaf(scope(coordinator.workspaceId, "read"), "shared", undefined, async permit => {
      expect(() => coordinator.writeOwnership.claim(permit, [target])).toThrow("exclusive");
    });
    const blocker = deferred();
    const first = coordinator.runLeaf(scope(coordinator.workspaceId, "hold"), "exclusive", undefined, async () => blocker.promise);
    const abort = new AbortController();
    let invocations = 0;
    const queued = coordinator.runLeaf(scope(coordinator.workspaceId, "cancelled"), "exclusive", abort.signal, async permit => {
      invocations++; coordinator.writeOwnership.claim(permit, [target]); fs.writeFileSync(target, "bad");
    });
    const cancelled = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); await cancelled;
    blocker.resolve(); await first;
    await coordinator.runLeaf(scope(coordinator.workspaceId, "different-role", { agentId: "role-b", childRunId: "child-b" }), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [target]);
    });
    expect(invocations).toBe(0); expect(fs.readdirSync(workspace)).toEqual([]);
    await coordinator.closeGroup("group");
  });

  it("conflict_cannot_fallback_to_shell", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const target = path.join(coordinator.workspaceId, "file.txt");
    await coordinator.runLeaf(scope(coordinator.workspaceId, "a"), "exclusive", undefined, async permit => coordinator.writeOwnership.claim(permit, [target]));
    let notified = 0;
    const unsubscribe = coordinator.onChildTerminated("child-b", error => { expect(error.code).toBe("AGENT_WRITE_CONFLICT"); notified++; });
    const b = { agentId: "role-b", childRunId: "child-b" };
    await expect(coordinator.runLeaf(scope(coordinator.workspaceId, "b", b), "exclusive", undefined, async permit => coordinator.writeOwnership.claim(permit, [target]))).rejects.toMatchObject({ code: "AGENT_WRITE_CONFLICT" });
    let shellCalls = 0;
    await expect(coordinator.runLeaf(scope(coordinator.workspaceId, "shell", b), "exclusive", undefined, async () => { shellCalls++; })).rejects.toMatchObject({ code: "AGENT_WRITE_CONFLICT" });
    expect(coordinator.getChildFailure("child-b")?.code).toBe("AGENT_WRITE_CONFLICT");
    expect(shellCalls).toBe(0); expect(notified).toBe(1);
    // Unrelated sibling work still succeeds.
    await coordinator.runLeaf(scope(coordinator.workspaceId, "sibling", { agentId: "role-c", childRunId: "child-c" }), "shared", undefined, async () => undefined);
    unsubscribe(); await coordinator.closeGroup("group");
  });

  it("new_sequential_group_can_reclaim_after_settlement", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root());
    const target = path.join(coordinator.workspaceId, "file.txt");
    const completion = deferred();
    await coordinator.runLeaf(scope(coordinator.workspaceId, "a"), "exclusive", undefined, async permit => {
      coordinator.writeOwnership.claim(permit, [target]);
      coordinator.retainUntil(permit, completion.promise);
    });
    let closed = false;
    const closing = coordinator.closeGroup("group").then(() => { closed = true; });
    let entered = false;
    const next = coordinator.runLeaf(scope(coordinator.workspaceId, "next", { groupId: "next-group", agentId: "role-b", childRunId: "child-b" }), "exclusive", undefined, async permit => {
      entered = true; coordinator.writeOwnership.claim(permit, [target]);
    });
    await flush(); expect(entered).toBe(false); expect(closed).toBe(false);
    completion.resolve(); await Promise.all([closing, next]);
    expect(entered).toBe(true); expect(closed).toBe(true);
    await coordinator.closeGroup("next-group");
  });

  it("canonical_identity_is_not_a_path_authorization_or_a_writer", () => {
    const outside = root();
    const expected = path.join(fs.realpathSync.native(outside), "missing.txt");
    expect(canonicalWriteIdentity(path.join(outside, "missing.txt"))).toBe(process.platform === "win32" ? expected.toLowerCase() : expected);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.runIf(process.platform === "win32")("Windows_case_aliases_share_owner", () => {
    const workspace = root();
    expect(canonicalWriteIdentity(workspace.toUpperCase())).toBe(canonicalWriteIdentity(workspace));
  });

  it.runIf(process.platform === "win32")("Windows_real_8_3_aliases_share_owner", ({ skip }) => {
    const workspace = root();
    if (!process.env.ComSpec) throw new Error("ComSpec is required for the Windows short-path fixture");
    const raw = execFileSync(process.env.ComSpec, ["/d", "/s", "/c", 'for %I in ("%FIREFLY_OWNERSHIP_ROOT%") do @echo %~fsI'], { env: { ...process.env, FIREFLY_OWNERSHIP_ROOT: workspace }, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 }).trim();
    if (!/~\d+(?:\\|$)/.test(raw)) { skip("The isolated test directory has no real Windows 8.3 short path"); return; }
    expect(canonicalWriteIdentity(raw)).toBe(canonicalWriteIdentity(workspace));
  });
});
