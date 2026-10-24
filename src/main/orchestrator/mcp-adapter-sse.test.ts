import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const remote = vi.hoisted(() => ({ connect: vi.fn(), listTools: vi.fn(), callTool: vi.fn(), close: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => process.cwd() } }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: vi.fn(function () { return remote; }) }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: vi.fn(function () { return { close: vi.fn(), onerror: null }; }) }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: vi.fn(function () { return { close: vi.fn(), onerror: null }; }) }));
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";

beforeEach(() => {
  vi.clearAllMocks();
  remote.connect.mockResolvedValue(undefined);
  remote.close.mockResolvedValue(undefined);
  remote.listTools.mockResolvedValue({ tools: [] });
  toolRegistry.getAllTools().forEach(({ id }) => toolRegistry.unregister(id));
});
afterEach(async () => {
  for (const id of ["agenda-stdio", "agenda-sse", "agenda-error"]) await disconnectMcpServer(id);
});

describe("MCP transport configuration and remote failures", () => {
  it("constructs only the SSE transport for a URL-based connection", async () => {
    await connectMcpServer({ id: "agenda-sse", name: "Calendar events", transport: "sse", url: "https://calendar.invalid/events" });
    expect(SSEClientTransport).toHaveBeenCalledWith(new URL("https://calendar.invalid/events"));
    expect(StdioClientTransport).not.toHaveBeenCalled();
  });

  it("constructs only the stdio transport for a command-based connection", async () => {
    await connectMcpServer({ id: "agenda-stdio", name: "Calendar process", transport: "stdio", command: "node", args: ["agenda-server.mjs"] });
    expect(StdioClientTransport).toHaveBeenCalledWith({ command: "node", args: ["agenda-server.mjs"], env: undefined, cwd: undefined });
    expect(SSEClientTransport).not.toHaveBeenCalled();
  });

  it("rejects SSE configuration without a URL", async () => {
    await expect(connectMcpServer({ id: "agenda-invalid", name: "Missing calendar endpoint", transport: "sse" })).rejects.toThrow(/sse transport requires url/);
  });

  it("rejects a registered tool execution when the MCP result marks an error", async () => {
    remote.listTools.mockResolvedValue({ tools: [{ name: "lookup", description: "Find an appointment", inputSchema: { type: "object", properties: { day: { type: "string" } } } }] });
    remote.callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "Calendar unavailable" }] });
    await connectMcpServer({ id: "agenda-error", name: "Unavailable calendar", transport: "stdio", command: "node", args: ["calendar.mjs"] });
    const lookup = toolRegistry.getById("agenda-error-lookup");
    expect(lookup).toBeDefined();
    await expect(lookup!.execute({ day: "Tuesday" })).rejects.toThrow("E_MCP_TOOL_FAILED");
    expect(remote.callTool).toHaveBeenCalledWith({ name: "lookup", arguments: { day: "Tuesday" } });
  });
});
