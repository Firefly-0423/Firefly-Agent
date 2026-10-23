import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ connect: vi.fn(), listTools: vi.fn(), callTool: vi.fn(), close: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  connect = sdk.connect; listTools = sdk.listTools; callTool = sdk.callTool; close = sdk.close;
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { close = sdk.close; } }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class { close = sdk.close; } }));
vi.mock("../rag/index", () => ({ searchMemory: vi.fn() }));

import { connectMcpServer, disconnectMcpServer, getMcpServerStates } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";

const secret = "synthetic-private-credential";
async function tool() {
  await connectMcpServer({ id: "security", name: "Security", transport: "stdio", command: "node", env: { TOKEN: secret } });
  return toolRegistry.getById("security-check")!;
}
function logs() {
  return [console.log, console.warn, console.error].flatMap(fn => vi.mocked(fn).mock.calls).flat().join(" ");
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  sdk.listTools.mockResolvedValue({ tools: [{ name: "check", inputSchema: { type: "object", properties: {} } }] });
  sdk.callTool.mockResolvedValue({ content: [{ type: "text", text: secret }] });
});
afterEach(async () => {
  for (const state of getMcpServerStates()) await disconnectMcpServer(state.id);
  vi.restoreAllMocks();
});

describe("MCP diagnostic boundaries", () => {
  it("keeps arguments and successful output out of logs without changing the result", async () => {
    expect(await (await tool()).execute({ token: secret })).toBe(secret);
    expect(logs()).not.toContain(secret);
  });

  it.each([
    [Object.assign(new Error(`fetch failed ${secret}`), { code: "ECONNRESET" }), "transient", "unreachable"],
    [Object.assign(new Error(`Request timed out ${secret}`), { code: -32001 }), "timeout", "timeout"],
    [Object.assign(new Error(`Unauthorized ${secret}`), { status: 401 }), "permission_denied", "auth"],
  ])("distinguishes a transport/auth failure without leaking its text or enabling replay", async (error, category, reason) => {
    sdk.callTool.mockRejectedValue(error);
    const failure = await (await tool()).execute({}).catch(error => error);
    expect(failure).toMatchObject({ code: "E_MCP_TOOL_FAILED", category, retryable: false, effectState: "unknown" });
    expect(failure.message).toContain(String(reason));
    expect(failure.message).not.toContain(secret);
    expect(logs()).not.toContain(secret);
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
  });

  it("keeps tool-level errors semantic and preserves recovery data without logging it", async () => {
    sdk.callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "Choose an existing project" }] });
    const failure = await (await tool()).execute({}).catch(error => error);
    expect(failure).toMatchObject({ category: "semantic_failure", retryable: false, effectState: "unknown" });
    expect(failure.message).toContain("Choose an existing project");
    expect(logs()).not.toContain("Choose an existing project");
  });

  it("does not log raw connection failures", async () => {
    sdk.connect.mockRejectedValue(new Error(`Authorization Bearer ${secret}`));
    await expect(tool()).rejects.toThrow();
    expect(logs()).not.toContain(secret);
  });

  it("removes configured environment values from tool-level error text", async () => {
    sdk.callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: `Token ${secret} expired; reconnect` }] });
    const failure = await (await tool()).execute({}).catch(error => error);
    expect(failure.message).toContain("reconnect");
    expect(failure.message).not.toContain(secret);
  });
});

describe("redactConfiguredEnvValues", () => {
  it("keeps ordinary settings and short values readable", async () => {
    const { redactConfiguredEnvValues } = await import("./mcp-adapter");
    const env = { ELECTRON_RUN_AS_NODE: "1", FEATURE: "true", SEP: "/", DASH: "-", PORT: "8080" };
    expect(redactConfiguredEnvValues("page 1 failed: true / - on 8080", env)).toBe("page 1 failed: true / - on 8080");
  });

  it("redacts credential-looking values by key name or by length", async () => {
    const { redactConfiguredEnvValues } = await import("./mcp-adapter");
    const env = { API_TOKEN: "abcd", CUSTOM: "synthetic-private-credential", MODE: "dev" };
    expect(redactConfiguredEnvValues("abcd and synthetic-private-credential and dev", env))
      .toBe("[REDACTED] and [REDACTED] and dev");
  });

  it("redacts the longer value first when values overlap", async () => {
    const { redactConfiguredEnvValues } = await import("./mcp-adapter");
    const env = { A_SECRET: "token-abcdef-long", B_SECRET: "token-abcdef" };
    expect(redactConfiguredEnvValues("x token-abcdef-long y", env)).toBe("x [REDACTED] y");
  });
});
