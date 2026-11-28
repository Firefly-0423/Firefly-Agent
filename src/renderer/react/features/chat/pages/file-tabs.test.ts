import { expect, it, vi } from "vitest";
import { openFilePreview } from "./file-tabs";

it("adds once, updates line navigation, and clears it when no line is requested", () => {
  const nextSequence = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2);
  const first = openFilePreview([], "src/a.ts", 12, nextSequence);
  expect(first).toEqual([{ id: "file:src/a.ts", relPath: "src/a.ts", line: 12, lineSeq: 1 }]);
  const second = openFilePreview(first, "src/a.ts", 30, nextSequence);
  expect(second).toEqual([{ id: "file:src/a.ts", relPath: "src/a.ts", line: 30, lineSeq: 2 }]);
  expect(openFilePreview(second, "src/a.ts", undefined, nextSequence)[0]).toMatchObject({ line: undefined, lineSeq: undefined });
  expect(nextSequence).toHaveBeenCalledTimes(2);
});
