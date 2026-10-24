import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectWorkReadFile, isWorkReadScopeCurrent, WORK_READ_MAX_BYTES } from "./work-read-scope";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-read-scope-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Work read preflight", () => {
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
