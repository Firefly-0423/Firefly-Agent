import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";

let root: string;
const registry = new Map<string, any>();
vi.mock("electron", () => ({ app: { getPath: () => root } }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: { register: (tool: any) => registry.set(tool.id, tool) } }));
vi.mock("../../external-content-paths", () => ({ findSkillPath: () => null }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, createWriteStream: (...args: any[]) => (actual.default.createWriteStream as any)(...args) };
});
import { registerDocumentTools } from "./document-tools";
registerDocumentTools();
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "excel-lifetime-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("drains the actual owned Excel stream after serialization rejection, including delayed open", async () => {
  const file = path.join(root, "bad.xlsx");
  fs.writeFileSync(file, "old");
  let output: fs.WriteStream | undefined;
  let releaseOpen: (() => void) | undefined;
  let notifyOpen!: () => void;
  const openStarted = new Promise<void>((resolve) => { notifyOpen = resolve; });
  const create = fs.createWriteStream;
  vi.spyOn(fs, "createWriteStream").mockImplementation(((target: any, options: any) => {
    if (String(target) !== file) return create(target, options);
    const hooks = { ...fs, open: (target: any, flags: any, mode: any, callback: any) => {
      releaseOpen = () => fs.open(target, flags, mode, callback);
      notifyOpen();
    } };
    output = create(target, { ...options, fs: hooks });
    return output;
  }) as any);
  const coordinator = getWorkspaceExecutionCoordinator(root);
  const scope = { workspaceId: coordinator.workspaceId, parentRunId: "p", groupId: "g", agentId: "a", childRunId: "ca", toolCallId: "excel" };
  const writer = coordinator.runLeaf(scope, "exclusive", undefined, async (permit) => registry.get("write_excel").execute(
    { filename: "bad.xlsx", sheets: [{ name: "s", headers: ["Header"], rows: [[{ sharedFormula: "B1", result: 1 }]] }] },
    { userQuery: "", resolvedWorkspaceRoot: root, execution: { coordinator, scope, permit } },
  ));
  let writerSettled = false;
  void writer.then(() => { writerSettled = true; }, () => { writerSettled = true; });
  try {
    await openStarted;
    await vi.waitFor(() => expect(writerSettled || output?.destroyed).toBe(true));
    let readEntered = false;
    const reader = coordinator.runLeaf({ ...scope, agentId: "b", childRunId: "cb", toolCallId: "read" }, "shared", undefined, async () => {
      readEntered = true;
      expect(output?.closed).toBe(true);
      return fs.readFileSync(file);
    });
    await Promise.resolve();
    expect(writerSettled).toBe(false);
    expect(readEntered).toBe(false);
    releaseOpen!(); releaseOpen = undefined;
    await expect(writer).rejects.toThrow("Shared Formula master");
    const bytes = await reader;
    expect(output?.closed).toBe(true);
    expect(coordinator.getWriteEvidence()[0]).toMatchObject({ state: "partially_applied", after: { sha256: createHash("sha256").update(bytes).digest("hex") } });
    await coordinator.closeGroup("g");
  } finally {
    releaseOpen?.();
    if (output && !output.closed) {
      const closed = new Promise<void>((resolve) => output!.once("close", resolve));
      output.destroy();
      await closed;
    }
    await writer.catch(() => {});
  }
});
