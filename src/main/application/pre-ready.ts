// app ready 之前必须完成的同步配置。
// 约束：保持轻量、同步，不构造业务服务；拿不到单实例锁时通知入口退出。

import type { WindowActivationBroker } from "./window-activation";

export interface PreReadyDependencies {
  /** 二次启动时走激活代理，按 chat 请求处理 */
  activation: Pick<WindowActivationBroker, "request">;
  ensureGpuSandboxAcl(): void;
  registerPrivilegedSchemes(): void;
  installSingleInstance(onSecondInstance: () => void): boolean;
  configureDocumentIndex(): void;
}

export interface PreReadyResult {
  isPrimaryProcess: boolean;
}

export function prepareBeforeReady(deps: PreReadyDependencies): PreReadyResult {
  const { activation } = deps;
  deps.configureDocumentIndex();

  const gotLock = deps.installSingleInstance(() => activation.request({ kind: "chat" }));
  if (!gotLock) return { isPrimaryProcess: false };

  deps.registerPrivilegedSchemes();
  deps.ensureGpuSandboxAcl();
  return { isPrimaryProcess: true };
}
