import { describe, expect, it } from "vitest";
import { rejectZipSymlink } from "./zip-entry-policy";

function attributes(mode: number): { externalFileAttributes: number } {
  return { externalFileAttributes: (mode << 16) >>> 0 };
}

describe("rejectZipSymlink", () => {
  it("throws the stable error code for a symlink entry", () => {
    expect(() => rejectZipSymlink(attributes(0o120777))).toThrow("ZIP_SYMLINK_FORBIDDEN");
    expect(() => rejectZipSymlink(attributes(0o120000))).toThrow(new Error("ZIP_SYMLINK_FORBIDDEN"));
  });

  it("rejects symlink entries regardless of the permission bits", () => {
    for (const permissions of [0o000, 0o644, 0o755, 0o777]) {
      expect(() => rejectZipSymlink(attributes(0o120000 | permissions))).toThrow("ZIP_SYMLINK_FORBIDDEN");
    }
  });

  it.each([
    ["regular file", 0o100644],
    ["executable file", 0o100755],
    ["directory", 0o040755],
    ["FIFO", 0o010644],
    ["socket", 0o140755],
    ["zero mode", 0],
  ])("allows a %s entry", (_label, mode) => {
    expect(() => rejectZipSymlink(attributes(mode))).not.toThrow();
  });

  it("allows DOS attributes stored in the low 16 bits", () => {
    expect(() => rejectZipSymlink({ externalFileAttributes: 0x20 })).not.toThrow();
    expect(() => rejectZipSymlink({ externalFileAttributes: 0x10 })).not.toThrow();
  });

  it("returns undefined for allowed entries", () => {
    expect(rejectZipSymlink(attributes(0o100644))).toBeUndefined();
  });
});
