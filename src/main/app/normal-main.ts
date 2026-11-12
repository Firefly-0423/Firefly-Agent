/** 主进程启动入口：准备 Electron 环境，再委托 Application 管理各启动阶段。 */

import "./identity-preflight";
import { app } from "electron";
import { createApplication } from "./application";
import { createDefaultApplicationDependencies } from "./default-dependencies";
import { registerPluginPanelScheme } from "../features/plugins/panel/plugin-panel-protocol";
import { installGlobalNavigationGuard } from "../platform/windows/external-link";
import { initializeMainFileLogging, logger, LogTag } from "../base/logging/logger";

// 打包应用可能没有可用的输出管道；其他流错误仍需向外抛出。
function handleOutputError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
}
for (const output of [process.stdout, process.stderr]) output?.on?.("error", handleOutputError);

initializeMainFileLogging();

// 插件设置面板协议：scheme 特权必须在 app.ready 之前注册（Electron 硬性要求）
registerPluginPanelScheme();

// 全局导航兜底：阻止任何窗口的页面内导航（含拖放文件跳转 file://），
// http(s) 外链转交系统浏览器。必须在任何窗口创建之前注册。
installGlobalNavigationGuard();

// Host/Main launch configuration only; no renderer IPC or periodic execution.
const presenceOnceRequested = process.env.FIREFLY_HISTORY_PRESENCE_ONCE === "1";
const presenceHelper = process.env.FIREFLY_HISTORY_PRESENCE_HELPER;
async function runHistoryPresenceOnce(): Promise<void> {
  if (!presenceHelper) {
    logger.warn(LogTag.Runtime, "history presence once", { status: "not-measured", reason: "helper-not-configured" });
    return;
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  app.once("before-quit", cancel);
  try {
    const { selectCachedHistoryCoverage, measureHistoryPresence } = await import("../memory/sources/native-history-coverage");
    const { createNativeHistoryPresenceEndpoint } = await import("../memory/sources/native-history-presence-process");
    const result = await measureHistoryPresence(selectCachedHistoryCoverage(), createNativeHistoryPresenceEndpoint(presenceHelper), { signal: controller.signal });
    logger.warn(LogTag.Runtime, "history presence once", result);
  } catch {
    logger.warn(LogTag.Runtime, "history presence once", { status: "not-measured", reason: "measurement-failed" });
  } finally { app.removeListener("before-quit", cancel); }
}

const application = createApplication(createDefaultApplicationDependencies());

application.installLifecycleHandlers();
application.prepareBeforeReady();

if (application.isPrimaryProcess()) {
  void app.whenReady()
    .then(async () => {
      await application.start();
      if (presenceOnceRequested) await runHistoryPresenceOnce();
    })
    .catch((error) => application.handleFatalStartup(error));
}
