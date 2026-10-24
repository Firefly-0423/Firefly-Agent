import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import * as filePromises from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { extractZip } from "./zip-extraction";
import { rejectZipSymlink } from "./zip-entry-policy";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
function fixtureRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-zip-contract-"));
  roots.push(root);
  return root;
}
async function archiveFile(root: string, entries: Array<{ name: string; text: string; mode?: number }>): Promise<string> {
  const archive = new JSZip();
  for (const entry of entries) archive.file(entry.name, entry.text, { unixPermissions: entry.mode, createFolders: false });
  const file = path.join(root, "input.zip");
  writeFileSync(file, await archive.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  return file;
}
function renameMember(file: string, from: string, to: string): void {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const content = readFileSync(file);
  let offset = content.indexOf(from);
  while (offset !== -1) {
    content.write(to, offset);
    offset = content.indexOf(from, offset + to.length);
  }
  writeFileSync(file, content);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("extracts normal nested UTF-8 files and preserves executable mode inputs", async () => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "目录/run.sh", text: "echo public", mode: 0o100755 }]);
  const dir = path.join(root, "output");
  await extractZip(archive, { dir, onEntry: rejectZipSymlink });
  expect(readFileSync(path.join(dir, "目录/run.sh"), "utf8")).toBe("echo public");
});

it("rejects GHSA-jmr9-qjv8-65gv symlink entries before creating outside targets", async () => {
  const root = fixtureRoot();
  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "original");
  const archive = await archiveFile(root, [{ name: "link", text: "../outside.txt", mode: 0o120777 }]);
  await expect(extractZip(archive, { dir: path.join(root, "output") })).rejects.toThrow("ZIP_SYMLINK_FORBIDDEN");
  expect(readFileSync(outside, "utf8")).toBe("original");
});

it("rejects GHSA-7pqw-9j4j-h8q3 same-name symlink then regular file", async () => {
  const root = fixtureRoot();
  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "original");
  const archive = await archiveFile(root, [
    { name: "link-a", text: "../outside.txt", mode: 0o120777 },
    { name: "link-b", text: "replacement", mode: 0o100644 },
  ]);
  renameMember(archive, "link-b", "link-a");
  await expect(extractZip(archive, { dir: path.join(root, "output") })).rejects.toThrow("ZIP_SYMLINK_FORBIDDEN");
  expect(readFileSync(outside, "utf8")).toBe("original");
});

it("rejects duplicate regular entries instead of replacing the earlier file", async () => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "same-a", text: "first" }, { name: "same-b", text: "second" }]);
  renameMember(archive, "same-b", "same-a");
  await expect(extractZip(archive, { dir: path.join(root, "output"), onEntry: rejectZipSymlink })).rejects.toThrow(/ZIP_DUPLICATE/);
});

it("preserves a nonempty destination without overwriting its existing file", async () => {
  const root = fixtureRoot();
  const dir = path.join(root, "output");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "keep.txt"), "original");
  const archive = await archiveFile(root, [{ name: "keep.txt", text: "replacement" }]);
  await expect(extractZip(archive, { dir, onEntry: rejectZipSymlink })).rejects.toThrow(/ZIP_DESTINATION/);
  expect(readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("original");
});

it("cleans staged output on validation failure and leaves the empty destination retryable", async () => {
  const root = fixtureRoot();
  const dir = path.join(root, "output");
  mkdirSync(dir);
  const archive = await archiveFile(root, [{ name: "valid.txt", text: "public" }, { name: "late.txt", text: "public" }]);
  await expect(extractZip(archive, { dir, onEntry(entry) { if (entry.fileName === "late.txt") throw new Error("POLICY_REJECTED"); } })).rejects.toThrow("POLICY_REJECTED");
  expect(readdirSync(dir)).toEqual([]);
  expect(readdirSync(root).sort()).toEqual(["input.zip", "output"]);
});

