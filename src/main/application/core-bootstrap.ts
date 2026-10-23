/**
 * Core 阶段：搭出让聊天可用的最小核心。
 * 依赖顺序固定：迁移、技能、低成本服务、沙箱、计划模式、工具、
 * RAG（可降级）、Agent Runtime、channels 与 scheduler（只装配不启动）、
 * 渲染进程会调用的全部 IPC、加载聊天页面、桌宠与辅助窗口、core-ready、
 * reveal，最后放行激活代理。
 * 技能、RAG、沙箱失败仅记为降级；聊天页面加载失败属于致命错误，直接抛出。
 */

import type { IpcScope } from "./ipc-scope";
import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker } from "./window-activation";
import type { ShellResult } from "./shell-bootstrap";
import type { RevealStartupWindowsOptions } from "../startup/startup-window-reveal";
import type { AgentRuntime } from "../orchestrator/agent-runtime";

import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import type { GitService } from "../code-git/git-service";
import type { LspManager } from "../lsp/manager";
import type { ScreenshotService } from "../screenshot/screenshot-lifecycle";
import type { MusicBootstrap } from "../music/bootstrap";
import type { AppUpdateService } from "../updater/app-update-service";
import type { LlmClient } from "../services/llm/llm-client";
import type { SocialContextService } from "../services/social-context/social-context-service";
import type { ChannelsSubsystem } from "../channels/bootstrap";
import type { SchedulerSubsystem } from "../scheduler/bootstrap";
import type { GeneralSettings } from "../settings/general-settings";
import type { WindowManager } from "../windows/window-manager";
import type { PluginManager } from "../../plugins/manager";

export interface CoreServices {
  update: AppUpdateService;
  music: MusicBootstrap;
  screenshot: ScreenshotService;
  lsp: LspManager;
  git: GitService;
  proactive: ProactiveLifecycle;
  embedding: EmbeddingIndexService;
  social: SocialContextService;
  llm: LlmClient;
}

export interface CoreResult {
  scheduler: SchedulerSubsystem;
  plugins: PluginManager;
  channels: ChannelsSubsystem;
  services: CoreServices;
  runtime: AgentRuntime;
}

export interface RegisterCoreIpcInput {
  scheduler: SchedulerSubsystem;
  channels: ChannelsSubsystem;
  services: CoreServices;
  runtime: AgentRuntime;
  ipc: IpcScope;
}

export interface CoreDependencies {
  markStartupWindowsReady(): void;
  minimumSplashMs: number;
  revealStartupWindows(input: RevealStartupWindowsOptions): Promise<void>;
  applyGeneralSettings(settings: GeneralSettings, services: CoreServices): void;
  loadGeneralSettings(): GeneralSettings;
  wireToastCenter(input: { ipc: IpcScope; windowManager: WindowManager }): void;
  registerCoreIpc(input: RegisterCoreIpcInput): void;
  createScheduler(runtime: AgentRuntime, services: CoreServices): SchedulerSubsystem;
  startPlugins(services: CoreServices, scheduler: SchedulerSubsystem, runtime: AgentRuntime): Promise<PluginManager>;
  createChannels(runtime: AgentRuntime, services: CoreServices): ChannelsSubsystem;
  createRuntime(services: CoreServices): AgentRuntime;
  initRag(): Promise<void>;
  registerAllTools(services: CoreServices): void;
  initPlanMode(): void;
  initSandbox(): void | Promise<void>;
  createLowCostServices(): CoreServices;
  initSkills(): void | Promise<void>;
  migrateStagedExternalContent(): void;
  shutdown: ShutdownCoordinator;
  activation: WindowActivationBroker;
  readiness: StartupReadiness;
  shell: ShellResult;
}

// 启动耗时埋点，输出各步骤用时与结束时刻（相对进程启动）
async function timed<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  const began = performance.now();
  try {
    return await work();
  } finally {
    const ended = performance.now();
    console.log(`[StartupTiming] core/${name} ${Math.round(ended - began)}ms (at ${Math.round(ended)}ms)`);
  }
}

