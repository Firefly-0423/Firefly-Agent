import { it, expect, vi } from "vitest";
import { createChannelDeliveryService } from "./delivery-service";
import type { OutgoingMessage } from "./types";

const outgoing: OutgoingMessage = { channel: "qq", targetId: "recipient-23", parts: [{ kind: "text", text: "Delivery receipt" }] };

it("returns the missing adapter diagnostic before attempting a send", async () => {
  const getAdapter = vi.fn(() => undefined);
  expect(await createChannelDeliveryService({ getAdapter }).send(outgoing))
    .toStrictEqual({ error: "adapter_not_found", ok: false });
  expect(getAdapter).toHaveBeenCalledWith("qq");
});

it.each([
  [{ ok: true }, { ok: true }],
  [{ ok: false }, { ok: false, error: "send_failed" }],
  [{ ok: false, error: "quota_reached" }, { ok: false, error: "quota_reached" }],
])("normalizes adapter response %j", async (reply, expected) => {
  const send = vi.fn().mockResolvedValue(reply);
  const service = createChannelDeliveryService({ getAdapter: () => ({ send }) as never });
  expect(await service.send(outgoing)).toStrictEqual(expected);
  expect(send).toHaveBeenCalledExactlyOnceWith(outgoing);
});

it("turns thrown adapter errors into delivery failures", async () => {
  const service = createChannelDeliveryService({
    getAdapter: () => ({ send: vi.fn().mockRejectedValue(new Error("connection closed")) }) as never,
  });
  expect(await service.send(outgoing)).toStrictEqual({ error: "connection closed", ok: false });
});
