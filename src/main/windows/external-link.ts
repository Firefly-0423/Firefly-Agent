import { app, shell } from "electron";
import { isDev } from "../startup/env";
import { routeBrowserGuestNavigation } from "../browser/browser-guest-routing";

const WEB_SCHEMES = ["http://", "https://"];
const DENY_OPEN = { action: "deny" } as const;

/**
 * 外链交给系统浏览器：只接受 http / https；开发时的本地前端地址（5173）不外送。
 * 返回 true 代表已经接手。
 */
export function openExternalUrl(url: string): boolean {
  const isWebUrl = WEB_SCHEMES.some((scheme) => url.startsWith(scheme));
  if (!isWebUrl) return false;
  const isDevFrontend = isDev && url.startsWith("http://localhost:5173");
  if (isDevFrontend) return false;
  void shell.openExternal(url);
  return true;
}

/**
 * 进程级导航守卫，在入口处调用一次，覆盖之后创建的所有窗口。
 * 页面内的跳转与新开窗口都被拒绝，http(s) 目标改由系统浏览器打开。
 * 程序化的 loadURL / loadFile 不经过 will-navigate，不受影响；
 * 插件沙箱 iframe 只在子 frame 内，同样不受影响。
 */
export function installGlobalNavigationGuard(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const routedToGuest = routeBrowserGuestNavigation(contents, { preventDefault() {} }, url);
      if (!routedToGuest) openExternalUrl(url);
      return DENY_OPEN;
    });

    contents.on("will-navigate", (event, url) => {
      const routedToGuest = routeBrowserGuestNavigation(contents, event, event.url ?? url);
      if (routedToGuest) return;
      event.preventDefault();
      openExternalUrl(url);
    });
  });
}
