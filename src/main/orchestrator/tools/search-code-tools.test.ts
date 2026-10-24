import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import type { ToolDefinition } from "./registry/tool-registry";

const catalog = vi.hoisted(() => ({ registered: [] as ToolDefinition[] }));
vi.mock("./registry/tool-registry", () => ({ toolRegistry: {
  register: (entry: ToolDefinition) => catalog.registered.push(entry), getById: vi.fn(), getEnabledTools: () => [],
} }));
import { registerSearchCodeTool } from "./search-code-tools";
let directory: string;
const put = (name: string, text: string) => { const target = join(directory, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); };
const search = async (args: Record<string, unknown>, signal?: AbortSignal) => JSON.parse(await catalog.registered[0].execute(args, { userQuery: "Locate observation", signal }));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "search-contract-73-"));
  catalog.registered.length = 0;
  registerSearchCodeTool();
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});
afterEach(() => {
  vi.restoreAllMocks();
  const target = resolve(directory);
  if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true, force: true });
});

describe("registered text-search behavior", () => {
  it("publishes read-only and concurrency-safe metadata", () => {
    expect(catalog.registered).toHaveLength(1);
    const entry = catalog.registered[0];
    expect(entry).toMatchObject({ id: "search_code", effectKind: "read", verificationPolicy: "none", needsContext: true });
    expect(entry.isConcurrencySafe?.({ query: "observation" })).toBe(true);
  });
  it("returns both literal matches with honest result counts", async () => {
    put("observations.ts", "let telescope = 7;\nlet camera = 8;\nlet telescope = 9;");
    const result = await search({ query: "telescope", paths: ["."] });
    expect(result.matches).toHaveLength(2);
    expect(result).toMatchObject({ totalMatches: 2, returnedMatches: 2, truncated: false });
    expect(result.matches.map((match: { line: number }) => match.line)).toEqual([1, 3]);
  });
  it("reports an empty query and rejects invalid regex syntax without matches", async () => {
    const empty = await search({ query: "" });
    expect(empty.error).toContain("query 不能为空");
    expect(empty.matches).toEqual([]);
    put("observations.ts", "let telescope = 73;");
    const invalid = await search({ query: "[broken-pattern", mode: "regex" });
    expect(invalid.matches).toEqual([]);
    expect(invalid.totalMatches).toBe(0);
  });
  it("limits results to five even when many lines match", async () => {
    put("observations.txt", Array.from({ length: 12 }, (_, n) => "observation " + n).join("\n"));
    const result = await search({ query: "observation", maxMatches: 5 });
    expect(result.matches.length).toBeLessThanOrEqual(5);
    expect(result.matches).toHaveLength(5);
  });
  it("limits surrounding context on each match to one line", async () => {
    put("observations.txt", "heading\nbefore\nobservation\nafter\nfooter");
    const result = await search({ query: "observation", contextLines: 1 });
    expect(result.matches).toHaveLength(1);
    for (const match of result.matches) {
      expect(match.before.length).toBeLessThanOrEqual(1);
      expect(match.after.length).toBeLessThanOrEqual(1);
    }
    expect(result.matches[0]).toMatchObject({ before: ["before"], after: ["after"] });
  });
  it("accepts file filters through the public tool rather than a test-local glob implementation", async () => {
    put("observations.ts", "observation");
    expect(await search({ query: "observation", fileGlobs: ["*.ts"] })).toHaveProperty("matches");
    expect((await search({ query: "observation", fileGlobs: ["*.js"] })).matches).toEqual([]);
  });
  it("honors case-sensitive search", async () => {
    put("observations.txt", "Observation\nobservation");
    const result = await search({ query: "Observation", caseSensitive: true });
    expect(result).toHaveProperty("matches");
    expect(result.matches.map((entry: { line: number }) => entry.line)).toEqual([1]);
  });
  it("returns an empty match list when the caller has already cancelled", async () => {
    put("observations.txt", "observation");
    const controller = new AbortController();
    controller.abort();
    const result = await search({ query: "observation" }, controller.signal);
    expect(result).toHaveProperty("matches");
    expect(result.matches).toEqual([]);
  });
  it("excludes mirror worktrees while retaining matches in current workspace files", async () => {
    put("src/observations.ts", "const currentObservation = 73;");
    put(".worktrees/previous/src/observations.ts", "const obsoleteObservation = 91;");
    const hidden = await search({ query: "obsoleteObservation" });
    expect(hidden.totalMatches).toBe(0);
    expect(hidden.skippedDirs).toContain(".worktrees");
    expect(hidden.message).toContain("已排除镜像/依赖目录");
    const current = await search({ query: "currentObservation" });
    expect(current.totalMatches).toBe(1);
    expect(current.matches[0].path.replaceAll("\\", "/")).toBe("src/observations.ts");
  });
  it("rejects traversal through the real public search boundary", async () => {
    const rejected = await search({ query: "observation", paths: ["../../../outside/observations.txt"] });
    expect(rejected.matches).toEqual([]);
    expect(rejected.rejectedPaths).toEqual(["../../../outside/observations.txt"]);
    put("src/main/observations.ts", "observation");
    const accepted = await search({ query: "observation", paths: ["src/main/observations.ts"] });
    expect(accepted.totalMatches).toBe(1);
    expect(accepted.rejectedPaths).toBeUndefined();
  });
});
