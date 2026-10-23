// 连接手机页的纯视图模型：只做数据到展示决策的映射，不碰 DOM、不发 IPC，便于单测。

/** 渠道卡片的 id 后缀（与 index.html 中 channels-<id>-card 对应）。 */
export const CHANNEL_CARD_IDS = ["wechat", "feishu", "qq", "qqbot"] as const;
export type ChannelCardId = (typeof CHANNEL_CARD_IDS)[number];

export interface ChannelStatusLike {
  phase?: string;
}

export type ChannelStatusMap = Partial<Record<string, ChannelStatusLike | undefined>>;

export interface ChannelOverview {
  /** 运行中的渠道数（phase === "running"）。 */
  running: number;
  /** 本页可管理的渠道总数。 */
  total: number;
}

/** 概览卡片的计数：只统计本页四张渠道卡，App 接入位不计入。 */
export function summarizeChannelOverview(statuses: ChannelStatusMap): ChannelOverview {
  const running = CHANNEL_CARD_IDS.filter((id) => statuses[id]?.phase === "running").length;
  return { running, total: CHANNEL_CARD_IDS.length };
}

/**
 * 初次进入页面时默认展开的渠道：只展开第一张「已连接或正在配对」的卡片，其余收起。
 * 没有符合条件的渠道时返回 null，所有卡片保持收起。
 */
export function pickInitiallyExpandedChannel(statuses: ChannelStatusMap): ChannelCardId | null {
  return (
    CHANNEL_CARD_IDS.find((id) => {
      const phase = statuses[id]?.phase;
      return phase === "running" || phase === "starting";
    }) ?? null
  );
}

/** Firefly 手机 App 接入位的状态。目前只有「即将推出」一种。 */
export type AppChannelStatus = "coming-soon";

/**
 * 将来由 App 配对服务提供的状态（已配对 / 在线等）。
 * 目前没有任何真实来源，调用方不传参数。
 */
export interface AppChannelState {
  paired?: boolean;
  online?: boolean;
}

export interface AppChannelCardView {
  status: AppChannelStatus;
  statusKey: string;
  pairDisabled: boolean;
}

/**
 * Firefly 手机 App 接入位的视图模型。
 *
 * 当前恒返回 coming-soon：App 配对服务尚未建立，本页不发起任何配对流程、不新增 IPC。
 * 将来接入配对服务时，由它提供 state，在这里映射为对应的视图状态，
 * 届时再放开「开始配对」按钮并切换 statusKey。
 */
export function getAppChannelCard(_state?: AppChannelState): AppChannelCardView {
  return {
    status: "coming-soon",
    statusKey: "settings.panel.channels.appStatusComingSoon",
    pairDisabled: true,
  };
}
