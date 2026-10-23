import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { findDefaultDialogCalls } from "./default-dialogs-scanner";

test.each(["ts", "js", "tsx", "jsx"])("finds global dialog calls in %s with source locations", (extension) => {
  const filename = "dialog-example." + extension;
  const program = "alert('notice'); window.confirm('decision'); service.confirm({});\nconfirm('again');";
  expect(findDefaultDialogCalls(filename, program)).toStrictEqual([
    filename + ":1", filename + ":1", filename + ":2",
  ]);
});

test("production renderer files contain no native browser dialogs", () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const visit = (directory: string): string[] => {
    const results: string[] = [];
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, item.name);
      if (item.isDirectory()) results.push(...visit(absolute));
      else if (/\.[jt]sx?$/.test(item.name) && !/\.(test|spec)\.[jt]sx?$/.test(item.name)) {
        results.push(...findDefaultDialogCalls(relative(root, absolute), readFileSync(absolute, "utf8")));
      }
    }
    return results;
  };
  expect(visit(root)).toStrictEqual([]);
});
