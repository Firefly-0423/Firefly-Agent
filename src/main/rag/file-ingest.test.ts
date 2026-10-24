import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describePendingAttachment, ingestOneFile, processDocumentsForChat, ingestPaths, walkDir, isBinary,
  isTextExt, isUnsupportedExt, isImageExt, getMimeFromExt, SMALL_THRESHOLD } from "./file-ingest";

let folder: string;
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "ff-ingest-contract-")); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));
const file = (name: string) => join(folder, name);
function put(name: string, value: string | Buffer) {
  const filename = file(name);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, value);
  return filename;
}
const importer = () => vi.fn(async () => ({ importId: "garden-import", chunkCount: 4 }));
describe("attachment classification before and after reading", () => {
  it("detects null bytes but accepts ordinary or empty text buffers", () => {
    expect([Buffer.from("Plant notes"), Buffer.alloc(0), Buffer.from([0, 75, 76]), Buffer.alloc(12),
      Buffer.from([75, 0, 76])].map(isBinary)).toEqual([false, false, true, true, true]);
  });
  it("recognizes the supported extension sets and image MIME mapping", () => {
    expect([".txt", ".md", ".ts", ".py", ".json", ".svg", "", ".zip"].map(isTextExt)).toEqual([true, true, true, true, true, true, false, false]);
    expect([".zip", ".pdf", ".png", ".exe", ".txt", ".md", "", ".unlisted"].map(isUnsupportedExt)).toEqual([true, true, true, true, false, false, false, false]);
    expect([".png", ".JPG", ".webp"].map(isImageExt)).toEqual([true, true, true]);
    expect([".png", ".jpg", ".unlisted"].map(getMimeFromExt)).toEqual(["image/png", "image/jpeg", "application/octet-stream"]);
  });
  it("registers unread documents as pending without text or index payloads", () => {
    const description = describePendingAttachment(file("garden.md"));
    expect(description).toMatchObject({ name: "garden.md", kind: "document", filePath: file("garden.md"), status: "pending" });
    expect(description).not.toHaveProperty("text");
    expect(description).not.toHaveProperty("chunks");
    expect(describePendingAttachment(file("clipboard-note"), "text/plain")).toMatchObject({ name: "clipboard-note", kind: "document", status: "pending" });
  });
  it.each(["exe", "wav"])("rejects a pending %s attachment with the exact format reason", extension => {
    expect(describePendingAttachment(file(`garden.${extension}`))).toMatchObject({
      name: `garden.${extension}`, kind: "unsupported", reason: `暂不支持的文件格式 .${extension}`,
    });
  });
  it("describes images using extension MIME before supplied MIME and supports extensionless images", () => {
    const description = describePendingAttachment(file("garden view.png"));
    expect(description.kind).toBe("image");
    expect(description).toMatchObject({ mime: "image/png", status: "pending", previewUrl: expect.stringMatching(/^file:\/\//) });
    expect(describePendingAttachment(file("clipboard-garden"), "image/png"))
      .toMatchObject({ kind: "image", mime: "image/png", filePath: file("clipboard-garden") });
    expect(describePendingAttachment(file("garden.jpg"), "image/custom")).toMatchObject({ kind: "image", mime: "image/jpeg" });
  });
});
it.each([["short.md", "Fresh garden notes：薄荷🌿"], ["threshold.txt", "g".repeat(SMALL_THRESHOLD)], ["garden-readme", "No extension needed"]])(
  "returns text for %s without invoking the indexer", async (name, text) => {
    const index = importer();
    expect(await ingestOneFile(put(name, text), index)).toEqual({ name, kind: "text", text });
    expect(index).not.toHaveBeenCalled();
  });
it.each(["", " \t\n    "])("returns empty for blank content %j", async content => {
  const index = importer();
  expect(await ingestOneFile(put("blank.md", content), index)).toEqual({ name: "blank.md", kind: "empty" });
  expect(index).not.toHaveBeenCalled();
});
it("indexes text one character above the threshold and preserves the returned import identity", async () => {
  const index = importer(), text = "g".repeat(SMALL_THRESHOLD + 1);
  expect(await ingestOneFile(put("long-guide.md", text), index))
    .toEqual({ name: "long-guide.md", kind: "indexed", chunks: 4, importId: "garden-import" });
  expect(index).toHaveBeenCalledExactlyOnceWith(text, "long-guide.md");
});
it("uses a completed cache record without embedding the file again", async () => {
  const index = importer();
  const result = await ingestOneFile(put("cached-guide.md", "g".repeat(SMALL_THRESHOLD + 1)), {
    importDocument: index, getCachedImport: async () => ({ importId: "cached-garden", chunkCount: 8 }),
  });
  expect(result).toMatchObject({ name: "cached-guide.md", kind: "indexed", chunks: 8, importId: "cached-garden", cached: true });
  expect(index).not.toHaveBeenCalled();
});
it("attaches retrieved chunks to the successfully indexed turn document", async () => {
  const target = put("turn-guide.md", "g".repeat(SMALL_THRESHOLD + 1)), index = importer();
  const chunks = [{ text: "Watering day is Tuesday", score: 0.87, fileName: "turn-guide.md", chunkIndex: 0, importId: "garden-import" }];
  const search = vi.fn(async () => chunks);
  const result = await processDocumentsForChat([target], "When do I water?", index, search);
  expect(result[0]).toMatchObject({ name: "turn-guide.md", kind: "indexed", chunks: 4, importId: "garden-import", retrievedChunks: chunks });
  expect(search).toHaveBeenCalledWith("When do I water?", ["garden-import"]);
});
it("keeps an indexed import usable when its follow-up retrieval fails", async () => {
  const target = put("retrieval-guide.md", "g".repeat(SMALL_THRESHOLD + 1));
  const result = await processDocumentsForChat([target], "When do I water?", importer(), vi.fn().mockRejectedValue(new Error("garden retrieval offline")));
  expect(result[0]).toMatchObject({ kind: "indexed", chunks: 4, importId: "garden-import", reason: "garden retrieval offline" });
});
it("reports indexing failures as a zero-chunk indexed attachment", async () => {
  const result = await ingestOneFile(put("index-failure.md", "g".repeat(SMALL_THRESHOLD + 1)),
    vi.fn().mockRejectedValue(new Error("garden embedding offline")));
  expect(result.kind).toBe("indexed");
  if (result.kind === "indexed") { expect(result.chunks).toBe(0); expect(result.reason).toContain("garden embedding offline"); }
});
it("rejects archive, image and disguised binary content", async () => {
  const index = importer();
  const archive = await ingestOneFile(put("garden.zip", Buffer.alloc(90, 0x85)), index);
  expect(archive).toMatchObject({ kind: "unsupported", reason: "暂不支持的文件格式 .zip（MVP-0 仅支持文本）" });
  for (const [name, content] of [["garden.png", Buffer.alloc(90, 0x85)], ["binary-garden", Buffer.from([0, 81, 82])],
    ["binary.txt", Buffer.from([81, 0, 82])]] as const) {
    expect((await ingestOneFile(put(name, content), index)).kind).toBe("unsupported");
  }
});
it("reports a missing file as unsupported with ENOENT", async () => {
  const result = await ingestOneFile(file("absent-guide.md"), importer());
  expect(result.kind).toBe("unsupported");
  if (result.kind === "unsupported") expect(result.reason).toContain("ENOENT");
});
it("walks nested files, omits hidden entries and tolerates missing directories", () => {
  expect(walkDir(folder)).toEqual([]);
  put("garden.txt", "mint"); put("guide.md", "soil"); put("watering.ts", "schedule");
  put("beds/herbs.md", "basil"); put("beds/deep/seeds.txt", "seeds"); put(".private", "secret");
  expect(() => walkDir(folder)).not.toThrow();
  const paths = walkDir(folder).map(item => relative(folder, item).replace(/\\/g, "/"));
  expect(paths.sort()).toEqual(["beds/deep/seeds.txt", "beds/herbs.md", "garden.txt", "guide.md", "watering.ts"]);
  expect(paths).not.toContain(".private");
  expect(walkDir(file("absent-folder"))).toEqual([]);
});
it("ingests a single path once even if repeated", async () => {
  const target = put("one-guide.txt", "One guide");
  const result = await ingestPaths([target, target, target], importer());
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ kind: "text", name: "one-guide.txt" });
});
it("expands a directory with relative display names", async () => {
  put("garden.txt", "Small guide"); put("beds/herbs.md", "More herbs");
  const result = await ingestPaths([folder], importer());
  expect(result).toHaveLength(2);
  expect(result.map(item => item.name.replace(/\\/g, "/")).sort()).toEqual(["beds/herbs.md", "garden.txt"]);
});
it("deduplicates overlapping file and directory inputs while retaining binary rejections", async () => {
  const target = put("garden.txt", "Growing notes");
  put("beds/photo.png", Buffer.alloc(80, 0x89)); put("beds/water.js", "water()");
  const result = await ingestPaths([target, folder], importer());
  expect(result).toHaveLength(3);
  expect(result.filter(item => item.kind === "text")).toHaveLength(2);
  expect(result.filter(item => item.kind === "unsupported")).toHaveLength(1);
  expect(await ingestPaths([file("absent.txt"), file("absent-directory")], importer())).toHaveLength(0);
});
