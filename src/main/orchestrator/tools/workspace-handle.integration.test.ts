import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../permission", () => ({ getCurrentLevel: () => "full" }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
import { createWorkspaceHandleBridge, workspaceHelperPath } from "./workspace-handle";
import type { ToolContext } from "./registry/tool-context";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-native-integration-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const context = (write = false): ToolContext => ({ userQuery: "real helper", resolvedWorkspaceRoot: root, fileAccessLevel: write ? "scoped" : "project-read-only" });
const windows = it.runIf(process.platform === "win32");
windows("the packaged-contract release helper returns binary bytes, canonical names, stat and handle listing", async () => {
  const b = createWorkspaceHandleBridge();
  const file = path.join(root, "MiXeD.bin"), bytes = Buffer.from([0, 255, 10, 13, 128]); fs.writeFileSync(file, bytes);
  const read = await b.readFile(path.join(root, "mixed.BIN"), context(), 10);
  expect(read?.bytes).toEqual(bytes); expect(read?.canonicalPath).toBe(file);
  const oracle = fs.statSync(file, { bigint: true });
  expect(read?.identity).toEqual({ deviceId: oracle.dev.toString(16).padStart(32, "0"), fileId: oracle.ino.toString(16).padStart(32, "0") });
  const stat = await b.statEntry(file, context()); expect(stat).toMatchObject({ exists: true, kind: "file", size: 5, bytes: null });
  expect(stat?.identity).toEqual(read?.identity);
  expect(await b.listDirectory(root, context())).toEqual([{ name: "MiXeD.bin", kind: "file", size: 5, identity: read!.identity }]);
});
windows("a real helper creates only at commit, then replaces and appends through the held handle", async () => {
  const b = createWorkspaceHandleBridge(); const file = path.join(root, "a", "b", "file.txt");
  await b.withWrite(file, context(true), true, async lease => {
    expect(lease!.before.exists).toBe(false); expect(fs.existsSync(path.dirname(file))).toBe(false);
    const after = await lease!.commit(Buffer.from("original"), "replace"); expect(after.bytes!.toString()).toBe("original");
  });
  await b.withWrite(file, context(true), false, async lease => {
    expect(lease!.before.bytes!.toString()).toBe("original");
    expect(() => fs.renameSync(file, file + ".moved")).toThrow();
    const after = await lease!.commit(Buffer.from("new"), "replace"); expect(after.identity).toEqual(lease!.before.identity);
  });
  await b.withWrite(file, context(true), false, async lease => { await lease!.commit(Buffer.from(" tail"), "append"); });
  expect(fs.readFileSync(file, "utf8")).toBe("new tail");
});
windows("an asynchronously missing native executable fails closed", async () => {
  const b = createWorkspaceHandleBridge({ resolveBinary: () => path.join(root, "missing.exe") });
  await expect(b.readFile(path.join(root, "file"), context())).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", effectState: "not_applied" });
  expect(fs.readdirSync(root)).toEqual([]);
});
windows("the real release executable runs from the packaged resources/bin location", async () => {
  const resources = path.join(root, "resources"), directory = path.join(resources, "bin"); fs.mkdirSync(directory, { recursive: true });
  const binary = workspaceHelperPath({ isPackaged: true, getAppPath: () => { throw Error("asar must not be used"); } }, resources);
  fs.copyFileSync(path.join(process.cwd(), "native", "target", "release", "firefly-workspace.exe"), binary);
  const file = path.join(root, "packaged.txt"); fs.writeFileSync(file, "packaged bytes");
  const bridge = createWorkspaceHandleBridge({ resolveBinary: () => binary });
  expect((await bridge.readFile(file, context()))?.bytes?.toString()).toBe("packaged bytes");
});
