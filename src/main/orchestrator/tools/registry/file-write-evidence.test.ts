import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { getWorkspaceExecutionCoordinator } from "../../harness/execution-coordinator";
import { beginWriteBatch } from "./file-write-evidence";
import type { ToolContext } from "./tool-context";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "write-evidence-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function scope(agentId: string, toolCallId: string) {
  return { workspaceId: getWorkspaceExecutionCoordinator(root).workspaceId, parentRunId: "parent", groupId: "group", agentId, childRunId: `child-${agentId}`, toolCallId };
}

describe("file write evidence", () => {
  it("write_then_conflict_preserves_first_file", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "old");
    await coordinator.runLeaf(scope("a", "first"), "exclusive", undefined, async (permit) => {
      const context: ToolContext = { userQuery: "", execution: { coordinator, scope: scope("a", "first"), permit } };
      const batch = beginWriteBatch(context, [file]);
      await batch.run([file], () => fs.writeFileSync(file, "new"));
      expect(batch.finish()[0]).toMatchObject({ state: "applied", before: { sha256: sha("old") }, after: { sha256: sha("new") } });
    });
    await expect(coordinator.runLeaf(scope("b", "second"), "exclusive", undefined, async (permit) => {
      beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("b", "second"), permit } }, [file]);
    })).rejects.toMatchObject({ code: "AGENT_WRITE_CONFLICT" });
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(coordinator.getWriteEvidence({ toolCallId: "first" })[0]).toMatchObject({ state: "applied", after: { sha256: sha("new") } });
    expect(coordinator.getWriteEvidence({ toolCallId: "second" })).toEqual([]);
    await coordinator.closeGroup("group");
  });

  it("records completed, partial and untouched paths independently before failure returns", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const files = ["done", "partial", "untouched"].map((name) => path.join(root, name));
    for (const file of files) fs.writeFileSync(file, "old");
    await coordinator.runLeaf(scope("a", "partial"), "exclusive", undefined, async (permit) => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("a", "partial"), permit } }, files);
      await batch.run([files[0]], () => fs.writeFileSync(files[0], "complete"));
      await expect(batch.run([files[1]], () => { fs.writeFileSync(files[1], "part"); throw new Error("disk failure"); })).rejects.toThrow("disk failure");
      const evidence = batch.finish();
      expect(evidence.map((item) => item.state)).toEqual(["applied", "partially_applied", "not_applied"]);
      expect(evidence[1].after?.sha256).toBe(sha("part"));
      expect(evidence.every((item) => item.eventIds.length > 0)).toBe(true);
      expect(coordinator.getWriteEvidence({ childRunId: "child-a" })).toEqual(evidence);
    });
    await coordinator.closeGroup("group");
  });

  it("a same-byte write followed by failure stays unknown rather than claiming no effects", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const file = path.join(root, "same-bytes");
    fs.writeFileSync(file, "same");
    await coordinator.runLeaf(scope("a", "unknown"), "exclusive", undefined, async (permit) => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("a", "unknown"), permit } }, [file]);
      await expect(batch.run([file], () => { fs.writeFileSync(file, "same"); throw new Error("after-write error"); })).rejects.toThrow("after-write error");
      expect(batch.finish()[0]).toMatchObject({ state: "unknown", before: { sha256: sha("same") }, after: { sha256: sha("same") } });
    });
    await coordinator.closeGroup("group");
  });

  it.runIf(process.platform !== "win32")("symlink aliases share ownership but retain distinct actual operation path records", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const file = path.join(root, "real-file");
    const alias = path.join(root, "alias-file");
    fs.writeFileSync(file, "old");
    fs.symlinkSync(file, alias);
    await coordinator.runLeaf(scope("a", "alias"), "exclusive", undefined, async (permit) => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("a", "alias"), permit } }, [file, alias]);
      await batch.run([file, alias], () => { fs.writeFileSync(alias, "new"); fs.writeFileSync(file, "new"); });
      expect(batch.finish()).toHaveLength(2);
      for (const item of batch.finish()) expect(item).toMatchObject({ canonicalPath: fs.realpathSync(file), state: "applied", after: { sha256: sha("new") } });
      expect(coordinator.getWriteEvidence()).toEqual(batch.finish());
    });
    await coordinator.closeGroup("group");
  });

  it("a post-mutation subscriber failure preserves applied facts for every completed path", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const files = [path.join(root, "a"), path.join(root, "b")];
    for (const file of files) fs.writeFileSync(file, "old");
    coordinator.onChildWrites("child-a", (writes) => {
      if (writes.some((item) => item.state === "applied")) throw new Error("evidence store ENOSPC");
    });
    await coordinator.runLeaf(scope("a", "publish-failure"), "exclusive", undefined, async (permit) => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("a", "publish-failure"), permit } }, files);
      await expect(batch.run(files, () => { for (const file of files) fs.writeFileSync(file, "new"); })).rejects.toThrow("evidence store ENOSPC");
      expect(batch.finish().map((item) => item.state)).toEqual(["applied", "applied"]);
      const writes = coordinator.getWriteEvidence();
      expect(writes.map((item) => item.state)).toEqual(["applied", "applied"]);
      expect(writes.every((item) => item.after?.sha256 === sha("new"))).toBe(true);
    });
    await coordinator.closeGroup("group");
  });

  it("keeps the original mutation error while observing every path despite publication failure", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const files = [path.join(root, "a"), path.join(root, "b")];
    for (const file of files) fs.writeFileSync(file, "old");
    coordinator.onChildWrites("child-a", (writes) => {
      if (writes.some((item) => item.state === "partially_applied")) throw new Error("evidence store ENOSPC");
    });
    await coordinator.runLeaf(scope("a", "mutation-failure"), "exclusive", undefined, async (permit) => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("a", "mutation-failure"), permit } }, files);
      expect(() => batch.runSync(files, () => { for (const file of files) fs.writeFileSync(file, "partial"); throw new Error("original mutation failure"); })).toThrow("original mutation failure");
      expect(coordinator.getWriteEvidence().map((item) => item.state)).toEqual(["partially_applied", "partially_applied"]);
      expect(batch.finish().every((item) => item.after?.sha256 === sha("partial"))).toBe(true);
    });
    await coordinator.closeGroup("group");
  });

  it("marks actual deletion as an absent version", async () => {
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const file = path.join(root, "deleted");
    fs.writeFileSync(file, "old");
    await coordinator.runLeaf(scope("a", "delete"), "exclusive", undefined, async (permit) => {
      const batch = beginWriteBatch({ userQuery: "", execution: { coordinator, scope: scope("a", "delete"), permit } }, [file]);
      batch.runSync([file], () => fs.unlinkSync(file));
      expect(batch.finish()[0]).toMatchObject({ state: "applied", after: { version: "absent" } });
    });
    await coordinator.closeGroup("group");
  });
});
