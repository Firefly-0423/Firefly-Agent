import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectWorkReadDocument, inspectWorkReadFile, isWorkReadScopeCurrent, WORK_READ_MAX_BYTES } from "./work-read-scope";

async function docx(lines: string[]): Promise<Buffer> {
  const JSZip = require("jszip"), archive = new JSZip();
  const body = lines.map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("");
  archive.file("word/document.xml", `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`);
  return archive.generateAsync({ type: "nodebuffer" });
}

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-read-scope-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Work read preflight", () => {
  it("counts the extracted lines of a Word document and binds its bytes", async () => {
    const selected = path.join(directory, "报告.docx");
    fs.writeFileSync(selected, await docx(["第一段", "第二段", "第三段"]));
    expect(() => inspectWorkReadFile(selected)).toThrow("WORK_READ_SCOPE_NEEDS_EXTRACTION");
    const scope = await inspectWorkReadDocument(selected);
    expect(scope).toMatchObject({ name: "报告.docx", totalLines: 3, endLine: 3, partialAccepted: false });
    expect(isWorkReadScopeCurrent(scope)).toBe(true);
    fs.writeFileSync(selected, await docx(["第一段", "改过"]));
    expect(isWorkReadScopeCurrent(scope)).toBe(false);
  });

  it("explains unreadable documents before the run starts", async () => {
    const damaged = path.join(directory, "damaged.pdf"), legacy = path.join(directory, "old.doc"), text = path.join(directory, "plain.md");
    fs.writeFileSync(damaged, "not a pdf");
    fs.writeFileSync(legacy, "x");
    fs.writeFileSync(text, "a\nb");
    await expect(inspectWorkReadDocument(damaged)).rejects.toThrow("可能已损坏");
    await expect(inspectWorkReadDocument(legacy)).rejects.toThrow("另存为 .docx");
    expect(await inspectWorkReadDocument(text)).toMatchObject({ totalLines: 2 });
  });

  it("binds actual file identity, content version and complete line range", () => {
    const selected = path.join(directory, "public.txt");
    fs.writeFileSync(selected, "one\ntwo\nthree");
    const scope = inspectWorkReadFile(selected);
    expect(scope).toMatchObject({ name: "public.txt", totalLines: 3, endLine: 3, partialAccepted: false });
    expect(isWorkReadScopeCurrent(scope)).toBe(true);
    fs.writeFileSync(selected, "one\ntwo\nchanged");
    expect(isWorkReadScopeCurrent(scope)).toBe(false);
  });

  it("does not pretend oversized or binary files have a readable range", () => {
    const selected = path.join(directory, "public.txt");
    fs.writeFileSync(selected, Buffer.alloc(WORK_READ_MAX_BYTES + 1, 65));
    expect(() => inspectWorkReadFile(selected)).toThrow("10MB");
    fs.writeFileSync(selected, Buffer.alloc(4096));
    expect(() => inspectWorkReadFile(selected)).toThrow("不是可读取的文本");
  });
});
