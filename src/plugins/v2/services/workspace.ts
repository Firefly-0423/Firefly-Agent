import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { PluginError } from "../../../shared/plugin-protocol";

const denied = () => new PluginError("ERR_PERMISSION", "Workspace path is not accessible");
const maxBytes = 1024 * 1024;
/** Refuse all links (including ancestors/junctions), devices, alternate streams and traversal.
 * Revalidate each directory identity plus opened-file identity before publishing any bytes.
 */
export async function readWorkspaceFile(root: string, relative: string, signal: AbortSignal): Promise<string> {
  if (!relative || relative.includes("\0") || /[:\\]/.test(relative) || path.isAbsolute(relative) || relative.split("/").some(s => !s || s === "." || s === "..")) throw denied();
  const absoluteRoot = path.resolve(root), target = path.resolve(absoluteRoot, relative);
  const segments = target.slice(path.parse(target).root.length).split(path.sep).filter(Boolean);
  const paths: string[] = [];
  let current = path.parse(target).root;
  for (const segment of segments) { current = path.join(current, segment); paths.push(current); }
  const checkAbort = () => { if (signal.aborted) throw new PluginError("ERR_CANCELLED", "Workspace read cancelled"); };
  try {
    checkAbort();
    const snapshots = [];
    for (let i = 0; i < paths.length; i++) {
      const info = await lstat(paths[i], { bigint: true });
      if (info.isSymbolicLink() || (i === paths.length - 1 ? !info.isFile() : !info.isDirectory())) throw denied();
      snapshots.push(info);
    }
    if (await realpath(absoluteRoot) !== absoluteRoot || await realpath(target) !== target) throw denied();
    const expected = snapshots[snapshots.length - 1];
    if (expected.size > BigInt(maxBytes)) throw new PluginError("ERR_INVALID_ARGUMENT", "Workspace file exceeds 1 MiB");
    checkAbort();
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw denied();
      const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
      while (length < bytes.length) {
        checkAbort(); const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break; length += read.bytesRead;
      }
      if (length > maxBytes) throw new PluginError("ERR_INVALID_ARGUMENT", "Workspace file exceeds 1 MiB");
      const after = await file.stat({ bigint: true });
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw denied();
      for (let i = 0; i < paths.length; i++) {
        const now = await lstat(paths[i], { bigint: true }), before = snapshots[i];
        if (now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino || now.ctimeNs !== before.ctimeNs) throw denied();
      }
      checkAbort();
      if (await realpath(target) !== target) throw denied();
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
      catch { throw new PluginError("ERR_INVALID_ARGUMENT", "Workspace file is not UTF-8 text"); }
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw denied();
  }
}
