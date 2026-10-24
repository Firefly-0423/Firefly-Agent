/**
 * 插件资源跟踪器。
 *
 * PluginContext 登记的所有临时宿主资源（工具、渠道、IPC、事件订阅、提示词
 * Provider、onDispose 回调，以及将来的语音租约等）都进同一个跟踪器，
 * 共用一套停止、回滚与逆序清理路径：
 *
 * - dispose() 按登记顺序的逆序清理；
 * - 每项清理最多执行一次（手动注销与 dispose 互斥）；
 * - 单项清理超时或出错只记日志，不影响其余资源；
 * - 停止后拒绝再登记新资源。
 *
 * 持久化资源（如插件创建的调度任务）不是临时句柄，不在此登记，
 * 它们的生命周期由所有权字段和卸载流程负责。
 */
import { runPluginCleanup } from "./cleanup";

export type PluginResourceCleanup = () => void | Promise<void>;

export type PluginResourceTracker = {
  /** 按登记的逆序释放剩余全部资源；重复调用返回同一个任务。 */
  dispose(): Promise<void>;
  /** 指定资源当前是否仍在登记中。 */
  has(kind: string, key: string): boolean;
  /** 只移除登记、不执行清理（调用方已自行清理时使用）。 */
  forget(kind: string, key: string): boolean;
  /** 手动注销：执行清理并移除登记；未登记则返回 false。 */
  release(kind: string, key: string): Promise<boolean>;
  /** 登记资源；kind 用于诊断归类，同一 kind 内 key 必须唯一。 */
  track(kind: string, key: string, cleanup: PluginResourceCleanup): void;
};

type TrackedResource = {
  released: boolean;
  cleanup: PluginResourceCleanup;
  key: string;
  kind: string;
};

export function createPluginResourceTracker(
  /** 单项资源清理失败或超时时的上报出口。 */
  onResourceError: (kind: string, key: string, error: unknown) => void = (kind, key, error) => {
    console.warn(`[plugin-resource] 清理 ${kind}:${key} 失败`, error);
  },
): PluginResourceTracker {
  const registry: TrackedResource[] = [];
  let stopped = false;
  // 同一次释放只做一份，免得异步清理让出事件循环时被重复进入
  let disposing: Promise<void> | undefined;

  const lookup = (kind: string, key: string): TrackedResource | undefined =>
    registry.find((r) => r.kind === kind && r.key === key);

  const unlist = (resource: TrackedResource): boolean => {
    const at = registry.indexOf(resource);
    if (at === -1) return false;
    registry.splice(at, 1);
    return true;
  };

  const cleanOnce = async (resource: TrackedResource): Promise<void> => {
    if (resource.released) return;
    resource.released = true;
    // 标签只带 kind，统一告警里按资源类别就能定位
    await runPluginCleanup(resource.cleanup, `插件资源 ${resource.kind}`);
  };

  const track: PluginResourceTracker["track"] = (kind, key, cleanup) => {
    if (typeof cleanup !== "function") throw new Error("插件资源清理函数必须是函数");
    if (stopped) throw new Error("插件停止后不能再登记资源");
    if (lookup(kind, key)) throw new Error(`插件资源已登记: ${kind}:${key}`);
    registry.push({ kind, key, cleanup, released: false });
  };

  const release: PluginResourceTracker["release"] = async (kind, key) => {
    const resource = lookup(kind, key);
    if (!resource || resource.released) return false;
    try {
      await cleanOnce(resource);
    } finally {
      unlist(resource);
    }
    return true;
  };

  const forget: PluginResourceTracker["forget"] = (kind, key) => {
    const resource = lookup(kind, key);
    return resource ? (unlist(resource), true) : false;
  };

  const has: PluginResourceTracker["has"] = (kind, key) => {
    const resource = lookup(kind, key);
    return resource !== undefined && !resource.released;
  };

  const dispose: PluginResourceTracker["dispose"] = () => {
    disposing ??= (async () => {
      stopped = true;
      for (const resource of registry.splice(0).reverse()) {
        try {
          await cleanOnce(resource);
        } catch (error) {
          onResourceError(resource.kind, resource.key, error);
        }
      }
    })();
    return disposing;
  };

  return { track, release, forget, has, dispose };
}

export { PLUGIN_CLEANUP_TIMEOUT_MS, runPluginCleanup } from "./cleanup";
