import type { ProactiveDeliveryTarget } from "../../shared/preferences";
import type { ProactiveMobileChannel } from "../channels/proactive-delivery";
import type { ProactiveCommitResult } from "./proactive-service";

type RoutingHandlers = {
  commitChannel: (channel: ProactiveMobileChannel) => Promise<ProactiveCommitResult>;
  commitLocal: () => Promise<ProactiveCommitResult>;
};

/** 按投递目标分派：本地直接提交；渠道目标交给对应移动端通道。 */
export function routeProactiveDelivery(
  target: ProactiveDeliveryTarget,
  handlers: RoutingHandlers,
): Promise<ProactiveCommitResult> {
  if (target !== "local") {
    return handlers.commitChannel(target);
  }
  return handlers.commitLocal();
}
