import { it, describe, expect } from "vitest";
import { containsFiles, arrayBufferToBase64 } from "./attachment-utils";

describe("Composer data-transfer primitives", () => {
  it("encodes empty, textual and binary buffers without dropping bytes", () => {
    expect(arrayBufferToBase64(new Uint8Array().buffer)).toEqual("");
    expect(arrayBufferToBase64(new TextEncoder().encode("Firefly").buffer)).toEqual("RmlyZWZseQ==");
    expect(arrayBufferToBase64(Uint8Array.of(0, 255, 128, 1).buffer)).toEqual("AP+AAQ==");
    const large = Uint8Array.from({ length: 32771 }, (_, n) => n % 256);
    expect(arrayBufferToBase64(large.buffer)).toEqual(Buffer.from(large).toString("base64"));
  });
  it.each([
    [["Files", "text/uri-list"], true],
    [["text/uri-list", "Files"], true],
    [["text/plain"], false],
    [[], false],
    [["files"], false],
  ] as const)("recognizes the case-sensitive file transfer token in %j", (types, present) => {
    expect(containsFiles({ types: [...types] })).toEqual(present);
  });
});
