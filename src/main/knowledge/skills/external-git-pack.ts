import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { TextDecoder } from "node:util";

/**
 * Git smart-HTTP protocol v2, limited to what the external market needs: the HEAD commit (ls-refs)
 * and that commit's trees without any blob (fetch, deepen 1, filter blob:none). Git's HTTP service
 * is outside the 60-per-hour unauthenticated REST budget. Every object id is recomputed from its
 * bytes, so the returned tree is anchored to the requested commit id.
 */
export type GitPackFailure = "CATALOG_INVALID" | "TREE_INVALID" | "LIMIT_EXCEEDED" | "NETWORK_FAILED";
type Fail = (code: GitPackFailure) => never;
export interface GitTreeEntry { path: string; mode: string; type: "blob" | "tree"; sha: string }
interface GitObject { type: "commit" | "tree" | "blob" | "tag"; data: Buffer }

const OBJECT_TYPES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" } as const;
const MAX_TREE_DEPTH = 64;

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}
export const PKT_FLUSH = Buffer.from("0000", "ascii");
export const PKT_DELIM = Buffer.from("0001", "ascii");

export const LS_REFS_REQUEST = Buffer.concat([pktLine("command=ls-refs\n"), PKT_DELIM, pktLine("symrefs\n"), pktLine("ref-prefix HEAD\n"), PKT_FLUSH]);
export function treesOnlyFetchRequest(commit: string): Buffer {
  return Buffer.concat([pktLine("command=fetch\n"), PKT_DELIM, pktLine("no-progress\n"), pktLine("ofs-delta\n"), pktLine("deepen 1\n"),
    pktLine("filter blob:none\n"), pktLine(`want ${commit}\n`), pktLine("done\n"), PKT_FLUSH]);
}

type Packet = { kind: "data"; data: Buffer } | { kind: "flush" | "delim" | "end" };
function* packets(buffer: Buffer, fail: Fail): Generator<Packet> {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) fail("NETWORK_FAILED");
    const header = buffer.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) fail("NETWORK_FAILED");
    const length = parseInt(header, 16);
    if (length < 3) { yield { kind: length === 0 ? "flush" : length === 1 ? "delim" : "end" }; offset += 4; continue; }
    if (length === 3 || offset + length > buffer.length) fail("NETWORK_FAILED");
    yield { kind: "data", data: buffer.subarray(offset + 4, offset + length) };
    offset += length;
  }
}

/** The commit HEAD points at, from an ls-refs response. */
export function parseHeadRef(response: Buffer, fail: Fail): string {
  for (const packet of packets(response, fail)) {
    if (packet.kind !== "data") break;
    const line = packet.data.toString("utf8");
    if (line.startsWith("ERR ")) fail("NETWORK_FAILED");
    const match = /^([0-9a-f]{40}) HEAD(?:[ \n]|$)/.exec(line);
    if (match) return match[1];
  }
  return fail("CATALOG_INVALID");
}

/** The packfile bytes of a fetch response (sideband 1), bounded by `limit`. */
export function extractPack(response: Buffer, limit: number, fail: Fail): Buffer {
  const parts: Buffer[] = [];
  let inPack = false, ended = false, total = 0;
  for (const packet of packets(response, fail)) {
    if (!inPack) {
      // shallow-info and other sections precede the packfile; only their errors matter.
      if (packet.kind !== "data") continue;
      const line = packet.data.toString("utf8");
      if (line.startsWith("ERR ")) fail("NETWORK_FAILED");
      if (line === "packfile\n") inPack = true;
      continue;
    }
    if (packet.kind === "flush") { ended = true; break; }
    if (packet.kind !== "data" || packet.data.length === 0) fail("NETWORK_FAILED");
    const band = packet.data[0];
    if (band === 1) {
      total += packet.data.length - 1; if (total > limit) fail("LIMIT_EXCEEDED");
      parts.push(packet.data.subarray(1));
    } else if (band !== 2) fail("NETWORK_FAILED");
  }
  if (!ended) fail("NETWORK_FAILED");
  return Buffer.concat(parts, total);
}

function applyDelta(base: Buffer, delta: Buffer, maxBytes: number, fail: Fail): Buffer {
  let offset = 0;
  const varint = () => {
    let value = 0, shift = 0, byte: number;
    do {
      if (offset >= delta.length || shift > 28) fail("TREE_INVALID");
      byte = delta[offset++]; value += (byte & 0x7f) * 2 ** shift; shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) fail("TREE_INVALID");
  const size = varint(); if (size > maxBytes) fail("LIMIT_EXCEEDED");
  const out = Buffer.alloc(size); let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let from = 0, length = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) { if (offset >= delta.length) fail("TREE_INVALID"); from += delta[offset++] * 2 ** (8 * bit); }
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) { if (offset >= delta.length) fail("TREE_INVALID"); length += delta[offset++] * 2 ** (8 * bit); }
      if (length === 0) length = 0x10000;
      if (from + length > base.length || written + length > size) fail("TREE_INVALID");
      base.copy(out, written, from, from + length); written += length;
    } else if (op) {
      if (offset + op > delta.length || written + op > size) fail("TREE_INVALID");
      delta.copy(out, written, offset, offset + op); offset += op; written += op;
    } else fail("TREE_INVALID");
  }
  if (written !== size) fail("TREE_INVALID");
  return out;
}

