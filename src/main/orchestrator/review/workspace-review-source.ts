import * as fs from "fs";
import path from "node:path";
import { assertWorkspacePathFallback } from "../tools/workspace-boundary";
import type { ToolContext } from "../tools/registry/tool-context";
import type { WorkspaceIdentity, WorkspaceSnapshot } from "../tools/workspace-handle";

function opaque(value: bigint): string {
  if (value < 0 || value >= (1n << 128n)) throw new Error("Invalid filesystem identity");
  return value.toString(16).padStart(32, "0");
}
export function reviewIdentityKey(identity: WorkspaceIdentity | null | undefined): string | undefined {
  return identity ? `${identity.deviceId}:${identity.fileId}` : undefined;
}
/** Full/per-action or legacy Unix path fallback only. fstat and bytes describe
 * one fd; this is NOT used as a restricted Windows containment proof. */
export function readWorkspaceReviewSource(file: string, context?: ToolContext, maxBytes = Infinity, access: "read" | "write" = "read"): WorkspaceSnapshot {
  assertWorkspacePathFallback(file, access, context);
  let fd: number;
  try { fd = fs.openSync(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, kind: "missing", size: 0, bytes: null, identity: null, canonicalPath: path.resolve(file) };
    throw error;
  }
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (!info.isFile()) throw new Error("Review source is not a regular file");
    assertWorkspacePathFallback(file, access, context);
    const bytes = info.size <= BigInt(Number.MAX_SAFE_INTEGER) && Number(info.size) <= maxBytes ? fs.readFileSync(fd) : null;
    const name = path.resolve(file);
    // ADS streams share the base file's Windows ID; remote volume serials are
    // not local identities. Keep these unrestricted observations separate.
    const localDefaultStream = process.platform !== "win32" || (/^[a-z]:\\/i.test(name) && !name.slice(3).includes(":"));
    return { exists: true, kind: "file", size: bytes?.length ?? Number(info.size), bytes,
      identity: localDefaultStream ? { deviceId: opaque(info.dev), fileId: opaque(info.ino) } : null, canonicalPath: name };
  } finally { fs.closeSync(fd); }
}
