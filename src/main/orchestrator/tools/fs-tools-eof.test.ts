import { it, describe, beforeAll, afterEach, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { toolRegistry } from "./registry/tool-registry";

let directory: string;
beforeAll(async () => { await import("./fs-tools"); });
afterEach(() => {
  const target = resolve(directory);
  if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true, force: true });
});
describe("large text files report their true end", () => {
  it("counts all ten thousand lines and exposes the final page beyond the former byte cutoff", async () => {
    directory = mkdtempSync(join(tmpdir(), "text-end-contract-73-"));
    const filename = join(directory, "observations.txt");
    const entries = Array.from({ length: 10_000 }, (_, index) => `observation-${index} ${"r".repeat(90)}`);
    writeFileSync(filename, entries.join("\n"));
    const reader = toolRegistry.getById("read_file");
    expect(reader).toBeDefined();
    const first = JSON.parse(await reader!.execute({ path: filename, startLine: 1, maxLines: 10 }));
    expect(first.totalLines).toBe(10_000);
    expect(first.truncated).toBe(false);
    const last = JSON.parse(await reader!.execute({ path: filename, startLine: 9995, maxLines: 10 }));
    expect(last.endLine).toBe(10_000);
    expect(last.content).toContain("observation-9999");
  });
  it("rejects an eleven-megabyte file with honest search guidance", async () => {
    directory = mkdtempSync(join(tmpdir(), "text-size-contract-73-"));
    const filename = join(directory, "oversized.txt");
    writeFileSync(filename, Buffer.alloc(11 * 1024 * 1024, 114));
    const result = JSON.parse(await toolRegistry.getById("read_file")!.execute({ path: filename }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("FILE_TOO_LARGE");
    expect(result.error).toContain("暂不支持");
    expect(result.error).toContain("search_text");
  });
});
