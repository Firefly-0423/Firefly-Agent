import { expect, it } from "vitest";
import { preserveTextLineEndings } from "./workspace-editor-line-endings";
it.each([
  ["first\r\nsecond\nthird\r\n", "first\nupdated\nthird\n", "first\r\nupdated\nthird\r\n"],
  ["first\r\nsecond\nthird\r\n", "first\nsecond\ninserted\nthird\n", "first\r\nsecond\ninserted\r\nthird\r\n"],
  ["first\r\nsecond\nthird\r\n", "first\nthird\n", "first\r\nthird\r\n"],
  ["first\r\nsecond\nthird\r\n", "first\nsecond\nthird\n", "first\r\nsecond\nthird\r\n"],
  ["old\rline\r", "old\nnew\nline\n", "old\rnew\rline\r"],
  ["", "new\nline\n", "new\nline\n"],
])("preserves unchanged raw boundaries while applying the textarea edit (%j)", (before, normalized, expected) => {
  expect(preserveTextLineEndings(before, normalized)).toBe(expected);
});
