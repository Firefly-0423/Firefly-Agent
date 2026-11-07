import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPack, parseHeadRef, readPack, treeFromPack, treesOnlyFetchRequest, LS_REFS_REQUEST, type GitPackFailure } from "./external-git-pack";
import { band, commitObject, delta, fetchResponse, gitId, gitRepository, lsRefsResponse, pack, treeObject } from "./testing/git-fixtures";
import { pktLine, PKT_FLUSH } from "./external-git-pack";

const fail = (code: GitPackFailure): never => { throw Object.assign(new Error(code), { code }); };
const limits = { objects: 1000, inflatedBytes: 1 << 20 };
const blob = (text: string) => gitId("blob", Buffer.from(text));
function treeOf(objects: ReturnType<typeof readPack>, commit: string) { return treeFromPack(objects, commit, 1000, fail); }

describe("requests", () => {
  it("asks for HEAD only and for one commit's trees without blobs", () => {
    expect(LS_REFS_REQUEST.toString()).toBe("0014command=ls-refs\n0001000csymrefs\n0014ref-prefix HEAD\n0000");
    const text = treesOnlyFetchRequest("a".repeat(40)).toString();
    expect(text).toContain("command=fetch\n"); expect(text).toContain("deepen 1\n"); expect(text).toContain("filter blob:none\n");
    expect(text).toContain(`want ${"a".repeat(40)}\n`); expect(text).toContain("done\n"); expect(text.endsWith("0000")).toBe(true);
  });
});

describe("ls-refs", () => {
  it("returns the HEAD commit", () => { expect(parseHeadRef(lsRefsResponse("b".repeat(40)), fail)).toBe("b".repeat(40)); });
  it.each([
    ["no HEAD", Buffer.concat([pktLine(`${"b".repeat(40)} refs/heads/main\n`), PKT_FLUSH]), "CATALOG_INVALID"],
    ["empty", PKT_FLUSH, "CATALOG_INVALID"],
    ["uppercase id", Buffer.concat([pktLine(`${"B".repeat(40)} HEAD\n`), PKT_FLUSH]), "CATALOG_INVALID"],
    ["server error", Buffer.concat([pktLine("ERR upload-pack: not our ref\n"), PKT_FLUSH]), "NETWORK_FAILED"],
    ["truncated packet", Buffer.from("00ffshort"), "NETWORK_FAILED"],
    ["non-hex length", Buffer.from("zzzz"), "NETWORK_FAILED"],
  ] as const)("rejects %s", (_name, response, code) => { expect(() => parseHeadRef(response, fail)).toThrow(code); });
});

