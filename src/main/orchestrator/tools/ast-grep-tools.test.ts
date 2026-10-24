import { beforeEach, afterEach, it, expect, describe, vi } from "vitest";
import * as fs from "fs";
import { join, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { registerAstGrepTools } from "./ast-grep-tools";
import { toolRegistry } from "./registry/tool-registry";
import { getWorkspaceExecutionCoordinator } from "../harness/execution-coordinator";
import type { ToolContext } from "./registry/tool-context";

const fault = vi.hoisted(() => ({ path: "" }));
vi.mock("fs", async original => {
  const native = await original<typeof import("fs")>();
  return { ...native, writeFileSync: (...args: Parameters<typeof native.writeFileSync>) => {
    if (String(args[0]) === fault.path) {
      fault.path = "";
      native.writeFileSync(args[0], "const interrupted = 73;\n");
      throw new Error("Injected AST artifact failure");
    }
    return native.writeFileSync(...args);
  } };
});
let root: string;
let context: ToolContext;
const pattern = "console.warn($$$VALUES)";
const rewrite = "logger.debug($$$VALUES)";
const put = (name: string, text: string) => { const file = join(root, name); fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const text = (name: string) => fs.readFileSync(join(root, name), "utf8");
const execute = async (id: string, args: Record<string, unknown>, ctx: ToolContext | undefined = context) => JSON.parse(await toolRegistry.getById(id)!.execute(args, ctx));
const search = (args = {}) => execute("ast_grep_search", { pattern, ...args });
const replace = (args = {}) => execute("ast_grep_replace", { pattern, rewrite, ...args });
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "ast-contract-73-"));
  context = { userQuery: "Inspect the code structure", resolvedWorkspaceRoot: root };
  registerAstGrepTools();
});
afterEach(() => {
  fault.path = "";
  const target = resolve(root);
  if (target.startsWith(resolve(tmpdir()) + sep)) fs.rmSync(target, { recursive: true, force: true });
});

describe("structural search over source files", () => {
  it("reports the matched expression with one-based coordinates and a display path", async () => {
    put("source/observe.ts", "const distance = 73;\nconsole.warn(distance);\n");
    const result = await search({ paths: ["source"] });
    expect(result).toMatchObject({ success: true, matchCount: 1 });
    expect(result.matches[0]).toEqual({ file: "source/observe.ts", line: 2, column: 1, endLine: 2, text: "console.warn(distance)" });
  });
  it("ignores identical source text embedded in a comment or string", async () => {
    put("source/observe.ts", "// console.warn(distance);\nconst label = 'console.warn(distance)';\nconsole.warn(distance);\n");
    const result = await search({ paths: ["source"] });
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].line).toBe(3);
  });
  it("counts matches across all participating files", async () => {
    put("north.ts", "console.warn(73);\n");
    put("south.ts", "console.warn(91);\nconsole.warn(92);\n");
    expect(await search()).toMatchObject({ matchCount: 3, filesWithMatches: 2 });
  });
  it("limits collection to a requested language", async () => {
    put("north.ts", "console.warn(73);\n");
    put("south.py", "print(91)\n");
    const result = await search({ language: "TypeScript" });
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe("north.ts");
  });
  it("truncates after the requested number of structural matches", async () => {
    put("north.ts", "console.warn(73);\nconsole.warn(91);\nconsole.warn(92);\n");
    const result = await search({ maxMatches: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
  it("reports an empty successful search when no syntax matches", async () => {
    put("north.ts", "const distance = 73;\n");
    expect(await search()).toMatchObject({ success: true, matchCount: 0 });
  });
  it("skips dependency and hidden directories", async () => {
    put("node_modules/fixture-package/north.ts", "console.warn(73);\n");
    put(".private/south.ts", "console.warn(91);\n");
    put("source/west.ts", "console.warn(92);\n");
    const result = await search();
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].file).toBe("source/west.ts");
  });
  it("excludes an escaped search path and reports it explicitly", async () => {
    const result = await search({ paths: ["../../unbound-observations"] });
    expect(result).toMatchObject({ success: true, matchCount: 0 });
    expect(result.skipped).toContain("../../unbound-observations");
  });
  it("rejects empty patterns and unsupported languages", async () => {
    const empty = await search({ pattern: "" });
    expect(empty.success).toBe(false);
    expect(empty.errors[0]).toContain("pattern 参数不能为空");
    const unsupported = await search({ pattern: "distance", language: "Fortran" });
    expect(unsupported.success).toBe(false);
    expect(unsupported.errors[0]).toContain("不支持的语言");
  });
  it("requires a bound workspace", async () => {
    const result = JSON.parse(await toolRegistry.getById("ast_grep_search")!.execute({ pattern: "distance" }));
    expect(result.success).toBe(false);
  });
});

