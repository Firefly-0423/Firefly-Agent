import { afterEach, expect, it, vi } from "vitest";
vi.mock("./settings-store", () => ({ loadChannelsSettings: () => ({ sharedSecret: "public-test-secret", inboundPort: 0 }), saveChannelsSettings: vi.fn() }));
vi.mock("./manager", () => ({ channelManager: { listChannels: () => [] } }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: {} }));
import { startInboundServer, stopInboundServer } from "./inbound-server";
afterEach(stopInboundServer);
it("accepts only the Firefly secret header without weakening secret checks", async () => {
  const server = await startInboundServer();
  const request = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/channels/feishu/inbound`, { method: "POST", headers });
  expect((await request({ "x-firefly-channel-secret": "wrong" })).status).toBe(401);
  expect((await request({ "x-firefly-channel-secret": "public-test-secret" })).status).toBe(404);
});