describe("packfile and tree", () => {
  it("rebuilds a nested tree from a synthetic repository and anchors it to the commit id", () => {
    const repo = gitRepository(new Map([["skills/a/SKILL.md", Buffer.from("a")], ["skills/a/references/x.md", Buffer.from("x")], ["README.md", Buffer.from("r")]]));
    const entries = treeOf(readPack(extractPack(repo.fetch, 1 << 20, fail), limits, fail), repo.commit);
    expect(entries).toEqual(expect.arrayContaining([
      { path: "README.md", mode: "100644", type: "blob", sha: blob("r") },
      { path: "skills", mode: "040000", type: "tree", sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
      { path: "skills/a/SKILL.md", mode: "100644", type: "blob", sha: blob("a") },
      { path: "skills/a/references/x.md", mode: "100644", type: "blob", sha: blob("x") },
    ]));
    expect(entries).toHaveLength(6);
    // Any other commit id is absent: the tree is only reachable from the id that hashes to the served bytes.
    expect(() => treeOf(readPack(extractPack(repo.fetch, 1 << 20, fail), limits, fail), "c".repeat(40))).toThrow("TREE_INVALID");
  });
  it("applies offset and reference deltas", () => {
    const leaf = treeObject([{ mode: "100644", name: "SKILL.md", sha: blob("a") }]);
    const longer = Buffer.concat([leaf, treeObject([{ mode: "100755", name: "tool.md", sha: blob("t") }])]);
    const top = treeObject([{ mode: "40000", name: "one", sha: gitId("tree", leaf) }, { mode: "40000", name: "two", sha: gitId("tree", longer) }]);
    const three = Buffer.concat([leaf, treeObject([{ mode: "100644", name: "z.md", sha: blob("z") }])]);
    const root = treeObject([{ mode: "40000", name: "a", sha: gitId("tree", top) }, { mode: "40000", name: "b", sha: gitId("tree", three) }]);
    const commitData = commitObject(gitId("tree", root)), commit = gitId("commit", commitData);
    const bytes = pack([{ type: "commit", data: commitData }, { type: "tree", data: root }, { type: "tree", data: top }, { type: "tree", data: leaf },
      { ofsBase: 3, delta: delta(leaf, leaf.length, longer.subarray(leaf.length)) },
      { refBase: gitId("tree", leaf), delta: delta(leaf, leaf.length, three.subarray(leaf.length)) }]);
    const paths = treeOf(readPack(bytes, limits, fail), commit).map(entry => `${entry.mode} ${entry.path}`);
    expect(paths).toEqual(["040000 a", "040000 a/one", "100644 a/one/SKILL.md", "040000 a/two", "100644 a/two/SKILL.md", "100755 a/two/tool.md", "040000 b", "100644 b/SKILL.md", "100644 b/z.md"]);
  });
  it("reads a pack written by git itself", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-pack-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args], { encoding: "buffer" });
      git("init", "-q");
      for (let i = 0; i < 6; i++) { fs.mkdirSync(path.join(dir, "skills", "s" + i), { recursive: true }); fs.writeFileSync(path.join(dir, "skills", "s" + i, "SKILL.md"), "skill " + i); }
      git("add", "-A"); git("commit", "-q", "-m", "synthetic");
      const commit = git("rev-parse", "HEAD").toString().trim();
      const ids = execFileSync("git", ["-C", dir, "rev-list", "--objects", "--filter=blob:none", "--filter-print-omitted", "HEAD"], { encoding: "utf8" })
        .split("\n").filter(line => /^[0-9a-f]{40}/.test(line)).map(line => line.slice(0, 40));
      const packBytes = execFileSync("git", ["-C", dir, "pack-objects", "--stdout", "-q"], { input: ids.join("\n") + "\n" });
      const entries = treeOf(readPack(packBytes, limits, fail), commit);
      expect(entries.filter(entry => entry.type === "blob").map(entry => entry.path).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `skills/s${i}/SKILL.md`));
      const expected = execFileSync("git", ["-C", dir, "ls-tree", "-r", "-t", "HEAD"], { encoding: "utf8" }).trim().split("\n").length;
      expect(entries).toHaveLength(expected);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ["symlink", "120000"], ["submodule", "160000"], ["group-writable file", "100664"],
  ])("rejects a %s entry", (_name, mode) => {
    const root = treeObject([{ mode, name: "x", sha: "d".repeat(40) }]), commitData = commitObject(gitId("tree", root));
    expect(() => treeOf(readPack(pack([{ type: "commit", data: commitData }, { type: "tree", data: root }]), limits, fail), gitId("commit", commitData))).toThrow("TREE_INVALID");
  });
  it("rejects a tree whose child tree is missing from the pack", () => {
    const root = treeObject([{ mode: "40000", name: "gone", sha: "d".repeat(40) }]), commitData = commitObject(gitId("tree", root));
    expect(() => treeOf(readPack(pack([{ type: "commit", data: commitData }, { type: "tree", data: root }]), limits, fail), gitId("commit", commitData))).toThrow("TREE_INVALID");
  });
  it.each([["an empty", ""], ["a slash-carrying", "skills/x.md"]])("rejects %s entry name", (_name, name) => {
    const root = treeObject([{ mode: "100644", name, sha: blob("x") }]), commitData = commitObject(gitId("tree", root));
    expect(() => treeOf(readPack(pack([{ type: "commit", data: commitData }, { type: "tree", data: root }]), limits, fail), gitId("commit", commitData))).toThrow("TREE_INVALID");
  });
  it("rejects a non-UTF-8 file name", () => {
    const root = Buffer.concat([Buffer.from("100644 "), Buffer.from([0xff, 0xfe]), Buffer.from([0]), Buffer.from("d".repeat(40), "hex")]);
    const commitData = commitObject(gitId("tree", root));
    expect(() => treeOf(readPack(pack([{ type: "commit", data: commitData }, { type: "tree", data: root }]), limits, fail), gitId("commit", commitData))).toThrow("TREE_INVALID");
  });
  it("bounds the number of tree entries", () => {
    const root = treeObject(Array.from({ length: 5 }, (_, i) => ({ mode: "100644", name: "f" + i, sha: blob(String(i)) }))), commitData = commitObject(gitId("tree", root));
    const objects = readPack(pack([{ type: "commit", data: commitData }, { type: "tree", data: root }]), limits, fail);
    expect(() => treeFromPack(objects, gitId("commit", commitData), 4, fail)).toThrow("LIMIT_EXCEEDED");
  });
});