it("rejects an existing directory junction as the extraction destination", async () => {
  const root = fixtureRoot();
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const dir = path.join(root, "output");
  symlinkSync(outside, dir, "junction");
  const archive = await archiveFile(root, [{ name: "created.txt", text: "public" }]);
  await expect(extractZip(archive, { dir, onEntry: rejectZipSymlink })).rejects.toThrow(/ZIP_DESTINATION/);
  expect(existsSync(path.join(outside, "created.txt"))).toBe(false);
});

it.each(["../bad", "/rootx", "C:/bad", "bad\0xx", "CON.txt", "x:stream", "dir./bad"])("rejects unsafe archive member %j without output", async (name) => {
  const root = fixtureRoot();
  const placeholder = "z".repeat(Buffer.byteLength(name));
  const archive = await archiveFile(root, [{ name: placeholder, text: "public" }]);
  renameMember(archive, placeholder, name);
  const dir = path.join(root, "output");
  await expect(extractZip(archive, { dir })).rejects.toThrow();
  expect(existsSync(dir)).toBe(false);
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it.each([
  { entries: [{ name: "folder", text: "file" }, { name: "folder/child", text: "child" }] },
  { entries: [{ name: "folder/child", text: "child" }, { name: "folder", text: "file" }] },
])("rejects file/directory conflicts in either order", async ({ entries }) => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, entries);
  await expect(extractZip(archive, { dir: path.join(root, "output") })).rejects.toThrow("ZIP_PATH_TYPE_CONFLICT");
});

it.each([
  { entries: 1 }, { archiveBytes: 1 }, { entryBytes: 2 }, { expandedBytes: 5 }, { metadataBytes: 2 },
])("enforces archive and output limits %j", async (limits) => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "first", text: "1234" }, { name: "second", text: "5678" }]);
  const dir = path.join(root, "output");
  await expect(extractZip(archive, { dir, limits })).rejects.toThrow(/ZIP_.*LIMIT/);
  expect(existsSync(dir)).toBe(false);
});

it("preserves files arriving in the destination during validation", async () => {
  const root = fixtureRoot();
  const dir = path.join(root, "output");
  mkdirSync(dir);
  const archive = await archiveFile(root, [{ name: "new.txt", text: "new" }]);
  await expect(extractZip(archive, { dir, onEntry() { writeFileSync(path.join(dir, "user.txt"), "user change"); } })).rejects.toThrow("ZIP_DESTINATION");
  expect(readdirSync(dir)).toEqual(["user.txt"]);
  expect(readFileSync(path.join(dir, "user.txt"), "utf8")).toBe("user change");
  expect(readdirSync(root).sort()).toEqual(["input.zip", "output"]);
});

it("rejects mismatched declared output sizes and cleans staging", async () => {
  const root = fixtureRoot();
  const archive = new JSZip();
  archive.file("bad.txt", "public payload", { compression: "DEFLATE" });
  const bytes = await archive.generateAsync({ type: "nodebuffer" });
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(1, central + 24);
  const file = path.join(root, "input.zip");
  writeFileSync(file, bytes);
  const dir = path.join(root, "output");
  await expect(extractZip(file, { dir })).rejects.toThrow();
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it("extracts a normal multi-directory archive into a temporary directory", async () => {
  const root = fixtureRoot();
  const dir = path.join(root, "skills");
  const archive = await archiveFile(root, [
    { name: "pdf/SKILL.md", text: "pdf" },
    { name: "skill-creator/SKILL.md", text: "skill-creator" },
  ]);
  await extractZip(archive, { dir });
  expect(readFileSync(path.join(dir, "pdf/SKILL.md"), "utf8")).toContain("pdf");
  expect(readFileSync(path.join(dir, "skill-creator/SKILL.md"), "utf8")).toContain("skill-creator");
});

it.each(["x".repeat(1025), `${"d/".repeat(64)}file`])("bounds path metadata before building directory prefixes", async (name) => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name, text: "public" }]);
  await expect(extractZip(archive, { dir: path.join(root, "output") })).rejects.toThrow("ZIP_PATH_LIMIT");
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it("accepts DOS directory attributes without a trailing slash", async () => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "folder", text: "" }, { name: "folder/readme.txt", text: "public" }]);
  const bytes = readFileSync(archive);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt16LE(20, central + 4);
  bytes.writeUInt32LE(16, central + 38);
  writeFileSync(archive, bytes);
  const dir = path.join(root, "output");
  await extractZip(archive, { dir });
  expect(readFileSync(path.join(dir, "folder/readme.txt"), "utf8")).toBe("public");
});

