import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Environment-only dependencies. SDK, HTTP, adapter and registry are real.
vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock("../rag/index", () => ({ searchMemory: vi.fn() }));

import { createStorageContext } from "../storage-context";
import { resolveRuntimeProfile, within } from "../runtime-profile";
import { disconnectMcpServer, getMcpServerStates } from "../orchestrator/mcp-adapter";
import { toolRegistry, type ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { DeviceSimulation, type Preview, type SimulationSession } from "./controller";
import type { DeviceId, SessionGrant } from "./contracts";
import { openFixtureMcp, type FixtureMcpConnection } from "./mcp-fixture";

const roots: string[] = [], simulations: DeviceSimulation[] = [], connections: FixtureMcpConnection[] = [];
const grant: SessionGrant = { owner: "protocol-owner", read: ["light", "ac", "curtain"], actions: { light: ["power", "brightness"], ac: ["power", "mode", "setpoint"], curtain: ["position"] } };
function setup(deferredDeviceIds: readonly DeviceId[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-device-mcp-")); roots.push(root);
  const isolated = path.join(root, "isolated"); fs.mkdirSync(isolated);
  const context = createStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", `--firefly-isolation-root=${isolated}`], env: {}, isPackaged: false, productionAppData: path.join(root, "production") }));
  const simulation = new DeviceSimulation(context, { deferredDeviceIds }); simulations.push(simulation);
  return { simulation, session: simulation.openSession(grant), context };
}
async function connect(simulation: DeviceSimulation, session: SimulationSession) {
  const connection = await openFixtureMcp(simulation, session); connections.push(connection); return connection;
}
function tool(connection: FixtureMcpConnection, name: string) {
  const tool = toolRegistry.getById(connection.serverId + "-" + name); if (!tool) throw new Error("test tool missing"); return tool;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) await connection.close();
  for (const simulation of simulations.splice(0)) simulation.close();
  toolRegistry.unregister("device-simulation-unrelated");
  for (const root of roots.splice(0)) {
    if (!within(os.tmpdir(), root) || !path.basename(root).startsWith("firefly-device-mcp-")) throw new Error("unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("owned fixture over existing real MCP host", () => {
  it("discovers/read/previews all fixtures and dispatches only exactly confirmed operations", async () => {
    const { simulation, session, context } = setup(); const connection = await connect(simulation, session);
    expect(connection.simulation).toBe(true); expect(new URL(connection.url).hostname).toBe("127.0.0.1");
    expect(connection.toolIds).toHaveLength(4);
    expect(tool(connection, "execute").effectKind).toBe("external_side_effect");
    expect(tool(connection, "read").effectKind).toBe("read");
    expect(tool(connection, "preview").effectKind).toBe("read");
    expect(tool(connection, "receipt").effectKind).toBe("verification");
    const cases: Array<[DeviceId, unknown]> = [["light", { type: "power", on: true }], ["ac", { type: "setpoint", celsius: 22.5 }], ["curtain", { type: "position", percent: 75 }]];
    for (const [deviceId, action] of cases) {
      expect(JSON.parse(await tool(connection, "read").execute({ deviceId }))).toMatchObject({ simulation: true, id: deviceId, revision: 0 });
      const preview = JSON.parse(await tool(connection, "preview").execute({ deviceId, action })) as Preview;
      const operation = simulation.confirm(session, preview.id);
      await expect(tool(connection, "execute").execute({ operationId: operation.id }, { userQuery: "synthetic bypass attempt", permissionMode: "allow_all" })).rejects.toThrow("E_SIM_NOT_DISPATCHED");
      expect(simulation.read(session, deviceId).revision).toBe(0);
      expect(await simulation.dispatch(session, operation.id, connection.port)).toMatchObject({ simulation: true, status: "applied", effectState: "applied" });
      expect(JSON.parse(await tool(connection, "receipt").execute({ operationId: operation.id }))).toMatchObject({ operationId: operation.id, phase: "applied" });
    }
    expect(simulation.read(session, "ac")).toMatchObject({ setpointC: 22.5, roomTemperatureC: 26 });
    expect(simulation.read(session, "curtain")).toMatchObject({ position: 75, orientation: "0=closed;100=open" });
    expect(fs.existsSync(context.files.mcp)).toBe(false);
    await expect(tool(connection, "execute").execute({ operationId: "forged", approved: true })).rejects.toThrow("E_SIM_ARGS");
    simulation.revokeSession(session);
    await expect(tool(connection, "read").execute({ deviceId: "light" }, { userQuery: "synthetic", permissionMode: "allow_all" })).rejects.toThrow("E_SIM_DENIED");
  });

  it("keeps accepted pending across reconstruction and verifies completion with a read-only receipt query", async () => {
    const { simulation, session, context } = setup(["ac"]); const first = await connect(simulation, session);
    const preview = JSON.parse(await tool(first, "preview").execute({ deviceId: "ac", action: { type: "setpoint", celsius: 20 } })) as Preview;
    const operation = simulation.confirm(session, preview.id);
    expect(await simulation.dispatch(session, operation.id, first.port)).toMatchObject({ status: "accepted", effectState: "unknown" });
    expect(simulation.read(session, "ac")).toMatchObject({ revision: 0, setpointC: 24 });
    await first.close(); simulation.close();
    const next = new DeviceSimulation(context); simulations.push(next); const nextSession = next.openSession(grant); const second = await connect(next, nextSession);
    const send = vi.spyOn(second.port, "execute");
    next.completeFixture(operation.id);
    expect(await next.reconcile(nextSession, operation.id, second.port)).toMatchObject({ status: "applied" });
    expect(send).not.toHaveBeenCalled(); expect(next.read(nextSession, "ac")).toMatchObject({ revision: 1, setpointC: 20, roomTemperatureC: 26 });
    expect(fs.existsSync(context.files.mcp)).toBe(false);
  });

  it("leaves a real applied command unknown when its acknowledgement is lost, then only queries", async () => {
    const { simulation, session } = setup(); const connection = await connect(simulation, session);
    const operation = simulation.confirm(session, simulation.preview(session, "light", { type: "power", on: true }).id);
    const port = { ...connection.port, execute: async (id: string) => { await connection.port.execute(id); throw new Error("synthetic lost ack"); } };
    expect(await simulation.dispatch(session, operation.id, port)).toMatchObject({ status: "unknown", retryable: false });
    const send = vi.spyOn(connection.port, "execute");
    expect(await simulation.reconcile(session, operation.id, connection.port)).toMatchObject({ status: "applied" });
    expect(send).not.toHaveBeenCalled(); expect(simulation.read(session, "light")).toMatchObject({ revision: 1, power: true });
  });

  it("rejects unexpected HTTP origins/hosts/routes/sessions and bounded invalid bodies", async () => {
    const { simulation, session, context } = setup(); const connection = await connect(simulation, session);
    const file = path.join(context.stateRoot, "device-simulation", "journal.json");
    expect((await fetch(connection.url, { headers: { Origin: "https://untrusted.invalid" } })).status).toBe(403);
    // Node fetch normalizes Host; the native client sends the actual hostile header.
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const request = http.get(connection.url, { headers: { Host: "untrusted.invalid" } }, response => { response.resume(); resolve(response.statusCode!); });
      request.once("error", reject);
    });
    expect(hostileHost).toBe(403);
    expect((await fetch(connection.url)).status).toBe(409);
    expect((await fetch(new URL("/unknown", connection.url))).status).toBe(404);
    const wrongSession = new URL(connection.messageUrl); wrongSession.searchParams.set("sessionId", "unknown");
    expect((await fetch(wrongSession, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await fetch(connection.messageUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(400);
    expect((await fetch(connection.messageUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" })).status).toBe(400);
    expect((await fetch(connection.messageUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(16_385) })).status).toBe(413);
    const streamed = await new Promise<number>((resolve, reject) => {
      const request = http.request(connection.messageUrl, { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, response => { response.resume(); resolve(response.statusCode!); });
      request.once("error", reject); request.write(" ".repeat(9000)); request.end(" ".repeat(9000));
    });
    expect(streamed).toBe(413);
    expect(fs.existsSync(file)).toBe(false);
    expect(simulation.read(session, "light")).toMatchObject({ revision: 0, power: false });
  });

  it("closes only owned tools/resources and never persists MCP-manager configuration", async () => {
    const { simulation, session, context } = setup();
    const sentinel: ToolDefinition = { id: "device-simulation-unrelated", name: "unrelated fixture", description: "test-owned sentinel", enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "unused" };
    toolRegistry.register(sentinel);
    const connection = await connect(simulation, session); const oldTool = tool(connection, "read");
    await connection.close(); await connection.close();
    expect(connection.toolIds.every(id => !toolRegistry.getById(id))).toBe(true);
    expect(toolRegistry.getById(sentinel.id)).toBe(sentinel);
    expect(getMcpServerStates().some(server => server.id === connection.serverId)).toBe(false);
    await expect(oldTool.execute({ deviceId: "light" })).rejects.toThrow("E_MCP_TOOL_FAILED");
    await expect(fetch(connection.url)).rejects.toThrow();
    expect(fs.existsSync(context.files.mcp)).toBe(false);
  });

  it("releases the original client and tools without deleting a same-namespace replacement", async () => {
    const { simulation, session, context } = setup(); const connection = await connect(simulation, session);
    const oldRead = tool(connection, "read");
    const replacement: ToolDefinition = { ...oldRead, execute: async () => "later-owner" };
    const closeClient = vi.spyOn(Client.prototype, "close");
    const closeTransport = vi.spyOn(SSEClientTransport.prototype, "close");
    toolRegistry.register(replacement);
    try {
      await connection.close(); await connection.close();
      expect(getMcpServerStates().find(server => server.id === connection.serverId)).toBeUndefined();
      expect(closeClient).toHaveBeenCalledTimes(1); expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(toolRegistry.getById(oldRead.id)).toBe(replacement);
      expect(await replacement.execute({})).toBe("later-owner");
      expect(connection.toolIds.filter(id => id !== oldRead.id).every(id => !toolRegistry.getById(id))).toBe(true);
      await expect(oldRead.execute({ deviceId: "light" })).rejects.toThrow("E_MCP_TOOL_FAILED");
      await expect(fetch(connection.url)).rejects.toThrow();
      expect(fs.existsSync(context.files.mcp)).toBe(false);
    } finally {
      // Only test-owned resources: avoid retaining the intentionally reproduced pre-fix leak.
      if (getMcpServerStates().some(server => server.id === connection.serverId)) await disconnectMcpServer(connection.serverId);
      if (toolRegistry.getById(replacement.id) === replacement) toolRegistry.unregister(replacement.id);
    }
  });

  it("denies an unowned session before any MCP registration", async () => {
    const { simulation } = setup(); const before = getMcpServerStates();
    await expect(openFixtureMcp(simulation, { simulation: true } as SimulationSession)).rejects.toThrow("E_SIM_DENIED");
    expect(getMcpServerStates()).toEqual(before);
  });

  it("retries only its owned cleanup after transient client and transport close failures", async () => {
    const { simulation, session } = setup(); const connection = await connect(simulation, session);
    const closeClient = vi.spyOn(Client.prototype, "close").mockRejectedValueOnce(new Error("synthetic client close failure"));
    const closeTransport = vi.spyOn(SSEClientTransport.prototype, "close").mockRejectedValueOnce(new Error("synthetic transport close failure"));
    try {
      await expect(connection.close()).rejects.toThrow("E_SIM_MCP_CLOSE");
      expect(getMcpServerStates().find(server => server.id === connection.serverId)).toMatchObject({ connected: false, toolCount: 0 });
      expect(connection.toolIds.every(id => !toolRegistry.getById(id))).toBe(true);
      await expect(connection.close()).resolves.toBeUndefined();
      expect(closeClient).toHaveBeenCalledTimes(2); expect(closeTransport).toHaveBeenCalledTimes(2);
      expect(getMcpServerStates().some(server => server.id === connection.serverId)).toBe(false);
      await expect(fetch(connection.url)).rejects.toThrow();
    } finally {
      // The pre-fix cached rejection must not prevent test-owned resource cleanup.
      const index = connections.indexOf(connection); if (index >= 0) connections.splice(index, 1);
      if (getMcpServerStates().some(server => server.id === connection.serverId)) await disconnectMcpServer(connection.serverId);
    }
  });

  it.each(["journal", "lease"] as const)("refuses runtime %s loss before creating a listener or registry entries", async target => {
    const { simulation, session, context } = setup();
    simulation.confirm(session, simulation.preview(session, "light", { type: "power", on: true }).id);
    const directory = path.join(context.stateRoot, "device-simulation");
    const damaged = path.join(directory, target === "journal" ? "journal.json" : "session.lock");
    const original = fs.readFileSync(damaged); const hostile = target === "journal" ? "not-json" : "foreign-owner";
    const before = getMcpServerStates(); const created = vi.spyOn(http, "createServer");
    fs.writeFileSync(damaged, hostile);
    try {
      const opening = openFixtureMcp(simulation, session).then(connection => { connections.push(connection); return connection; });
      await expect(opening).rejects.toThrow(target === "journal" ? "E_SIM_JOURNAL_INVALID" : "E_SIM_BUSY");
      expect(created).not.toHaveBeenCalled(); expect(getMcpServerStates()).toEqual(before);
      expect(fs.readFileSync(damaged, "utf8")).toBe(hostile);
    } finally { fs.writeFileSync(damaged, original); }
  });

  it.each([null, undefined])("returns a fixed provider error for a non-Error rejection %j", async failure => {
    const { simulation, session } = setup(); const connection = await connect(simulation, session);
    vi.spyOn(simulation, "handleMcp").mockImplementationOnce(() => { throw failure; });
    await expect(tool(connection, "read").execute({ deviceId: "light" })).rejects.toThrow("E_SIM_PROVIDER");
    expect(JSON.parse(await tool(connection, "read").execute({ deviceId: "light" }))).toMatchObject({ revision: 0, power: false });
  });

  it("refuses a missing durable journal before creating a listener or registry entries", async () => {
    const { simulation, session, context } = setup();
    simulation.confirm(session, simulation.preview(session, "light", { type: "power", on: true }).id);
    const file = path.join(context.stateRoot, "device-simulation", "journal.json");
    const original = fs.readFileSync(file); fs.renameSync(file, file + ".moved");
    const before = getMcpServerStates(); const created = vi.spyOn(http, "createServer");
    try {
      const opening = openFixtureMcp(simulation, session).then(connection => { connections.push(connection); return connection; });
      await expect(opening).rejects.toThrow("E_SIM_JOURNAL_INVALID");
      expect(created).not.toHaveBeenCalled(); expect(getMcpServerStates()).toEqual(before);
      expect(fs.existsSync(file)).toBe(false); expect(fs.readFileSync(file + ".moved")).toEqual(original);
    } finally { fs.copyFileSync(file + ".moved", file); }
  });
});
