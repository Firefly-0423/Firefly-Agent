/** Synthetic Git smart-HTTP v2 responses for tests. Nothing here touches the network. */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { pktLine, PKT_DELIM, PKT_FLUSH } from "../external-git-pack";

export type GitType = "commit" | "tree" | "blob" | "tag";
const TYPE_CODES: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export const gitId = (type: GitType, data: Buffer) => createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
export function treeObject(entries: Array<{ mode: string; name: string; sha: string }>): Buffer {
  return Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), Buffer.from(entry.sha, "hex")])));
}
export const commitObject = (tree: string) => Buffer.from(`tree ${tree}\nauthor Synthetic <synthetic@example.invalid> 0 +0000\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\n\nsynthetic\n`);

function header(code: number, size: number): Buffer {
  const bytes = [((code & 7) << 4) | (size & 15)]; let rest = Math.floor(size / 16);
  while (rest > 0) { bytes[bytes.length - 1] |= 0x80; bytes.push(rest & 0x7f); rest = Math.floor(rest / 128); }
  return Buffer.from(bytes);
}
function ofsDistance(distance: number): Buffer {
  const bytes = [distance & 0x7f]; let rest = Math.floor(distance / 128);
  while (rest > 0) { rest -= 1; bytes.unshift(0x80 | (rest & 0x7f)); rest = Math.floor(rest / 128); }
  return Buffer.from(bytes);
}
const varint = (value: number) => { const bytes: number[] = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; bytes.push(byte); } while (value); return Buffer.from(bytes); };
/** A delta that copies `base[0, keep)` and appends `tail`. */
export function delta(base: Buffer, keep: number, tail: Buffer): Buffer {
  const ops: Buffer[] = [varint(base.length), varint(keep + tail.length)];
  if (keep) ops.push(Buffer.from([0x80 | 0x10 | 0x20, keep & 0xff, (keep >> 8) & 0xff]));
  for (let i = 0; i < tail.length; i += 127) { const part = tail.subarray(i, i + 127); ops.push(Buffer.from([part.length]), part); }
  return Buffer.concat(ops);
}

export type PackItem = { type: GitType; data: Buffer } | { ofsBase: number; delta: Buffer } | { ofsDistance: number; delta: Buffer } | { refBase: string; delta: Buffer };
/** A version-2 pack with a valid trailer. `ofsBase` names an earlier item by index. */
export function pack(items: PackItem[]): Buffer {
  const parts: Buffer[] = [Buffer.from("PACK"), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2); parts[2].writeUInt32BE(items.length);
  const offsets: number[] = []; let offset = 12;
  for (const item of items) {
    offsets.push(offset);
    let entry: Buffer;
    if ("type" in item) entry = Buffer.concat([header(TYPE_CODES[item.type], item.data.length), deflateSync(item.data)]);
    else if ("ofsBase" in item) entry = Buffer.concat([header(6, item.delta.length), ofsDistance(offset - offsets[item.ofsBase]), deflateSync(item.delta)]);
    else if ("ofsDistance" in item) entry = Buffer.concat([header(6, item.delta.length), ofsDistance(item.ofsDistance), deflateSync(item.delta)]);
    else entry = Buffer.concat([header(7, item.delta.length), Buffer.from(item.refBase, "hex"), deflateSync(item.delta)]);
    parts.push(entry); offset += entry.length;
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
export const lsRefsResponse = (commit: string) => Buffer.concat([pktLine(`${commit} HEAD symref-target:refs/heads/main\n`), PKT_FLUSH]);
/** A fetch response: shallow-info, then the pack on sideband 1 in small chunks, with one progress line. */
export function band(channel: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([channel]), payload]);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}
export function fetchResponse(packBytes: Buffer, commit: string): Buffer {
  const chunks: Buffer[] = [];
  for (let i = 0; i < packBytes.length; i += 1000) chunks.push(band(1, packBytes.subarray(i, i + 1000)));
  return Buffer.concat([pktLine("shallow-info\n"), pktLine(`shallow ${commit}\n`), PKT_DELIM, pktLine("packfile\n"),
    band(2, Buffer.from("Counting objects\n")), ...chunks, PKT_FLUSH]);
}

/** A whole synthetic repository at one commit: its trees-only fetch and ls-refs responses. */
export function gitRepository(files: ReadonlyMap<string, Buffer>): { commit: string; lsRefs: Buffer; fetch: Buffer } {
  type Dir = Map<string, Dir | string>;
  const root: Dir = new Map();
  for (const [filePath, bytes] of files) {
    const parts = filePath.split("/"); let dir = root;
    for (const part of parts.slice(0, -1)) { let next = dir.get(part); if (!(next instanceof Map)) { next = new Map(); dir.set(part, next); } dir = next; }
    dir.set(parts.at(-1)!, gitId("blob", bytes));
  }
  const objects: Array<{ type: GitType; data: Buffer }> = [];
  const write = (dir: Dir): string => {
    const entries = [...dir].map(([name, value]) => value instanceof Map ? { mode: "40000", name, sha: write(value) } : { mode: "100644", name, sha: value })
      .sort((left, right) => (left.mode === "40000" ? left.name + "/" : left.name) < (right.mode === "40000" ? right.name + "/" : right.name) ? -1 : 1);
    const data = treeObject(entries); objects.push({ type: "tree", data }); return gitId("tree", data);
  };
  const rootId = write(root), commitData = commitObject(rootId), commit = gitId("commit", commitData);
  return { commit, lsRefs: lsRefsResponse(commit), fetch: fetchResponse(pack([{ type: "commit", data: commitData }, ...objects]), commit) };
}
