import { describe, expect, it } from "vitest";
import { classifyMcpFailure, MCP_FAILURE_REASONS } from "./mcp-failure";

const coded = (code: string, message = "") => Object.assign(new Error(message), { code });

describe("MCP connection failure reasons", () => {
  it.each([
    ["a missing program", coded("ENOENT", "spawn npx ENOENT"), "command-not-found"],
    ["a missing program reported only in text", new Error("'foo' is not recognized as an internal or external command"), "command-not-found"],
    ["a program that cannot be run", coded("EACCES", "spawn ./server EACCES"), "permission-denied"],
    ["a request timeout", Object.assign(new Error("Request timed out"), { code: -32001 }), "timeout"],
    ["a network timeout", coded("ETIMEDOUT"), "timeout"],
    ["a refused connection", coded("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1"), "unreachable"],
    ["an unknown host nested in the cause", Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }), "unreachable"],
    ["a server that exits at once", Object.assign(new Error("MCP error -32000: Connection closed"), { code: -32000 }), "exited"],
    ["anything else", new Error("something odd"), "failed"],
    ["a thrown string", "boom", "failed"],
    ["HTTP unauthorized", Object.assign(new Error("private diagnostic"), { status: 401 }), "permission-denied"],
    ["HTTP forbidden", Object.assign(new Error("private diagnostic"), { statusCode: 403 }), "permission-denied"],
    ["SSE unauthorized", Object.assign(new Error("private diagnostic"), { code: 401 }), "permission-denied"],
    ["SDK unauthorized", Object.assign(new Error("private diagnostic"), { name: "UnauthorizedError" }), "permission-denied"],
    ["null", null, "failed"],
  ] as const)("%s", (_label, error, expected) => expect(classifyMcpFailure(error)).toBe(expected));

  it("only ever returns a fixed reason, never the error text", () => {
    const reason = classifyMcpFailure(new Error("TOKEN=synthetic-private-value --api-key sk-live-1"));
    expect(MCP_FAILURE_REASONS).toContain(reason);
    expect(reason).not.toContain("synthetic");
  });
});
