import type { ProactiveDeliveryTarget } from "./preferences";

export type ProactiveChannelStatusLike = { phase?: string };

/** 本地投递永远可选，其它渠道必须处于 running */
export const isProactiveDeliveryTargetSelectable = (
  target: ProactiveDeliveryTarget,
  status?: ProactiveChannelStatusLike,
): boolean => target === "local" || status?.phase === "running";
