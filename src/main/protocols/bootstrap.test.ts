import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  schemes: [] as Array<{ scheme: string }>,
  handlers: new Map<string, (request: { url: string }) => Response | Promise<Response>>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "UNUSED_FIXTURE_ROOT" },
  protocol: {
    registerSchemesAsPrivileged: (schemes: Array<{ scheme: string }>) => { mock.schemes = schemes; },
    handle: (scheme: string, handler: (request: { url: string }) => Response | Promise<Response>) => {
      mock.handlers.set(scheme, handler);
    },
  },
  net: { fetch: () => { throw new Error("Invalid URLs must not read disk"); } },
}));
import { registerPrivilegedSchemes, registerProtocolHandlers } from "./bootstrap";

beforeEach(() => { mock.schemes = []; mock.handlers.clear(); });

it("registers shared sticker and font protocols without a Moments media handler", async () => {
  registerPrivilegedSchemes();
  registerProtocolHandlers();
  expect(mock.schemes.map(entry => entry.scheme)).toEqual(["local-sticker", "local-font"]);
  expect([...mock.handlers.keys()]).toEqual(["local-sticker", "local-font"]);
  expect((await mock.handlers.get("local-sticker")!({ url: "invalid" })).status).toBe(404);
  expect((await mock.handlers.get("local-font")!({ url: "invalid" })).status).toBe(404);
});
