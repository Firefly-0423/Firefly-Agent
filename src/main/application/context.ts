// 运行期上下文快照：由编排器在全部阶段成功后创建并独占持有。
// 其他启动模块只能使用各自的窄接口，不要引用这个类型，防止演变为服务定位器。

import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker } from "./window-activation";
import type { ShellResult } from "./shell-bootstrap";
import type { CoreResult } from "./core-bootstrap";
import type { BackgroundHandle } from "./background";

export interface ApplicationContext {
  background: BackgroundHandle;
  core: CoreResult;
  shell: ShellResult;
  shutdown: ShutdownCoordinator;
  activation: WindowActivationBroker;
  readiness: StartupReadiness;
}
