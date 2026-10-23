import type { WindowActivationRequest } from "../application/window-activation";

export interface PrimaryWindowActions {
  /** 所有窗口激活都经由 activation request 下发，本模块不自行建窗。 */
  requestActivation(request: WindowActivationRequest): void;
}

/**
 * 打开主窗口（聊天窗口）：只投递一个 chat 激活请求。
 * 桌宠不响应这类通用激活，其显隐仍由设置与托盘切换路径负责。
 */
export function openPrimaryWindow(actions: PrimaryWindowActions): void {
  const request: WindowActivationRequest = { kind: "chat" };
  actions.requestActivation(request);
}
