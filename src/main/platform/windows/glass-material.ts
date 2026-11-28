// 设置窗口的毛玻璃（系统亚克力）：只在 Windows 11 22H2（build 22621）及以上可用。
//
// 亚克力会铺满整个窗口矩形，所以玻璃模式下窗口不能是透明窗口（否则圆角之外会露出灰色方块），
// 要交给系统画 8px 圆角；页面据此把窗口圆角对齐到 8px（见 settings-system.css 的 [data-glass]）。
// 不支持的系统保持原来的透明窗口 + 实底样式。

/** Windows 11 22H2：Electron 的 backgroundMaterial 从这个版本开始生效。 */
export const MIN_BACKGROUND_MATERIAL_BUILD = 22621;

/** 解析 process.getSystemVersion() 这类 "10.0.26300" 字符串，返回是否支持系统背景材质。 */
export function supportsBackgroundMaterial(platform: string, systemVersion: string): boolean {
  if (platform !== "win32") return false;
  const [major, , build] = systemVersion.split(".").map((part) => Number.parseInt(part, 10));
  return major === 10 && Number.isFinite(build) && build >= MIN_BACKGROUND_MATERIAL_BUILD;
}

/** 玻璃模式下的窗口选项：非透明窗口 + 亚克力；不支持时返回透明窗口选项。 */
export function resolveGlassWindowOptions(platform: string, systemVersion: string): {
  glass: boolean;
  options: { transparent: boolean; backgroundMaterial?: "acrylic" };
} {
  const glass = supportsBackgroundMaterial(platform, systemVersion);
  return glass
    ? { glass, options: { transparent: false, backgroundMaterial: "acrylic" } }
    : { glass, options: { transparent: true } };
}

/** 让页面知道当前是玻璃模式（页面样式据此切换窗口底色与圆角）。 */
export const MARK_GLASS_SCRIPT = "document.documentElement.dataset.glass = \"true\";";