async function failArchiveClose(): Promise<void> {
  const { open: originalOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(filePromises.open).mockImplementationOnce(async (...args) => {
    const handle = await originalOpen(...args);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      throw new Error("ARCHIVE_CLOSE_EIO");
    };
    return handle;
  });
}

it("does not publish files when closing the archive fails", async () => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "public.txt", text: "public" }]);
  await failArchiveClose();
  const dir = path.join(root, "output");
  await expect(extractZip(archive, { dir })).rejects.toThrow("ARCHIVE_CLOSE_EIO");
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it("settles with both errors when malformed metadata is followed by close failure", async () => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "public.txt", text: "public" }]);
  const bytes = readFileSync(archive);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(0, central);
  writeFileSync(archive, bytes);
  await failArchiveClose();
  const result = await extractZip(archive, { dir: path.join(root, "output") }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors.map((error: Error) => error.message)).toEqual([
    expect.stringMatching(/central directory/), "ARCHIVE_CLOSE_EIO",
  ]);
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it("preserves existing directory-alias behavior without allowing file collisions", async () => {
  const root = fixtureRoot();
  const archive = await archiveFile(root, [{ name: "Folder/first.txt", text: "first" }, { name: "folder/second.txt", text: "second" }]);
  const dir = path.join(root, "output");
  await extractZip(archive, { dir });
  expect(readFileSync(path.join(dir, "Folder/first.txt"), "utf8")).toBe("first");
  expect(readFileSync(path.join(dir, "folder/second.txt"), "utf8")).toBe("second");
  const conflicting = await archiveFile(root, [{ name: "Folder/name.txt", text: "first" }, { name: "folder/NAME.txt", text: "second" }]);
  await expect(extractZip(conflicting, { dir: path.join(root, "other") })).rejects.toThrow("ZIP_DUPLICATE_PATH");
});

it("rejects excessive compression before creating output", async () => {
  const root = fixtureRoot();
  const archive = new JSZip();
  archive.file("compressed.bin", Buffer.alloc(2 * 1024 * 1024), { compression: "DEFLATE" });
  const file = path.join(root, "input.zip");
  writeFileSync(file, await archive.generateAsync({ type: "nodebuffer" }));
  await expect(extractZip(file, { dir: path.join(root, "output") })).rejects.toThrow("ZIP_COMPRESSION_RATIO_LIMIT");
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it("rejects encrypted entries before creating output", async () => {
  const root = fixtureRoot();
  const input = new JSZip();
  input.file("secret.txt", "public", { compression: "DEFLATE" });
  const archive = path.join(root, "input.zip");
  const bytes = await input.generateAsync({ type: "nodebuffer" });
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
  writeFileSync(archive, bytes);
  await expect(extractZip(archive, { dir: path.join(root, "output") })).rejects.toThrow("ZIP_ENCRYPTED_FORBIDDEN");
  expect(readdirSync(root)).toEqual(["input.zip"]);
});

it("counts raw names hidden by Unicode Path extra fields against the metadata budget", async () => {
  const root = fixtureRoot();
  const archive = new JSZip();
  archive.file("é", "");
  const file = path.join(root, "input.zip");
  writeFileSync(file, await archive.generateAsync({ type: "nodebuffer", encodeFileName: (name) => name ? "r".repeat(4096) : "" }));
  await expect(extractZip(file, { dir: path.join(root, "output"), limits: { metadataBytes: 1024 } })).rejects.toThrow("ZIP_METADATA_LIMIT");
  expect(readdirSync(root)).toEqual(["input.zip"]);
});
