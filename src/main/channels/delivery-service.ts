import type { ChannelManager } from "./manager";
import type { OutgoingMessage } from "./types";

export type DeliveryResult = { ok: true } | { ok: false; error: string };
export interface ChannelDeliveryService {
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}

export function createChannelDeliveryService(manager: Pick<ChannelManager, "getAdapter">): ChannelDeliveryService {
  return {
    async send(message) {
      const destination = manager.getAdapter(message.channel);
      if (!destination) return { ok: false, error: "adapter_not_found" };
      try {
        const receipt = await destination.send(message);
        return receipt.ok ? { ok: true } : { ok: false, error: receipt.error || "send_failed" };
      } catch (failure) {
        return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
      }
    },
  };
}
