import { it, describe, expect } from "vitest";
import { checkOverwriteDrop, overwriteDropMessage, OVERWRITE_DROP_MIN_LINES, OVERWRITE_DROP_RATIO } from "./overwrite-guard";

const document = (size: number, separator = "\n") => Array.from({ length: size }, (_, n) => `record-${n + 73}`).join(separator);
describe("whole-file shrink protection", () => {
  it("publishes the fifty-line and one-half thresholds", () => {
    expect([OVERWRITE_DROP_MIN_LINES, OVERWRITE_DROP_RATIO]).toEqual([50, 0.5]);
  });
  it("reports both line counts and the exact shrink ratio on rejection", () => {
    expect(checkOverwriteDrop(document(100), document(20))).toEqual({ blocked: true, oldLineCount: 100, newLineCount: 20, ratio: 0.2 });
  });
  it.each([60, 50])("allows %s remaining lines out of one hundred", (size) => {
    expect(checkOverwriteDrop(document(100), document(size)).blocked).toBe(false);
  });
  it.each([10, 49])("allows small-file compression from %s lines to one", (size) => {
    expect(checkOverwriteDrop(document(size), "condensed record").blocked).toBe(false);
  });
  it("rejects severe shrinkage at exactly fifty original lines", () => {
    expect(checkOverwriteDrop(document(50), "condensed record").blocked).toBe(true);
  });
  it("uses a ratio of one for an empty original file", () => {
    const result = checkOverwriteDrop("", "new record");
    expect(result.blocked).toBe(false);
    expect(result.ratio).toBe(1);
  });
  it("counts CRLF files identically to LF files", () => {
    const result = checkOverwriteDrop(document(60, "\r\n"), document(10));
    expect(result.oldLineCount).toBe(60);
    expect(result.blocked).toBe(true);
    expect(result).toEqual(checkOverwriteDrop(document(60), document(10)));
  });
  it("explains the measured drop and the permitted recovery paths verbatim", () => {
    expect(overwriteDropMessage(checkOverwriteDrop(document(120), document(30)))).toEqual(
      "覆盖写被拒绝：原文件 120 行，新内容仅 30 行（25%），疑似模型输出被截断。\n" +
      "如需局部修改请改用 str_replace（内容锚点替换）；确需整文件重写请用 str_replace（old_string = 原文件全文）或请求用户协助，不要直接覆盖。",
    );
  });
});
