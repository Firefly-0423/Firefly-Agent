import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcpServer, disconnectMcpServer } from "../orchestrator/mcp-adapter";
import { toolRegistry, type ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import type { DeviceSimulation, McpDevicePort, SimulationSession } from "./controller";
export interface FixtureMcpConnection {
  readonly simulation: true; readonly serverId: string; readonly url: string; readonly messageUrl: string;
  readonly toolIds: readonly string[]; readonly port: McpDevicePort; close(): Promise<void>;
}
const BODY_LIMIT = 16_384;
const tools = [
  { name: "read", description: "SIMULATION ONLY: read an allowed light/ac/curtain fixture", inputSchema: { type: "object" as const, properties: { deviceId: { type: "string", enum: ["light", "ac", "curtain"] } }, required: ["deviceId"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "preview", description: "SIMULATION ONLY: preview an allowed exact action; cannot confirm", inputSchema: { type: "object" as const, properties: { deviceId: { type: "string", enum: ["light", "ac", "curtain"] }, action: { type: "object" } }, required: ["deviceId", "action"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "execute", description: "SIMULATION ONLY: execute an already confirmed and dispatching operation ID", inputSchema: { type: "object" as const, properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "receipt", description: "SIMULATION ONLY: query an owned operation's receipt without resending", inputSchema: { type: "object" as const, properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false }, annotations: { readOnlyHint: true } },
];
function reject(req: IncomingMessage, res: ServerResponse, status: number): void {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("E_SIM_HTTP");
  req.resume();
}
function boundedBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, rejectBody) => {
    let size = 0, done = false; const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) return; size += chunk.length;
      if (size > BODY_LIMIT) { done = true; chunks.length = 0; rejectBody(new Error("E_SIM_BODY_LIMIT")); }
      else chunks.push(chunk);
    });
    req.once("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    const failed = () => { if (!done) { done = true; rejectBody(new Error("E_SIM_BODY")); } };
    req.once("error", failed); req.once("aborted", failed);
  });
}

/** Explicit test/smoke harness only. Never called from normal app startup or MCP configuration. */
export async function openFixtureMcp(simulation: DeviceSimulation, session: SimulationSession): Promise<FixtureMcpConnection> {
  simulation.assertReady(session); // Check opaque authority and durable health before any listener/registration.
  const serverId = `device-sim-${randomUUID()}`;
  const adapterOwner = Object.freeze({});
  let authority = "", base = "", transport: SSEServerTransport | undefined, sdk: Server | undefined;
  let ownedTools: Map<string, ToolDefinition> | undefined;
  let closePromise: Promise<void> | undefined;
  const listener = http.createServer({ maxHeaderSize: 4096 }, (req, res) => {
    void handle(req, res).catch(() => reject(req, res, 400));
  });
  listener.requestTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== authority || req.headers.origin !== undefined || !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) return reject(req, res, 403);
    const url = new URL(req.url ?? "/", base);
    if (url.origin !== base) return reject(req, res, 404);
    if (req.method === "GET" && url.pathname === "/sse" && !url.search) {
      if (transport) return reject(req, res, 409);
      sdk = new Server({ name: "firefly-device-simulation", version: "1.0.0" }, { capabilities: { tools: {} } });
      sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(tools) }));
      sdk.setRequestHandler(CallToolRequestSchema, async request => {
        try {
          const result = simulation.handleMcp(session, request.params.name, request.params.arguments ?? {});
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          return { isError: true, content: [{ type: "text", text: /^E_SIM_[A-Z_]+$/.test(message) ? message : "E_SIM_PROVIDER" }] };
        }
      });
      transport = new SSEServerTransport("/messages", res, { enableDnsRebindingProtection: true, allowedHosts: [authority] });
      await sdk.connect(transport); return;
    }
    if (req.method !== "POST" || url.pathname !== "/messages" || !transport || url.searchParams.size !== 1 || url.searchParams.get("sessionId") !== transport.sessionId) return reject(req, res, 404);
    if (Number(req.headers["content-length"] ?? "0") > BODY_LIMIT) return reject(req, res, 413);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) return reject(req, res, 400);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req))); }
    catch (error) { return reject(req, res, (error as Error).message === "E_SIM_BODY_LIMIT" ? 413 : 400); }
    await transport.handlePostMessage(req, res, body);
  }
  async function cleanup(): Promise<void> {
    let failed = false;
    // A replaced registry entry is not ours; it must not prevent releasing our client.
    try { await disconnectMcpServer(serverId, adapterOwner); } catch { failed = true; }
    try { await sdk?.close(); } catch { failed = true; }
    await new Promise<void>(resolve => {
      if (!listener.listening) return resolve();
      listener.close(() => resolve()); listener.closeAllConnections();
    });
    if (failed) throw new Error("E_SIM_MCP_CLOSE");
  }
  const close = () => closePromise ??= cleanup().catch(error => {
    closePromise = undefined; // Retain successful idempotence; allow owned cleanup to retry a failure.
    throw error;
  });
  try {
    await new Promise<void>((resolve, rejectListen) => {
      listener.once("error", rejectListen); listener.listen(0, "127.0.0.1", () => { listener.off("error", rejectListen); resolve(); });
    });
    listener.on("error", () => { /* HTTP failures return fixed errors; no credentials or paths are logged. */ });
    const address = listener.address(); if (!address || typeof address === "string") throw new Error("E_SIM_MCP_START");
    authority = `127.0.0.1:${address.port}`; base = `http://${authority}`;
    const toolIds = await connectMcpServer({ id: serverId, name: "Device simulation fixtures", transport: "sse", url: base + "/sse",
      effectKindOverrides: { read: "read", preview: "read", execute: "external_side_effect", receipt: "verification" } }, adapterOwner);
    ownedTools = new Map(toolIds.map(id => { const definition = toolRegistry.getById(id); if (!definition) throw new Error("E_SIM_MCP_START"); return [id, definition]; }));
    if (!transport || toolIds.length !== tools.length) throw new Error("E_SIM_MCP_START");
    const invoke = async (name: "execute" | "receipt", id: string, signal?: AbortSignal): Promise<unknown> => {
      const definition = ownedTools!.get(`${serverId}-${name}`)!;
      const result = await definition.execute({ operationId: id }, { userQuery: "Owned synthetic device fixture", ...(signal ? { signal } : {}) });
      try { if (Buffer.byteLength(result) > BODY_LIMIT) throw new Error("size"); return JSON.parse(result); }
      catch { throw new Error("E_SIM_RECEIPT_INVALID"); }
    };
    return { simulation: true, serverId, url: base + "/sse", messageUrl: base + "/messages?sessionId=" + transport.sessionId,
      toolIds: Object.freeze([...toolIds]), port: { execute: (id, signal) => invoke("execute", id, signal), receipt: (id, signal) => invoke("receipt", id, signal) }, close };
  } catch {
    try { await close(); } catch { throw new Error("E_SIM_MCP_START_CLEANUP"); }
    throw new Error("E_SIM_MCP_START");
  }
}
