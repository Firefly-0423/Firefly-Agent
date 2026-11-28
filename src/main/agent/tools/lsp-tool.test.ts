import { expect, it, vi, describe } from "vitest";
import { createLspTool, registerLspTool } from "./lsp-tool";

const context = { mode: "code" as const, userQuery: "Inspect the symbol", resolvedWorkspaceRoot: "E:\\semantic-project" };
describe("Code semantic-query adapter", () => {
  it("publishes read-only metadata and delegates the full normalized query with trusted context", async () => {
    const result = { serverId: "semantic-server-73", operation: "hover" as const, workspaceRoot: context.resolvedWorkspaceRoot, items: [{ contents: "distance: number" }], message: "Symbol information" };
    const manager = { execute: vi.fn(async () => result) };
    const tool = createLspTool(manager);
    expect(tool).toMatchObject({ id: "lsp", modes: ["code"], risk: "fs-read", effectKind: "read", verificationPolicy: "none", needsContext: true });
    expect(JSON.parse(await tool.execute({ operation: "hover", filePath: "src/geometry.ts", line: 7, character: 3 }, context))).toEqual(result);
    expect(manager.execute).toHaveBeenCalledWith({
      operation: "hover", filePath: "src/geometry.ts", line: 7, character: 3, item: undefined, query: undefined,
    }, { resolvedWorkspaceRoot: "E:\\semantic-project" });
  });
  it("rejects non-Code contexts and executable arguments before contacting a language server", async () => {
    const manager = { execute: vi.fn() };
    const tool = createLspTool(manager);
    await expect(tool.execute({ operation: "workspaceSymbol", query: "Geometry" }, { ...context, mode: "work" })).rejects.toThrow("Code 模式");
    await expect(tool.execute({ operation: "hover", command: "untrusted-server.exe" }, context)).rejects.toThrow("不支持的 LSP 参数");
    expect(manager.execute).not.toHaveBeenCalled();
  });
  it("passes an opaque hierarchy item unchanged for a follow-up query", async () => {
    const manager = { execute: vi.fn(async () => ({ serverId: "semantic-server-73", operation: "incomingCalls" as const, workspaceRoot: context.resolvedWorkspaceRoot, items: [], message: "" })) };
    const item = { name: "distance", uri: "file:///semantic-project/src/geometry.ts", range: {}, selectionRange: {} };
    await createLspTool(manager).execute({ operation: "incomingCalls", filePath: "src/geometry.ts", item }, context);
    expect(manager.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "incomingCalls", item }), expect.any(Object));
  });
  it("registers one public semantic-query tool", () => {
    const register = vi.fn();
    registerLspTool({ execute: vi.fn() }, { register });
    expect(register.mock.calls.map(([entry]) => entry.id)).toEqual(["lsp"]);
  });
});
