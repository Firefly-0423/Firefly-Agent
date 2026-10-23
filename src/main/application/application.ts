/**
 * 应用编排门面：按 shell、core、background 的次序推进启动，
 * 只有这里才会拿到完整的 ApplicationContext。
 * 启动期的致命错误统一从 handleFatalStartup 出去：
 * 标记 failed、写日志、关掉 Loading、弹错误框，最后走受控退出。
 */

import type { App } from "electron";
import { installAppShutdownHandlers } from "./electron-lifecycle";
import type { ApplicationContext } from "./context";
import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker } from "./window-activation";
import type { PreReadyResult } from "./pre-ready";
import type { ShellResult } from "./shell-bootstrap";
import type { CoreResult } from "./core-bootstrap";
import type { BackgroundHandle } from "./background";

export interface ApplicationDependencies {
  logFatal(error: unknown): void;
  startBackground(core: CoreResult): BackgroundHandle;
  startCore(shell: ShellResult): Promise<CoreResult>;
  startShell(): Promise<ShellResult>;
  prepare(): PreReadyResult;
  shutdown: ShutdownCoordinator;
  activation: WindowActivationBroker;
  readiness: StartupReadiness;
  dialog: { showErrorBox(title: string, content: string): void };
  app: Pick<App, "whenReady" | "quit" | "on" | "removeListener">;
}

export interface Application {
  handleFatalStartup(error: unknown): Promise<void>;
  installLifecycleHandlers(): void;
  start(): Promise<void>;
  isPrimaryProcess(): boolean;
  prepareBeforeReady(): void;
}

// 仍可迁移到 failed 的阶段
const CAN_FAIL_FROM = new Set<string>(["preparing", "shell-ready", "core-ready", "background-starting"]);

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.message}\n\n${error.stack ?? ""}`;
}

export function createApplication(deps: ApplicationDependencies): Application {
  const { readiness, activation, shutdown } = deps;
  const held: {
    pre: PreReadyResult | null;
    shell: ShellResult | null;
    context: ApplicationContext | null;
    fatalDone: boolean;
  } = { pre: null, shell: null, context: null, fatalDone: false };

  return {
    prepareBeforeReady() {
      held.pre = deps.prepare();
    },

    isPrimaryProcess() {
      return held.pre?.isPrimaryProcess ?? false;
    },

    async start() {
      const shell = await deps.startShell();
      held.shell = shell;
      const core = await deps.startCore(shell);
      readiness.transition("background-starting");
      const background = deps.startBackground(core);
      held.context = { readiness, activation, shutdown, shell, core, background };
      await background.settled;
    },

    installLifecycleHandlers() {
      // before-quit 作为兜底：首次触发即转入受控退出
      installAppShutdownHandlers({ app: deps.app, coordinator: shutdown });
      // 关闭所有窗口不退出，托盘继续驻留
      deps.app.on("window-all-closed", () => {});
      // macOS 的 activate 同样交给激活代理
      deps.app.on("activate", () => {
        activation.request({ kind: "chat" });
      });
    },

    async handleFatalStartup(error) {
      if (held.fatalDone) return;
      held.fatalDone = true;

      if (CAN_FAIL_FROM.has(readiness.getPhase())) {
        try {
          readiness.transition("failed");
        } catch (transitionError) {
          deps.logFatal(transitionError);
        }
      }
      deps.logFatal(error);

      const splash = held.context?.shell.splashWindow ?? held.shell?.splashWindow;
      if (splash && !splash.isDestroyed()) {
        try {
          splash.close();
        } catch {
          // 关闭失败不影响后续退出
        }
      }

      const message = describeError(error);
      try {
        deps.dialog.showErrorBox("流萤启动失败", message);
      } catch (dialogError) {
        deps.logFatal(dialogError);
      }

      await shutdown.requestControlledShutdown({
        reason: "startup-fatal",
        finalAction: () => deps.app.quit(),
      });
    },
  };
}
