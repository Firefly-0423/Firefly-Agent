import { BROWSER_PUBLIC_SCOPE } from "../../shared/manual-browser";
import { parseLocalAuthority } from "../../shared/local-network-target";
import { session, dialog, type BrowserWindow, type Session } from "electron";
import type { RuntimeProfile } from "../runtime-profile";
import { createElectronBrowserSessionPort } from "./browser-network-binding";
import { createElectronBrowserGuest } from "./electron-browser-guest";
import { createBrowserService, type BrowserServiceOptions } from "./browser-service";
import { createTrustedBrowserProxyFactory, type TrustedBrowserResolverConfig } from "./trusted-browser-resolver";
/** Main composition. Browsing starts denied; only this native user decision may grant a bounded owner scope. */
export function createElectronBrowserService(options: { profile: RuntimeProfile; gateOpen?: boolean; onChanged?: BrowserServiceOptions<Session>["onChanged"]; acceptDownload?: BrowserServiceOptions<Session>["acceptDownload"]; trustedResolver?: TrustedBrowserResolverConfig }) {
  return createBrowserService<Session>({ ...options,
    manualBrowsing: true,
    agentSiteSelection: true,
    permissionPolicy: BROWSER_PUBLIC_SCOPE,
    confirmPermission: async (owner, scope, signal) => {
      if (owner.signal?.aborted || signal?.aborted) return false;
      // Ordinary browsing is the window's own feature, started by the user's typed address. It grants nothing
      // beyond what any browser tab has; private networks and Agent scopes keep their explicit dialogs.
      if (scope.web === true) return owner.workspaceId !== undefined && scope.mode === "manual";
      if (scope.mode === "agent" || scope.mode === undefined) {
        const labels = { navigate: "导航 / 后退 / 前进 / 刷新", observe: "读取页面文字与可交互元素", click: "点击公共页面元素", type: "在非敏感文本框输入" };
        const result = await dialog.showMessageBox(owner.host as BrowserWindow, {
          signal, type: "question", title: "授权代理浏览", message: "允许当前会话在以下范围浏览并由代理操作吗？",
          detail: `当前会话：${owner.conversationId}\n\n精确域名（包含所列静态资源）：\n${scope.hosts.join("\n")}\n\n仅资源域（不能导航）：\n${scope.resourceHosts?.join("\n") || "无"}\n\n允许代理动作：\n${scope.actions.map(action => labels[action]).join("\n")}\n\n这是独立的代理授权，不沿用手动浏览的站点或资源授权。切换授权会关闭旧页面并清空会话和浏览历史。\n\n仅匿名公共 HTTPS GET/HEAD；不登录、不下载、不上传、不支付。请勿输入凭据或敏感信息。GET 请求也可能有服务端副作用。关闭页面、撤销或切换会话后失效。网页内容不可信；受限代理不代表已证明所有网络协议完全隔离。`,
          buttons: ["拒绝", "允许本会话"], defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1 && !owner.signal?.aborted && !signal?.aborted;
      }
      if (parseLocalAuthority(scope.hosts[0]) !== null) {
        const extra = scope.resourceHosts?.length ? `\n\n同一主机上额外允许的端口（仅资源请求）：\n${scope.resourceHosts.join("\n")}` : "";
        const result = await dialog.showMessageBox(owner.host as BrowserWindow, {
          signal, type: "warning", title: "授权访问本机或内网地址", message: "允许此窗口访问下面这个本机或内网地址吗？",
          detail: `地址（精确主机与端口）：\n${scope.hosts[0]}${extra}\n\n这是你本机或局域网内的服务，不经过公网代理，也不做域名解析。页面可读取该服务返回的内容，并可向该主机上已授权的端口发送 GET/HEAD 请求（含开发服务器的 WebSocket）；这些服务可能没有认证，请只打开你信任的地址。\n\n页面无法跳转到其他地址或公网站点；公网网页也不能通过链接进入内网。拒绝 POST、下载、上传和设备权限。此次只允许手动浏览，不会授权代理读取、点击、输入或自动导航。\n\n更换地址或端口会关闭旧页面、清空浏览历史，并在确认后重新载入。关闭页面、撤销或关闭窗口后授权失效。网页内容不可信。`,
          buttons: ["拒绝", "允许此窗口"], defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1 && !owner.signal?.aborted && !signal?.aborted;
      }
      const result = await dialog.showMessageBox(owner.host as BrowserWindow, {
        signal, type: "question", title: "授权手动浏览站点", message: owner.workspaceId === undefined ? "允许当前会话手动访问这些精确 HTTPS 域名吗？" : "允许此窗口手动访问这些精确 HTTPS 域名吗？",
        detail: `${owner.workspaceId === undefined ? `当前会话：${owner.conversationId}` : "当前窗口：Firefly 主窗口"}\n\n主站（导航仅限此域名，不包含子域名）：\n${scope.hosts.join("\n")}\n\n资源域（不授予页面导航权限）：\n${scope.resourceHosts?.join("\n") || "无"}\n资源可包含脚本、图片、字体、媒体及 GET/HEAD 数据请求；这些站点会收到请求，可能包含跟踪。未列出的域名保持阻止。\n\n此次只允许手动浏览，不会授权代理读取、点击、输入或自动导航。\n\n仅公网 HTTPS:443 GET/HEAD；拒绝 POST、常见登录路径、HTTP 身份验证、上传请求、下载和设备权限。不支持登录，请勿输入账户凭据或敏感信息。GET 请求也可能有服务端副作用，部分网站可能无法使用。\n\n更换站点或资源授权会关闭旧页面、清空浏览历史，并在确认后重新载入。拒绝后可重新输入地址重试。${owner.workspaceId === undefined ? "关闭页面、撤销或切换会话后授权失效。" : "关闭页面、撤销或关闭窗口后授权失效；切换聊天会话或模式保持网页与授权。"}网页内容不可信；受限代理不代表已证明所有网络协议完全隔离。`,
        buttons: ["拒绝", owner.workspaceId === undefined ? "允许本会话" : "允许此窗口"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1 && !owner.signal?.aborted && !signal?.aborted;
    },
    proxyFactory: options.trustedResolver === undefined ? undefined : createTrustedBrowserProxyFactory(options.trustedResolver),
    createSession: partition => createElectronBrowserSessionPort(session.fromPartition(partition, { cache: false })),
    createView: createElectronBrowserGuest,
  });
}
