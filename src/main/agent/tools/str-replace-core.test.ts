import { expect, it, describe } from "vitest";
import { applyStrReplaceEdits, type StrReplaceEdit } from "./str-replace-core";

const edit = (old_string: string, new_string: string): StrReplaceEdit => ({ old_string, new_string });
function success(input: string, edits: StrReplaceEdit[]) {
  const result = applyStrReplaceEdits(input, edits);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}
function failure(input: string, edits: StrReplaceEdit[]) {
  const result = applyStrReplaceEdits(input, edits);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected replacement refusal");
  return result;
}

describe("replacement batches and empty-file initialization", () => {
  it("seeds an empty file and reports its complete added segment", () => {
    const result = success("", [edit("", "# Field journal\n\nFirst observation.")]);
    expect(result.newContent).toBe("# Field journal\n\nFirst observation.");
    expect(result.appliedEdits).toBe(1);
    expect(result.segments).toEqual([{ beforeLines: [], afterLines: ["# Field journal", "", "First observation."] }]);
  });
  it("runs subsequent edits against freshly seeded content", () => {
    const result = success("", [edit("", "north\ncentre\nsouth"), edit("centre", "middle")]);
    expect(result.newContent).toEqual("north\nmiddle\nsouth");
    expect(result.appliedEdits).toBe(2);
  });
  it("applies disjoint edits in order and reports both segments", () => {
    const result = success("red=7\ngreen=8\nblue=9\n", [edit("red=7", "red=70"), edit("blue=9", "blue=90")]);
    expect(result.newContent).toEqual("red=70\ngreen=8\nblue=90\n");
    expect(result.appliedEdits).toBe(2);
    expect(result.segments).toHaveLength(2);
  });
  it("lets a later edit match text inserted by an earlier edit", () => {
    expect(success("heading: Night\n", [edit("heading: Night", "heading: Night sky"), edit("Night sky", "Clear sky")]).newContent)
      .toEqual("heading: Clear sky\n");
  });
  it.each([
    [[edit("green=8", "green=80"), edit("missing=0", "missing=1")], "OLD_STRING_NOT_FOUND"],
    [[edit("green=8", "green=80"), edit("red=7", "red=70")], "MULTIPLE_MATCHES"],
  ] as const)("reports the failing batch index for %j", (edits, code) => {
    const result = failure("red=7\ngreen=8\nred=7\n", [...edits]);
    expect(result.errorCode).toBe(code);
    expect(result.diagnostic?.editIndex).toBe(1);
  });
  it("refuses an empty edit list", () => {
    expect(failure("existing record", [])).toMatchObject({ errorCode: "INVALID_INPUT", error: "edits 不能为空数组" });
  });
  it("does not treat an empty search string as permission to overwrite a populated file", () => {
    const result = failure("existing record", [edit("", "replacement")]);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(result.error).toContain("文件为空时可传空 old_string");
  });
});

describe("exact and line-ending-aware replacements", () => {
  it("replaces one literal occurrence without whitespace normalization", () => {
    const result = success("let north = 7;\nlet centre = 8;\nlet south = 9;", [edit("let centre = 8;", "let centre = 73;")]);
    expect(result.newContent).toEqual("let north = 7;\nlet centre = 73;\nlet south = 9;");
    expect(result.whitespaceNormalized).toBe(false);
    expect(result.appliedEdits).toBe(1);
  });
  it("replaces a complete multiline declaration", () => {
    const result = success("function measure() {\n  return 7;\n}\n\nfunction display() {\n  return 8;\n}", [
      edit("function measure() {\n  return 7;\n}", "function measure() {\n  return 73;\n}"),
    ]);
    expect(result.newContent).toContain("return 73;");
  });
  it("matches LF input against CRLF text and retains the file line endings", () => {
    const result = success("function observe() {\r\n  const draft = 7;\r\n  return draft;\r\n}\r\n", [
      edit("  const draft = 7;\n  return draft;", "  const final = 7;\n  return final;"),
    ]);
    expect(result.eolNormalized).toBe(true);
    expect(result.newContent).toEqual("function observe() {\r\n  const final = 7;\r\n  return final;\r\n}\r\n");
  });
  it("reports the ordered locations of duplicate literal matches", () => {
    const result = failure("red=7\ngreen=8\nred=7\nblue=9", [edit("red=7", "red=73")]);
    expect(result.errorCode).toBe("MULTIPLE_MATCHES");
    expect(result.error).toContain("匹配 2 处");
    expect(result.diagnostic).toMatchObject({ kind: "multiple_matches", matchCount: 2 });
    expect(result.diagnostic?.positions?.map(value => value.line)).toEqual([1, 3]);
  });
  it("reports not-found diagnostics after all normalization attempts", () => {
    const result = failure("north=7\ncentre=8\nsouth=9", [edit("missing-token-73", "replacement")]);
    expect(result.errorCode).toBe("OLD_STRING_NOT_FOUND");
    expect(result.error).toContain("空白/缩进归一化");
    expect(result.diagnostic).toMatchObject({ kind: "not_found", oldStringLength: 16, fileEol: "LF" });
  });
});

describe("whitespace-tolerant matching and indentation", () => {
  it.each([
    ["function observe() {\n    return 7;\n}\n", "      return 7;", "return 73;", "function observe() {\n    return 73;\n}\n"],
    ["inventory:\n  - telescope\n  - camera\n", "- telescope\n- camera", "- telescope-new\n- camera-new", "inventory:\n  - telescope-new\n  - camera-new\n"],
    ["inventory:\n- telescope\n", "  - telescope", "  - telescope-new", "inventory:\n- telescope-new\n"],
    ["chapter:\n    prior record\n", "      prior record", "      prior record\n      NEXT: observation", "chapter:\n    prior record\n    NEXT: observation\n"],
    ["function observe() {\r\n    return 7;\r\n}\r\n", "      return 7;", "return 73;", "function observe() {\r\n    return 73;\r\n}\r\n"],
  ])("aligns replacement indentation for %j", (input, old, replacement, expected) => {
    const result = success(input, [edit(old, replacement)]);
    expect(result.newContent).toEqual(expected);
    expect(result.whitespaceNormalized).toBe(true);
  });
  it("tolerates repeated whitespace within a line", () => {
    const result = success("const  camera   = {\n  active: true,\n};\n", [edit("const camera = {", "const telescope = {")]);
    expect(result.whitespaceNormalized).toBe(true);
    expect(result.newContent).toContain("const telescope = {");
  });
  it("refuses duplicate matches discovered only after normalization", () => {
    const result = failure("if (north) {\n    return 7;\n}\nif (south) {\n    return 7;\n}\n", [edit("      return 7;", "return 73;")]);
    expect(result.errorCode).toBe("MULTIPLE_MATCHES");
    expect(result.error).toContain("空白归一化");
    expect(result.diagnostic?.matchCount).toBe(2);
  });
});
