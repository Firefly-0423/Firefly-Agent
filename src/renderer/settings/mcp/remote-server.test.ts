import { describe, expect, it } from "vitest";
import { remoteServer } from "./remote-server";

describe("remote MCP server address", () => {
  it("treats an http(s) address as a Streamable HTTP server", () => {
    expect(remoteServer("https://mcp.example.com/mcp")).toEqual({ transport: "http", url: "https://mcp.example.com/mcp" });
    expect(remoteServer("  http://127.0.0.1:8931/mcp?key=1  ")).toEqual({ transport: "http", url: "http://127.0.0.1:8931/mcp?key=1" });
  });

  it("keeps the legacy SSE transport for an address ending in /sse", () => {
    expect(remoteServer("https://mcp.example.com/sse")).toEqual({ transport: "sse", url: "https://mcp.example.com/sse" });
    expect(remoteServer("https://mcp.example.com/v1/sse/")).toEqual({ transport: "sse", url: "https://mcp.example.com/v1/sse/" });
  });

  it("leaves commands, other schemes and addresses the host would refuse to the command path", () => {
    expect(remoteServer("node server.js")).toBeNull();
    expect(remoteServer("npx -y @playwright/mcp")).toBeNull();
    expect(remoteServer("ws://mcp.example.com/mcp")).toBeNull();
    expect(remoteServer("https://user:secret@mcp.example.com/mcp")).toBeNull();
    expect(remoteServer("https://mcp.example.com/mcp#token")).toBeNull();
  });
});