describe("structural replacement previews and writes", () => {
  it("defaults to a preview without altering source bytes", async () => {
    const original = "console.warn(73);\nconsole.warn(91);\n";
    put("source/observe.ts", original);
    const result = await replace({ paths: ["source"] });
    expect(result).toMatchObject({ success: true, dryRun: true, filesToChange: 1, totalMatches: 2 });
    expect(result.planned[0].file).toBe("source/observe.ts");
    expect(text("source/observe.ts")).toBe(original);
  });
  it("writes an explicitly confirmed single-file rewrite", async () => {
    put("source/observe.ts", "console.warn(73);\n");
    const result = await replace({ paths: ["source"], dryRun: false });
    expect(result).toMatchObject({ success: true, changedFiles: 1 });
    expect(result.changed).toEqual(["source/observe.ts"]);
    expect(text("source/observe.ts")).toBe("logger.debug(73);\n");
  });
  it("writes every matching file in a batch", async () => {
    put("north.ts", "console.warn(73);\n");
    put("south.ts", "console.warn(91);\n");
    expect((await replace({ dryRun: false })).changedFiles).toBe(2);
    expect(text("north.ts")).toBe("logger.debug(73);\n");
    expect(text("south.ts")).toBe("logger.debug(91);\n");
  });
  it("keeps CRLF and unrelated source regions unchanged", async () => {
    put("source/observe.ts", "const distance = 73;\r\nconsole.warn(distance);\r\nconst angle = 91;\r\n");
    expect((await replace({ paths: ["source"], dryRun: false })).success).toBe(true);
    expect(text("source/observe.ts")).toBe("const distance = 73;\r\nlogger.debug(distance);\r\nconst angle = 91;\r\n");
  });
  it("retains comments and literals while removing the original call", async () => {
    put("source/observe.ts", "// measurement header\nconst label = 'observatory';\nconsole.warn(73);\n");
    expect((await replace({ paths: ["source"], dryRun: false })).success).toBe(true);
    const result = text("source/observe.ts");
    expect(result).toContain("// measurement header");
    expect(result).toContain("const label = 'observatory';");
    expect(result).toContain("logger.debug(73);");
    expect(result).not.toContain("console.warn");
  });
  it("excludes escaped rewrite paths and rejects an empty pattern", async () => {
    const outside = await replace({ pattern: "distance", rewrite: "angle", paths: ["../../unbound-observations"], dryRun: false });
    expect(outside.changedFiles).toBe(0);
    expect(outside.skipped).toContain("../../unbound-observations");
    const invalid = await replace({ pattern: "" });
    expect(invalid.success).toBe(false);
    expect(invalid.errors[0]).toContain("pattern 参数不能为空");
  });
  it("does not rewrite a file when no match exists", async () => {
    put("north.ts", "const distance = 73;\n");
    expect(await replace({ dryRun: false })).toMatchObject({ success: true, changedFiles: 0 });
    expect(text("north.ts")).toBe("const distance = 73;\n");
  });
  it("expands a captured single-node value in the replacement template", async () => {
    put("source/observe.ts", "lookupStar(739);\n");
    expect((await replace({ pattern: "lookupStar($IDENTIFIER)", rewrite: "fetchStar($IDENTIFIER, settings)", paths: ["source"], dryRun: false })).success).toBe(true);
    expect(text("source/observe.ts")).toBe("fetchStar(739, settings);\n");
  });
});

describe("independent write evidence for AST mutations", () => {
  const identity = (coordinator: ReturnType<typeof getWorkspaceExecutionCoordinator>, agentId: string) => ({
    workspaceId: coordinator.workspaceId, parentRunId: "ast-parent-73", groupId: "ast-group-73", agentId, childRunId: "child-" + agentId, toolCallId: "call-" + agentId,
  });
  it("lets another agent rewrite after a preview that claimed no paths", async () => {
    put("north.ts", "console.warn(73);\n");
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const preview = identity(coordinator, "preview-73");
    await coordinator.runLeaf(preview, "exclusive", undefined, async permit => {
      context.execution = { coordinator, scope: preview, permit };
      expect((await replace()).dryRun).toBe(true);
    });
    expect(coordinator.getWriteEvidence()).toEqual([]);
    const writer = identity(coordinator, "writer-91");
    await coordinator.runLeaf(writer, "exclusive", undefined, async permit => {
      context.execution = { coordinator, scope: writer, permit };
      expect((await replace({ dryRun: false })).success).toBe(true);
    });
    expect(coordinator.getWriteEvidence()[0].state).toBe("applied");
    await coordinator.closeGroup(writer.groupId);
  });
  it("separates completed diffs from actual partial writes after a disk failure", async () => {
    put("north.ts", "console.warn(73);\n");
    put("south.ts", "console.warn(91);\n");
    fault.path = join(root, "south.ts");
    const coordinator = getWorkspaceExecutionCoordinator(root);
    const owner = identity(coordinator, "partial-writer-73");
    await coordinator.runLeaf(owner, "exclusive", undefined, async permit => {
      context.execution = { coordinator, scope: owner, permit };
      const result = await replace({ dryRun: false });
      expect(result.success).toBe(false);
      expect(result.changed).toEqual(["north.ts"]);
      expect(result.changes.map((entry: { file: string }) => entry.file)).toEqual(["north.ts"]);
    });
    const evidence = coordinator.getWriteEvidence();
    expect(evidence.map(entry => entry.state)).toEqual(["applied", "partially_applied"]);
    expect(text("north.ts")).toBe("logger.debug(73);\n");
    expect(text("south.ts")).toBe("const interrupted = 73;\n");
    expect(evidence.every(entry => entry.before?.sha256 && entry.after?.sha256)).toBe(true);
    await coordinator.closeGroup(owner.groupId);
  });
});
