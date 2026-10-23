/** 第三方清理钩子的统一超时，资源跟踪器与插件管理器共用。 */
export const PLUGIN_CLEANUP_TIMEOUT_MS = 5_000;

/** 执行一次第三方清理；超时则抛错，框架得以继续回收其余资源。 */
export async function runPluginCleanup(cleanup: () => void | Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 清理函数要在调用方当前这一轮就同步开始执行，所以先调用再竞速
    const running = Promise.resolve(cleanup());
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} 清理超时（${PLUGIN_CLEANUP_TIMEOUT_MS}ms）`)),
        PLUGIN_CLEANUP_TIMEOUT_MS,
      );
    });
    await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