export async function startCore(deps: CoreDependencies): Promise<CoreResult> {
  const { shell, readiness, activation, shutdown } = deps;
  const { windowManager, ipc } = shell;

  // 可降级的步骤：失败写日志并登记降级，然后继续往下走
  const softStep = async (
    name: string,
    capability: string,
    logLabel: string,
    work: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await timed(name, work);
    } catch (error) {
      console.error(logLabel, error);
      readiness.markDegraded({
        capability,
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
        error,
      });
    }
  };

  // 必须早于任何 prompts/skills 的读取
  deps.migrateStagedExternalContent();

  await softStep("initSkills", "skills", "[Core] initSkills failed:", () => deps.initSkills());

  const services = deps.createLowCostServices();

  await softStep("initSandbox", "sandbox", "[Core] initSandbox failed at startup:", () => deps.initSandbox());

  deps.initPlanMode();
  deps.registerAllTools(services);

  await softStep("initRag", "rag", "[Core] RAG init FAILED:", () => deps.initRag());

  const runtime = deps.createRuntime(services);

  // channels：只装配并同步注册内置适配器，联网启动留给 background
  const channels = deps.createChannels(runtime, services);
  await timed("channels-adapters", async () => {
    channels.initialize();
    await channels.adaptersRegistered;
  });

  // scheduler 先加载 store 再启动插件：插件的调度服务写入已加载的 store，
  // 不会覆盖磁盘上的任务，插件启停的联动也在此接好
  const scheduler = deps.createScheduler(runtime, services);
  scheduler.initialize();

  // 插件必须晚于内置适配器的 id 预留，避免抢占 feishu/wechat/qq 等
  const plugins = await timed("startPlugins", () => deps.startPlugins(services, scheduler, runtime));

  // 渲染进程可能调用的 IPC 必须在 chat.load() 之前全部就位
  deps.registerCoreIpc({ ipc, runtime, services, channels, scheduler });

  // 提醒中心：IPC 要先于 toast 窗口预加载注册（页面一加载就可能 invoke getAll）
  deps.wireToastCenter({ ipc, windowManager });

  // 聊天页面加载失败是致命的，让异常向上传
  await timed("chat-load", () => shell.chat.load());

  // 桌宠窗口始终创建，petVisible 只决定是否显示，这样托盘和设置开关
  // 随时能把它找回来，置顶、缩放、live2d 生命周期在隐藏时也已接线。
  const settings = deps.loadGeneralSettings();
  // 此时桌宠尚未创建，登录项等设置先一次性应用，显示/隐藏为空操作
  deps.applyGeneralSettings(settings, services);
  // showOnReady 取 petVisible：页面就绪后才显示，避免空白窗口闪现
  windowManager.createPetWindow(settings.petVisible);
  windowManager.onPetWindowReady((win) => {
    shell.live2dWindowLifecycle.attach(win);
  });
  windowManager.onPetWindowClosed(() => {
    shell.live2dWindowLifecycle.clear();
  });
  windowManager.setPetWindowAlwaysOnTop(settings.petAlwaysOnTop);
  windowManager.applyPetWindowZoom(settings.petZoom);
  // 旧的侧栏偏好不再单独创建状态窗口

  // 核心资源的退出清理；scheduler、proactive、更新定时器由 background 登记
  type Phase = Parameters<ShutdownCoordinator["register"]>[0]["phase"];
  const cleanups: Array<[string, Phase, () => Promise<unknown>]> = [
    ["plugins", "stopActiveWork", () => plugins.stop()],
    ["channels", "stopExternalConsumers", () => channels.shutdown()],
    ["screenshot", "stopLocalResources", () => services.screenshot.shutdown()],
    ["lsp", "stopLocalResources", () => services.lsp.disposeAll()],
    ["git", "stopLocalResources", () => services.git.dispose()],
    ["music", "stopLocalResources", () => services.music.shutdown()],
  ];
  for (const [id, phase, stop] of cleanups) {
    shutdown.register({
      id,
      phase,
      dispose: async () => {
        await stop();
      },
    });
  }

  readiness.transition("core-ready");

  // 等够 Loading 的最短展示时间，再关闭它、显示聊天、放行辅助窗口
  await deps.revealStartupWindows({
    splashWindow: shell.splashWindow,
    chatWindow: shell.chat.window,
    loadingShownAt: shell.loadingShownAt,
    minimumDurationMs: deps.minimumSplashMs,
  });
  // 窗口已可见：此后才结束的后台任务都属于“窗口出现后仍在运行”
  console.log(`[StartupTiming] core/windows-revealed (at ${Math.round(performance.now())}ms)`);
  deps.markStartupWindowsReady();

  // 主窗口可以激活了：处理启动期间排队的请求
  await activation.markReady();
  console.log(`[StartupTiming] core/startCore-total ${Math.round(performance.now())}ms`);

  return { runtime, services, channels, plugins, scheduler };
}