describe("packfile integrity and limits", () => {
  const commitData = commitObject("e".repeat(40)), good = pack([{ type: "commit", data: commitData }]);
  it("rejects a corrupted trailer, header, version or truncated body", () => {
    const flipped = Buffer.from(good); flipped[20] ^= 1;
    expect(() => readPack(flipped, limits, fail)).toThrow("TREE_INVALID");
    const notPack = Buffer.from(good); notPack.write("JUNK", 0); expect(() => readPack(notPack, limits, fail)).toThrow("TREE_INVALID");
    const version = Buffer.from(good); version.writeUInt32BE(3, 4); expect(() => readPack(version, limits, fail)).toThrow("TREE_INVALID");
    expect(() => readPack(good.subarray(0, 20), limits, fail)).toThrow("TREE_INVALID");
  });
  it("rejects more objects than declared, fewer than declared, and too many objects", () => {
    const extra = pack([{ type: "commit", data: commitData }, { type: "blob", data: Buffer.from("x") }]);
    const lying = Buffer.from(extra.subarray(0, extra.length - 20)); lying.writeUInt32BE(1, 8);
    expect(() => readPack(Buffer.concat([lying, createHash("sha1").update(lying).digest()]), limits, fail)).toThrow("TREE_INVALID");
    const short = Buffer.from(good.subarray(0, good.length - 20)); short.writeUInt32BE(2, 8);
    expect(() => readPack(Buffer.concat([short, createHash("sha1").update(short).digest()]), limits, fail)).toThrow("TREE_INVALID");
    expect(() => readPack(extra, { ...limits, objects: 1 }, fail)).toThrow("LIMIT_EXCEEDED");
  });
  it("bounds inflated bytes including delta results", () => {
    expect(() => readPack(pack([{ type: "blob", data: Buffer.alloc(2048) }]), { ...limits, inflatedBytes: 1024 }, fail)).toThrow("LIMIT_EXCEEDED");
    const base = Buffer.alloc(600, 97);
    expect(() => readPack(pack([{ type: "blob", data: base }, { ofsBase: 0, delta: delta(base, 600, Buffer.alloc(100, 98)) }]), { ...limits, inflatedBytes: 1024 }, fail)).toThrow("LIMIT_EXCEEDED");
  });
  it("rejects an offset delta pointing before the pack or between objects, and a missing reference base", () => {
    const d = delta(Buffer.from("x"), 1, Buffer.from("y"));
    expect(() => readPack(pack([{ ofsDistance: 100, delta: d }]), limits, fail)).toThrow("TREE_INVALID");
    expect(() => readPack(pack([{ type: "blob", data: Buffer.from("x") }, { ofsDistance: 1, delta: d }]), limits, fail)).toThrow("TREE_INVALID");
    expect(() => readPack(pack([{ refBase: "f".repeat(40), delta: d }]), limits, fail)).toThrow("TREE_INVALID");
  });
  it.each([
    ["wrong base size", (base: Buffer) => Buffer.concat([Buffer.from([base.length + 1, 1]), Buffer.from([1, 0x41])])],
    ["copy past the base", (base: Buffer) => Buffer.from([base.length, 4, 0x80 | 0x01 | 0x10, 0, 4])],
    ["reserved opcode", (base: Buffer) => Buffer.from([base.length, 1, 0])],
    ["short result", (base: Buffer) => Buffer.from([base.length, 2, 1, 0x41])],
  ])("rejects a delta with %s", (_name, build) => {
    const base = Buffer.from("abc");
    expect(() => readPack(pack([{ type: "blob", data: base }, { ofsBase: 0, delta: build(base) }]), limits, fail)).toThrow("TREE_INVALID");
  });
});

describe("fetch response framing", () => {
  const packBytes = pack([{ type: "commit", data: commitObject("e".repeat(40)) }]);
  it("joins sideband 1 and skips progress", () => { expect(extractPack(fetchResponse(packBytes, "e".repeat(40)), 1 << 20, fail)).toEqual(packBytes); });
  it("rejects a sideband error, an unknown band, a missing flush and a server error line", () => {
    const head = Buffer.concat([pktLine("packfile\n")]);
    expect(() => extractPack(Buffer.concat([head, band(3, Buffer.from("fatal")), PKT_FLUSH]), 1 << 20, fail)).toThrow("NETWORK_FAILED");
    expect(() => extractPack(Buffer.concat([head, band(4, Buffer.from("?")), PKT_FLUSH]), 1 << 20, fail)).toThrow("NETWORK_FAILED");
    expect(() => extractPack(Buffer.concat([head, band(1, packBytes)]), 1 << 20, fail)).toThrow("NETWORK_FAILED");
    expect(() => extractPack(Buffer.concat([pktLine("ERR not our ref\n"), PKT_FLUSH]), 1 << 20, fail)).toThrow("NETWORK_FAILED");
  });
  it("bounds the joined pack size", () => { expect(() => extractPack(fetchResponse(packBytes, "e".repeat(40)), packBytes.length - 1, fail)).toThrow("LIMIT_EXCEEDED"); });
});
