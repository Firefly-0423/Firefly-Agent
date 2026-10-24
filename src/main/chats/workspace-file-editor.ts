/** Exact-file manual edits. Workspace binding alone never grants write permission. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceFileErrorCode, WorkspaceSaveRequest, WorkspaceSaveResult } from "../../shared/workspace-files-types";
import { getWorkspaceExecutionCoordinator } from "../orchestrator/harness/execution-coordinator";

const MAX_BYTES = 1024 * 1024;
const SAVE_QUEUE_TIMEOUT_MS = 15_000;
const failure = (code: WorkspaceFileErrorCode): never => { throw Object.assign(new Error(code), { code }); };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink];
function textBytes(content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_BYTES) failure("TOO_LARGE");
  if (bytes.toString("utf8") !== content || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(content)) failure("UNSUPPORTED_TEXT");
  return bytes;
}
function strictRelative(relPath: string): string[] {
  if (!relPath || /[\0:]/.test(relPath) || /^[\\/]/.test(relPath)) failure("OUT_OF_ROOT");
  const segments = relPath.replaceAll("\\", "/").split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) failure("OUT_OF_ROOT");
  return segments;
}

/** A bounded synchronous snapshot: no app operation can interleave inspection and commit. */
export function inspectWorkspaceText(root: string, relPath: string): {
  content: string; size: number; editVersion: string; target: string; rootReal: string; mode: number;
} {
  const segments = strictRelative(relPath);
  const rootReal = fs.realpathSync(root);
  if (!samePath(rootReal, path.resolve(root)) || fs.lstatSync(root).isSymbolicLink()) failure("LINK_READ_ONLY");
  const ancestors: unknown[] = [identity(fs.statSync(rootReal))];
  let target = rootReal;
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) failure("LINK_READ_ONLY");
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) failure("NOT_FOUND");
      // Directory times change when our sibling temp file is created. Only its identity matters.
      ancestors.push([stat.dev, stat.ino]);
    }
  }
  // Root times also change on sibling-file creation; retain only root identity.
  const rootStat = fs.statSync(rootReal); ancestors[0] = [rootStat.dev, rootStat.ino];
  const before = fs.lstatSync(target);
  if (!before.isFile()) failure(before.isDirectory() ? "IS_DIRECTORY" : "UNSUPPORTED_TEXT");
  if (before.nlink !== 1) failure("LINK_READ_ONLY");
  if ((before.mode & 0o222) === 0) failure("READ_ONLY");
  if (before.size > MAX_BYTES) failure("TOO_LARGE");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(opened))) failure("CONFLICT");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) failure("TOO_LARGE");
    bytes = buffer.subarray(0, length);
    if (JSON.stringify(identity(opened)) !== JSON.stringify(identity(fs.fstatSync(fd)))) failure("CONFLICT");
  } finally { fs.closeSync(fd); }
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) failure("UNSUPPORTED_TEXT");
  textBytes(content);
  const editVersion = createHash("sha256").update(JSON.stringify([rootReal, ancestors, target, identity(before)])).update(bytes).digest("hex");
  return { content, size: bytes.length, editVersion, target, rootReal, mode: before.mode };
}

function errorCode(error: unknown): WorkspaceFileErrorCode {
  if ((error as { name?: string })?.name === "AbortError") return "WRITE_BUSY";
  const code = (error as { code?: string })?.code;
  if (["OUT_OF_ROOT", "IS_DIRECTORY", "TOO_LARGE", "CONFLICT", "LINK_READ_ONLY", "UNSUPPORTED_TEXT", "READ_ONLY"].includes(code ?? "")) return code as WorkspaceFileErrorCode;
  if (code === "ENOENT" || code === "ENOTDIR") return "NOT_FOUND";
  if (code === "EACCES" || code === "EPERM") return "READ_ONLY";
  if (code === "ELOOP") return "LINK_READ_ONLY";
  return "WRITE_FAILED";
}
export interface WorkspaceEditDependencies {
  getBinding(sessionId: string): { workspaceRoot: string; boundAt: number } | undefined;
  /** Main-owned native one-time confirmation, never a renderer-supplied boolean. */
  confirm(details: { workspaceRoot: string; relPath: string; size: number }): Promise<boolean>;
  /** Current ChatWindow main-frame and captured navigation lifetime. */
  isCurrent(): boolean;
}

