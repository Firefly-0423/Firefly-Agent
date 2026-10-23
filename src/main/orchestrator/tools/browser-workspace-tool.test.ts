import { describe, expect, it, vi } from "vitest";
import { createBrowserWorkspaceTool, registerBrowserWorkspaceTool } from "./browser-workspace-tool";
import { createBrowserWorkspaceExecutor } from "../../browser/browser-workspace-executor";
const context = () => ({ userQuery: "Browse", conversationId: "conversation", runId: "run", signal: new AbortController().signal, mode: "work" as const });
describe("browser_workspace registered Main boundary", () => {
  it("registers a context-dependent uncached tool with no approval or JavaScript capability", () => {
    const registered: any[] = []; registerBrowserWorkspaceTool(vi.fn(), { register: tool => registered.push(tool) });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ id: "browser_workspace", needsContext: true, ledgerPolicy: "bypass", risk: "network" });
    expect(registered[0].inputSchema.properties.operation.enum).toEqual(["open", "navigate", "back", "forward", "reload", "observe", "click", "type", "close"]);
    expect(registered[0].inputSchema.properties).not.toHaveProperty("allow"); expect(registered[0].inputSchema.properties).not.toHaveProperty("script");
  });
  it("returns actual results as untrusted web content and propagates denial as a failed tool outcome", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ ok: true, value: { url: "https://example.com/", text: "Actual DOM" } }).mockResolvedValueOnce({ ok: false, code: "permission_denied" });
    const tool = createBrowserWorkspaceTool(execute), ctx = context();
    expect(JSON.parse(await tool.execute({ operation: "observe" }, ctx))).toMatchObject({ success: true, contentTrust: "untrusted_web_page", result: { text: "Actual DOM" } });
    expect(execute).toHaveBeenCalledWith({ operation: "observe" }, ctx);
    await expect(tool.execute({ operation: "observe" }, ctx)).rejects.toMatchObject({ code: "BROWSER_PERMISSION_DENIED", category: "permission_denied" });
  });
  it("requires a live trusted Main run and the exact owner object; no fabricated WebContents event", async () => {
    const owner = { conversationId: "conversation", signal: new AbortController().signal } as any;
    let active = true, currentOwner: any = owner;
    const executeAgent = vi.fn(async (_owner, _args, run) => { expect(run.isCurrent()).toBe(true); active = false; expect(run.isCurrent()).toBe(false); return { ok: false as const, code: "owner_mismatch" as const }; });
    const execute = createBrowserWorkspaceExecutor({ currentOwner: () => currentOwner, service: () => ({ executeAgent }), isRunCurrent: () => active });
    const ctx = context(); await execute({ operation: "observe" }, ctx);
    expect(executeAgent).toHaveBeenCalledWith(owner, { operation: "observe" }, expect.objectContaining({ runId: "run", conversationId: "conversation", signal: ctx.signal }));
    executeAgent.mockClear(); active = true; currentOwner = { ...owner, conversationId: "other" };
    expect(await execute({ operation: "observe" }, ctx)).toEqual({ ok: false, code: "owner_mismatch" }); expect(executeAgent).not.toHaveBeenCalled();
    expect(await execute({ operation: "observe" }, { ...ctx, signal: undefined })).toEqual({ ok: false, code: "owner_mismatch" });
  });
});

it("does not claim a cancelled or ownership-lost click had no effect", async () => {
  for (const code of ["cancelled", "owner_mismatch"] as const) {
    const tool = createBrowserWorkspaceTool(async () => ({ ok: false, code }));
    await expect(tool.execute({ operation: "click", ref: "1", snapshotId: "snapshot" }, context())).rejects.toMatchObject({ effectState: "unknown", retryable: false });
  }
});
