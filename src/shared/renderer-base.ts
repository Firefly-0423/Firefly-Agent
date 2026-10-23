/**
 * 渲染端静态资源路径工具。
 *
 * 背景：vite 的 base 为 './'，Electron 用 loadFile 以 file:// 打开页面时，
 * fetch("/models/...") 会解析到磁盘根目录而不是 dist/renderer/。
 * 做法：用 document.baseURI 结合 import.meta.env.BASE_URL 求出渲染根目录，
 * 再拼接资源路径，开发模式与子目录窗口都能得到正确地址。
 */

// 生产环境下位于子目录的窗口，其根需要再向上退一级
const NESTED_WINDOW_DIRS = ["react/", "sidebar/", "tasks/", "settings/", "call/", "sticker-manager/"];

let memoizedRoot: string | undefined;

function locateRendererRoot(): string {
  const viteBase = import.meta.env.BASE_URL; // 开发 "/"，生产 "./"
  const resolved = new URL(viteBase, document.baseURI).href;
  if (viteBase !== "./") return resolved;

  const nested = NESTED_WINDOW_DIRS.some((dir) => resolved.endsWith(`/${dir}`));
  // 去掉最后一级目录
  return nested ? resolved.replace(/[^/]+\/$/, "") : resolved;
}

/** 渲染根目录的 URL（以 / 结尾），首次计算后缓存 */
export function getRendererBase(): string {
  if (!memoizedRoot) memoizedRoot = locateRendererRoot();
  return memoizedRoot;
}

/** 把 "models/x.json" 或 "/models/x.json" 解析成完整的 file:// 或 http:// URL */
export function resolveAsset(assetPath: string): string {
  return getRendererBase() + assetPath.replace(/^\/+/, "");
}