export async function saveWorkspaceText(deps: WorkspaceEditDependencies, input: unknown): Promise<WorkspaceSaveResult> {
  const request = input as Partial<WorkspaceSaveRequest> | null;
  if (!request || typeof request.sessionId !== "string" || !request.sessionId || typeof request.relPath !== "string" || typeof request.content !== "string" || typeof request.editVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.editVersion)) return { ok: false, code: "INVALID_REQUEST" };
  const { sessionId, relPath, content, editVersion } = request as WorkspaceSaveRequest;
  if (!deps.isCurrent()) return { ok: false, code: "FORBIDDEN" };
  const binding = deps.getBinding(sessionId);
  if (!binding) return { ok: false, code: "NO_WORKSPACE" };
  const initialBinding = { workspaceRoot: binding.workspaceRoot, boundAt: binding.boundAt };
  const bindingCurrent = () => { const now = deps.getBinding(sessionId); return now?.workspaceRoot === initialBinding.workspaceRoot && now.boundAt === initialBinding.boundAt; };
  try {
    const bytes = textBytes(content);
    const before = inspectWorkspaceText(initialBinding.workspaceRoot, relPath);
    if (before.editVersion !== editVersion) return { ok: false, code: "CONFLICT" };
    if (!await deps.confirm({ workspaceRoot: before.rootReal, relPath, size: bytes.length })) return { ok: false, code: "CANCELLED" };
    const coordinator = getWorkspaceExecutionCoordinator(before.rootReal);
    const operationId = `workspace-editor:${randomUUID()}`;
    // Cancellation removes a queued operation from the existing coordinator. It
    // never reports a still-running write as cancelled; the actual commit is sync.
    const controller = new AbortController();
    const queueDeadline = setTimeout(() => controller.abort(), SAVE_QUEUE_TIMEOUT_MS);
    queueDeadline.unref?.();
    try {
      return await coordinator.runLeaf({ workspaceId: coordinator.workspaceId, parentRunId: operationId, groupId: operationId, agentId: "manual-workspace-editor", childRunId: operationId, toolCallId: operationId }, "exclusive", controller.signal, async () => {
        if (!deps.isCurrent()) return { ok: false, code: "FORBIDDEN" };
        if (!bindingCurrent()) return { ok: false, code: "WORKSPACE_CHANGED" };
        const current = inspectWorkspaceText(initialBinding.workspaceRoot, relPath);
        if (current.editVersion !== editVersion) return { ok: false, code: "CONFLICT" };
        const temporary = path.join(path.dirname(current.target), `.firefly-edit-${randomUUID()}.tmp`);
        let temporaryExists = false;
        try {
          const fd = fs.openSync(temporary, "wx", 0o600); temporaryExists = true;
          try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, current.mode & 0o777); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          // Recheck after temp preparation as well, including directory and file identities.
          if (!deps.isCurrent()) return { ok: false, code: "FORBIDDEN" };
          if (!bindingCurrent()) return { ok: false, code: "WORKSPACE_CHANGED" };
          if (inspectWorkspaceText(initialBinding.workspaceRoot, relPath).editVersion !== editVersion) return { ok: false, code: "CONFLICT" };
          fs.renameSync(temporary, current.target); temporaryExists = false;
          const saved = inspectWorkspaceText(initialBinding.workspaceRoot, relPath);
          return { ok: true, content: saved.content, size: saved.size, editVersion: saved.editVersion };
        } finally { if (temporaryExists) { try { fs.unlinkSync(temporary); } catch { /* retain original failure */ } } }
      });
    } finally { clearTimeout(queueDeadline); await coordinator.closeGroup(operationId); }
  } catch (error) { return { ok: false, code: errorCode(error) }; }
}