/** Every object of a version-2 pack by recomputed id. Deltas resolve only against objects in the same pack. */
export function readPack(pack: Buffer, limits: { objects: number; inflatedBytes: number }, fail: Fail): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString("ascii", 0, 4) !== "PACK" || pack.readUInt32BE(4) !== 2) fail("TREE_INVALID");
  const count = pack.readUInt32BE(8); if (count > limits.objects) fail("LIMIT_EXCEEDED");
  const end = pack.length - 20;
  if (!createHash("sha1").update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) fail("TREE_INVALID");
  const byOffset = new Map<number, GitObject>(), byId = new Map<string, GitObject>();
  let offset = 12, inflated = 0;
  const next = () => { if (offset >= end) fail("TREE_INVALID"); return pack[offset++]; };
  for (let index = 0; index < count; index++) {
    const start = offset;
    let byte = next(); const code = (byte >> 4) & 7; let size = byte & 15, shift = 4;
    while (byte & 0x80) { if (shift > 32) fail("TREE_INVALID"); byte = next(); size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    let base: GitObject | undefined;
    if (code === 6) {
      byte = next(); let distance = byte & 0x7f;
      while (byte & 0x80) { byte = next(); distance = (distance + 1) * 128 + (byte & 0x7f); if (distance > start) fail("TREE_INVALID"); }
      base = byOffset.get(start - distance); if (!base) fail("TREE_INVALID");
    } else if (code === 7) {
      if (offset + 20 > end) fail("TREE_INVALID");
      base = byId.get(pack.toString("hex", offset, offset + 20)); offset += 20; if (!base) fail("TREE_INVALID");
    } else if (!(code in OBJECT_TYPES)) fail("TREE_INVALID");
    if (size > limits.inflatedBytes - inflated) fail("LIMIT_EXCEEDED");
    let data: Buffer, consumed: number;
    try {
      const result = inflateSync(pack.subarray(offset, end), { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      data = result.buffer; consumed = result.engine.bytesWritten;
    } catch { return fail("TREE_INVALID"); }
    if (data.length !== size || !(consumed > 0)) fail("TREE_INVALID");
    offset += consumed; inflated += size;
    let object: GitObject;
    if (base) {
      object = { type: base.type, data: applyDelta(base.data, data, limits.inflatedBytes - inflated, fail) };
      inflated += object.data.length;
    } else object = { type: OBJECT_TYPES[code as keyof typeof OBJECT_TYPES], data };
    const id = createHash("sha1").update(`${object.type} ${object.data.length}\0`).update(object.data).digest("hex");
    byOffset.set(start, object); byId.set(id, object);
  }
  if (offset !== end) fail("TREE_INVALID");
  return byId;
}

/** The recursive tree of `commit` from verified pack objects; only regular files and directories are accepted. */
export function treeFromPack(objects: Map<string, GitObject>, commit: string, maxEntries: number, fail: Fail): GitTreeEntry[] {
  const head = objects.get(commit); if (!head || head.type !== "commit") return fail("TREE_INVALID");
  const root = /^tree ([0-9a-f]{40})\n/.exec(head.data.toString("latin1")); if (!root) return fail("TREE_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true }), entries: GitTreeEntry[] = [];
  const visit = (id: string, prefix: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH) fail("TREE_INVALID");
    const tree = objects.get(id); if (!tree || tree.type !== "tree") fail("TREE_INVALID");
    const data = tree!.data; let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset), nul = space < 0 ? -1 : data.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > data.length) fail("TREE_INVALID");
      const mode = data.toString("ascii", offset, space);
      let name: string;
      try { name = decoder.decode(data.subarray(space + 1, nul)); } catch { return fail("TREE_INVALID"); }
      // One path segment per entry; a name carrying "/" would pose as a nested file without its parent trees.
      if (!name || name.includes("/")) fail("TREE_INVALID");
      const sha = data.toString("hex", nul + 1, nul + 21), path = prefix ? prefix + "/" + name : name;
      offset = nul + 21;
      if (mode === "40000") entries.push({ path, mode: "040000", type: "tree", sha });
      else if (mode === "100644" || mode === "100755") entries.push({ path, mode, type: "blob", sha });
      else fail("TREE_INVALID");
      if (entries.length > maxEntries) fail("LIMIT_EXCEEDED");
      if (mode === "40000") visit(sha, path, depth + 1);
    }
  };
  visit(root[1], "", 1);
  return entries;
}
