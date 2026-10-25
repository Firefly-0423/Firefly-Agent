// A real Streamable HTTP MCP server on a loopback port: the adapter connects over the http transport, registers the
// server's tool and calls it, with no SDK mocks in between.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

vi.mock("electron", () => ({ app: { getPath: () => process.cwd() } }));

import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    // Stateless mode: a fresh MCP server and transport per request, as the SDK recommends for simple servers.
    const mcp = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => ({ content: [{ type: "text", text: `echo: ${String(call.params.arguments?.text)}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await disconnectMcpServer("echo-http");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("connects to a Streamable HTTP server, registers its tool and calls it", async () => {
  const toolIds = await connectMcpServer({ id: "echo-http", name: "Echo over HTTP", transport: "http", url });
  expect(toolIds).toHaveLength(1);
  const tool = toolRegistry.getById(toolIds[0])!;
  expect(tool).toBeDefined();
  const result = await tool.execute({ text: "流萤" }, { signal: new AbortController().signal } as never);
  expect(JSON.stringify(result)).toContain("echo: 流萤");
});
