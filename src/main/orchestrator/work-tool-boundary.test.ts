import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./vision-captioner", () => ({ captionImage: vi.fn() }));
vi.mock("./mcp-manager", () => ({ addMcpServer: vi.fn() }));
vi.mock("../index", () => ({ sendToLive2DWindow: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => process.cwd() } }));

describe("Work-mode registration boundary", () => {
  beforeEach(() => vi.resetModules());

  it("provides shared file, code and verification operations without retired delegation tools", async () => {
    await import("./tools/built-in-tools");
    await import("./tools/fs-tools");
    (await import("./tools/ast-grep-tools")).registerAstGrepTools();
    (await import("./tools/apply-patch-tools")).registerApplyPatchTool();
    (await import("./tools/search-code-tools")).registerSearchCodeTool();
    (await import("./tools/life-tools")).registerLifeTools();
    const { toolRegistry } = await import("./tools/registry/tool-registry");
    const ids = toolRegistry.getAllTools().map(({ id }) => id);
    const required = ["run_verification", "list_dir", "read_file", "run_shell", "write_file", "search_code", "ast_grep_replace", "ast_grep_search", "str_replace", "apply_patch"];
    expect(required.filter((id) => !ids.includes(id))).toEqual([]);
    const retired = ["todo_write", "delegate_search", "delegate_document", "delegate_task", "delegate_coding"];
    expect(retired.filter((id) => ids.includes(id))).toEqual([]);
  });
});
