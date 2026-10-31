// 演示页的深浅色跟随宣传页：初始值来自地址里的 theme 参数，之后由宣传页发消息切换。
// 必须在 ../ui/theme 之前导入，它一加载就读取 window.fireflyTheme。
import type { UiTheme } from "../../shared/ui-theme";

export const DEMO_THEME_MESSAGE = "firefly-demo:theme";

export function demoThemeFrom(value: unknown): UiTheme {
  return value === "dark" ? "firefly-dark" : "pearl-white";
}

let current = demoThemeFrom(new URLSearchParams(window.location.search).get("theme"));
const listeners = new Set<(theme: UiTheme) => void>();

// Only the theme is provided; without getColors the app keeps its built-in palette.
window.fireflyTheme = {
  get: async () => current,
  onChanged: (callback: (theme: UiTheme) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
} as unknown as Window["fireflyTheme"];

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  const data = event.data as { type?: string; theme?: unknown } | null;
  if (data?.type !== DEMO_THEME_MESSAGE) return;
  current = demoThemeFrom(data.theme);
  for (const listener of listeners) listener(current);
});
