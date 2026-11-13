import { beforeEach, expect, it, vi } from "vitest";
const enumerate = vi.hoisted(() => vi.fn(() => { throw new Error("INTERFACE_ENUMERATION_DENIED"); }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), networkInterfaces: enumerate }));
import { resolveOneBotListenHost } from "./onebot-reverse-ws";
beforeEach(() => { enumerate.mockClear(); });
it("resolves explicit loopback without requesting unrelated interface access", () => {
  expect(resolveOneBotListenHost("loopback")).toEqual({ host: "127.0.0.1", resolvedMode: "loopback" });
  expect(enumerate).not.toHaveBeenCalled();
});
it("resolves a custom host without enumerating interfaces", () => {
  expect(resolveOneBotListenHost("custom", "127.0.0.1")).toEqual({ host: "127.0.0.1", resolvedMode: "custom" });
  expect(enumerate).not.toHaveBeenCalled();
});
it("preserves discovery failure for auto and WSL modes without a silent fallback", () => {
  expect(() => resolveOneBotListenHost("auto")).toThrow("INTERFACE_ENUMERATION_DENIED");
  expect(() => resolveOneBotListenHost("wsl")).toThrow("INTERFACE_ENUMERATION_DENIED");
});
