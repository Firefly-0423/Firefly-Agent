import { expect, test } from "vitest";
import { parseFileLinkHref, relativePathInsideWorkspace } from "./file-link";

test.each([
  ["file:///D:/Studio/lib/start.ts#L7-L19", { absPath: "D:/Studio/lib/start.ts", lineStart: 7, lineEnd: 19 }],
  ["file:///D:/Studio/lib/start.ts#L23", { absPath: "D:/Studio/lib/start.ts", lineStart: 23, lineEnd: 23 }],
  ["file:///D:/Studio/lib/start.ts", { absPath: "D:/Studio/lib/start.ts" }],
  ["file:///D:/Studio/lib/start.ts#overview", { absPath: "D:/Studio/lib/start.ts" }],
  ["file:///D:/Studio/lib/start.ts#l23", { absPath: "D:/Studio/lib/start.ts" }],
  ["file:///D:%5CStudio%5Clib%5Cstart.ts", { absPath: "D:/Studio/lib/start.ts" }],
  ["file:///D:/%E8%AE%B0%E5%BD%95%20one.md", { absPath: "D:/记录 one.md" }],
  ["file:///D:/Studio/%E1%ZZ.md", { absPath: "D:/Studio/%E1%ZZ.md" }],
  ["https://docs.invalid/start.ts", null],
])("decodes file references without inventing line locations: %s", (href, expected) => {
  expect(parseFileLinkHref(href)).toStrictEqual(expected);
});

test.each([
  ["D:/Studio/lib/start.ts", "D:\\Studio", "lib/start.ts"],
  ["d:/studio/Assets/Icon.svg", "D:\\Studio", "Assets/Icon.svg"],
  ["D:\\Studio\\lib\\start.ts", "D:\\Studio", "lib/start.ts"],
  ["C:/Elsewhere/note.md", "D:\\Studio", null],
  ["D:/Studio-backup/note.md", "D:\\Studio", null],
  ["D:/Studio", "D:\\Studio", "."],
  ["D:/Studio/note.md", "", null],
])("resolves %s against %s using directory boundaries", (path, root, expected) => {
  expect(relativePathInsideWorkspace(path, root)).toBe(expected);
});
