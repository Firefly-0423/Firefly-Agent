// @vitest-environment jsdom
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MarketInstallResult, MarketListResult, MarketPluginEntry, PluginListEntry, PluginManagementApi } from "../../../../../shared/plugin-management";

const feedback = vi.hoisted(() => ({ confirm: vi.fn(), notice: vi.fn(), alert: vi.fn() }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => feedback }));
import { PluginModePanel, pluginToggleTarget, resolveMarketAction } from "./PluginModePanel";

const installed = (patch: Partial<PluginListEntry> = {}): PluginListEntry => ({
  id: "archive-toolkit", name: "Archive toolkit", description: "Browse local archives", author: "Desk Tools",
  version: "4.2.0", entry: "archive.cjs", apiVersion: 1, source: "user", path: "D:\\Extensions\\archive-toolkit",
  defaultEnabled: false, configuredEnabled: true, enabled: true, status: "running", hasUnregister: true,
  canOpen: true, icon: "data:image/png;base64,AQID", ...patch,
});
const catalog = (patch: Partial<MarketPluginEntry> = {}): MarketPluginEntry => ({
  id: "catalog-toolkit", name: "Catalog toolkit", description: "Organize local documents", author: "Catalog Team",
  version: "4.6.0", downloads: 31, ...patch,
});
function latch<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function service(plugins: PluginListEntry[] = []): PluginManagementApi {
  return {
    list: vi.fn().mockResolvedValue({ plugins, issues: [] }),
    rescan: vi.fn().mockResolvedValue({ plugins, issues: [] }),
    setEnabled: vi.fn().mockResolvedValue({ ok: true }), open: vi.fn().mockResolvedValue({ ok: true }),
    uninstall: vi.fn().mockResolvedValue({ ok: true, overview: { plugins: [], issues: [] } }),
    importZip: vi.fn().mockResolvedValue({ ok: false, canceled: true }),
    marketList: vi.fn().mockResolvedValue({ ok: true, plugins: [catalog()] }),
    marketInstall: vi.fn().mockResolvedValue({ ok: false, error: "Package rejected" }),
  };
}
let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  feedback.confirm.mockReset().mockResolvedValue(true);
  feedback.notice.mockReset();
  feedback.alert.mockReset().mockResolvedValue(undefined);
  host = document.body.appendChild(document.createElement("main"));
  root = createRoot(host);
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = async (api: PluginManagementApi) => React.act(async () => root.render(React.createElement(PluginModePanel, { api })));
const click = async (button: HTMLButtonElement) => React.act(async () => button.click());
const buttons = (selector = "button") => Array.from(host.querySelectorAll<HTMLButtonElement>(selector));
const actionButtons = () => buttons(".plugin-card-ui__actions button");
const nav = async (market: boolean) => {
  const target = buttons(".ff-panel-sidebar__item").find(node => node.textContent?.includes(market ? "插件市场" : "已安装"));
  expect(target).toBeDefined();
  await click(target!);
};
const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="刷新插件"]')!;
const names = () => Array.from(host.querySelectorAll(".plugin-card-ui__name"), node => node.textContent);
async function search(query: string) {
  const field = host.querySelector<HTMLInputElement>(".plugin-panel__search")!;
  expect(field).not.toBeNull();
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, query);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return names();
}
const warning = "插件启用后会以应用权限执行 Node.js 代码。能力声明只描述预期行为，不代表沙箱隔离或安全保证。请仅安装并启用你信任的插件。";

test("renders installed plugin identity, metadata and ordered action buttons", async () => {
  await mount(service([installed()]));
  for (const text of ["Archive toolkit", "Browse local archives", "开发者：Desk Tools"]) expect(host.textContent).toContain(text);
  expect(host.querySelector<HTMLImageElement>(".plugin-card-ui__icon img")?.src).toContain("data:image/png");
  expect(actionButtons().map(node => node.textContent)).toStrictEqual(["打开", "停用", "删除"]);
});

test.each([false, true])("distinguishes pending restart from failed activation; failed=%s", async (failed) => {
  await mount(service([installed({ installedVersion: "4.6.0", selectedVersion: "4.2.0",
    activeVersion: failed ? null : "4.2.0", pendingVersion: "4.6.0", restartRequired: true,
    sourceKind: "local-zip", sourceId: "imported-archive", status: failed ? "failed" : "running",
    error: failed ? "Activation unavailable" : undefined })]));
  if (failed) {
    expect(host.textContent).toContain("当前进程未运行此插件");
    expect(host.textContent).not.toContain("当前运行版本不会被替换");
  } else {
    for (const text of ["已安装 4.6.0", "运行中 4.2.0", "待生效 4.6.0", "完整重启", "本地 ZIP"]) expect(host.textContent).toContain(text);
  }
});

test("hides interface actions for headless plugins and enables disabled plugins through the API", async () => {
  const api = service([installed({ canOpen: false, configuredEnabled: false, enabled: false, status: "disabled" })]);
  await mount(api);
  expect(actionButtons().map(node => node.textContent)).toStrictEqual(["启用", "删除"]);
  await click(actionButtons()[0]);
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith("archive-toolkit", true);
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(pluginToggleTarget(installed({ status: "failed" }))).toBe(true);
  expect(pluginToggleTarget(installed({ status: "running" }))).toBe(false);
});

test("a running headless plugin exposes only disable and delete", async () => {
  await mount(service([installed({ canOpen: false })]));
  expect(actionButtons().map(node => node.textContent)).toStrictEqual(["停用", "删除"]);
});

test("protects built-in plugins from deletion", async () => {
  const api = service([installed({ source: "builtin" })]);
  await mount(api);
  const remove = actionButtons().at(-1)!;
  expect(remove.disabled).toBe(true);
  expect(remove.title).toBe("内置插件不可删除");
});

test.each([true, false])("uninstalls only after a dangerous confirmation resolves to %s", async (accept) => {
  const decision = latch<boolean>();
  feedback.confirm.mockReturnValue(decision.promise);
  const api = service([installed()]);
  await mount(api);
  const remove = actionButtons().at(-1)!;
  expect(remove.disabled).toBe(false);
  await click(remove);
  expect(feedback.confirm).toHaveBeenCalledTimes(1);
  expect(feedback.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "删除", dangerous: true }));
  expect(api.uninstall).not.toHaveBeenCalled();
  await React.act(async () => decision.resolve(accept));
  if (accept) expect(api.uninstall).toHaveBeenCalledExactlyOnceWith("archive-toolkit");
  else expect(api.uninstall).not.toHaveBeenCalled();
});

test("loads the market on entry and restores installed management on return", async () => {
  const api = service();
  await mount(api);
  expect(api.marketList).not.toHaveBeenCalled();
  await nav(true);
  expect(api.marketList).toHaveBeenCalledExactlyOnceWith(undefined);
  for (const text of ["插件市场", "Catalog toolkit", "31 次下载"]) expect(host.textContent).toContain(text);
  expect(host.querySelector(".plugin-panel__search")).not.toBeNull();
  expect(actionButtons()[0].textContent).toBe("安装");
  expect(actionButtons()[0].className).toContain("is-enabled");
  await nav(false);
  expect(host.querySelector(".plugin-panel__search")).not.toBeNull();
  expect(host.textContent).toContain("管理已安装的功能插件");
});

test("derives ordered catalog actions from local provenance and versions", async () => {
  const api = service([
    installed({ id: "upgrade", origin: "market" }),
    installed({ id: "equal", version: "4.6.0", origin: "market" }),
    installed({ id: "ahead", version: "5.1.0", origin: "market" }),
    installed({ id: "local-copy" }), installed({ id: "bundled-copy", source: "builtin" }),
  ]);
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, plugins: ["new", "upgrade", "equal", "ahead", "local-copy", "bundled-copy"].map(id => catalog({ id })) });
  await mount(api);
  await nav(true);
  expect(host.querySelectorAll(".plugin-card-ui")).toHaveLength(6);
  expect(actionButtons().map(node => node.textContent)).toStrictEqual(["安装", "更新", "已安装 v4.6.0",
    "已安装 v5.1.0（本地版本更高）", "替换安装", "替换安装"]);
  expect(actionButtons().map(node => node.disabled)).toStrictEqual([false, false, true, true, false, false]);
  expect(actionButtons()[4].title).toBe("已存在同 ID 的本地插件，点击后将弹出替换确认");
  expect(resolveMarketAction(catalog({ version: "invalid" }), installed({ origin: "market", version: "4.6.0" })))
    .toStrictEqual({ kind: "installed", version: "4.6.0" });
});

test("filters author and capability declarations locally without additional catalog requests", async () => {
  const api = service();
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, plugins: [
    catalog({ id: "archive", name: "Archive scanner", author: "Casey", capabilities: ["离线归档", "校验压缩包"] }),
    catalog({ id: "clock", name: "Clock helper", author: "Morgan", capabilities: ["离线时钟", "时区转换"] }),
    catalog({ id: "network", name: "Remote reader", author: "Quinn", capabilities: ["访问远端"] }),
    catalog({ id: "unspecified", name: "Other utility", author: "Riley" }),
  ] });
  await mount(api);
  await nav(true);
  expect(host.querySelectorAll(".plugin-card-ui")).toHaveLength(4);
  expect(await search("CASEY")).toStrictEqual(["Archive scanner"]);
  expect(await search("离线")).toStrictEqual(["Archive scanner", "Clock helper"]);
  expect(await search("时区")).toStrictEqual(["Clock helper"]);
  expect(await search("压缩包")).toStrictEqual(["Archive scanner"]);
  expect(await search("unmatched phrase")).toStrictEqual([]);
  expect(host.textContent).toContain("无匹配插件");
  expect(await search("")).toHaveLength(4);
  expect(api.marketList).toHaveBeenCalledTimes(1);
});

test.each([
  { kind: "new", label: "安装", configured: undefined },
  { kind: "market", label: "更新", configured: true },
  { kind: "local", label: "替换安装", configured: false },
])("requires explicit $label with exact version, state, declarations and execution warning", async ({ kind, label, configured }) => {
  const api = service(kind === "new" ? [] : [installed({ id: "catalog-toolkit",
    origin: kind === "market" ? "market" : "local", configuredEnabled: configured!, enabled: configured!,
    status: configured ? "running" : "disabled" })]);
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, plugins: [catalog({ compatible: true, capabilities: ["filesystem", "network"] })] });
  vi.mocked(api.marketInstall).mockResolvedValue({ ok: true, plugin: { id: "catalog-toolkit", name: "Catalog toolkit", version: "4.6.0" } });
  await mount(api); await nav(true); await click(actionButtons()[0]);
  const state = kind === "new" ? "首次安装后默认停用，请确认来源可信后再启用。"
    : configured ? "当前插件配置为启用。将保留启用设置，完整重启应用后才会尝试运行新版本。"
      : "当前插件配置为停用。将保留停用设置，需从已安装列表手动启用。";
  const transition = kind === "market" ? "更新包将独立保存，当前运行版本继续使用；完整重启应用后再切换。"
    : kind === "local" ? "替换包将独立保存，当前运行版本继续使用；完整重启应用后再切换。" : "";
  expect(feedback.confirm).toHaveBeenCalledExactlyOnceWith({
    title: label, confirmText: label, cancelText: "取消", dangerous: true,
    message: [`确定${label} Catalog toolkit v4.6.0 吗？`, state, transition, "声明的能力：filesystem, network", warning].filter(Boolean).join("\n\n"),
  });
  expect(api.marketInstall).toHaveBeenCalledExactlyOnceWith("catalog-toolkit");
  const message = feedback.confirm.mock.calls[0][0].message;
  if (kind === "local") expect(message).not.toContain("当前版本会停止运行");
  if (kind !== "new") {
    expect(message).not.toContain("安装完成后插件处于停用状态");
    expect(host.querySelector(".plugin-panel__notices")?.textContent).toContain(configured ? "保留启用设置" : "保留停用设置");
    expect(host.querySelector(".plugin-panel__notices")?.textContent).toContain("Catalog toolkit");
    expect(host.querySelector(".plugin-panel__notices")?.textContent).not.toContain("默认停用");
  } else {
    expect(message).toContain("首次安装后默认停用");
    expect(host.querySelector(".plugin-panel__subtitle")?.textContent).toContain("首次安装后默认停用");
    expect(host.textContent).toContain("“Catalog toolkit”安装成功，默认停用中，可返回插件列表启用。");
  }
  expect(api.list).toHaveBeenCalledTimes(2);
});

test("cancelled install confirmation restores controls without installing", async () => {
  feedback.confirm.mockResolvedValue(false);
  const api = service(); await mount(api); await nav(true); await click(actionButtons()[0]);
  expect(feedback.confirm).toHaveBeenCalledTimes(1);
  expect(api.marketInstall).not.toHaveBeenCalled();
  expect(actionButtons()[0].disabled).toBe(false);
});

test("locks same-tick installs, ZIP imports and refresh during confirmation", async () => {
  const decision = latch<boolean>(); feedback.confirm.mockReturnValue(decision.promise);
  const api = service(); await mount(api); await nav(true);
  const install = actionButtons()[0];
  await React.act(async () => { install.click(); install.click(); });
  expect(feedback.confirm).toHaveBeenCalledTimes(1);
  expect(api.marketInstall).not.toHaveBeenCalled();
  const importZip = host.querySelector<HTMLButtonElement>(".ff-panel-sidebar__new")!;
  expect(importZip.disabled).toBe(true);
  expect(refresh().disabled).toBe(true);
  await React.act(async () => { importZip.click(); refresh().click(); });
  expect(api.importZip).not.toHaveBeenCalled();
  expect(api.marketList).toHaveBeenCalledTimes(1);
  await React.act(async () => decision.resolve(true));
  expect(api.marketInstall).toHaveBeenCalledTimes(1);
});

test.each(["revisit", "unmount"] as const)("invalidates confirmation on %s", async (leave) => {
  const decision = latch<boolean>(); feedback.confirm.mockReturnValue(decision.promise);
  const api = service(); await mount(api); await nav(true); await click(actionButtons()[0]);
  if (leave === "revisit") { await nav(false); await nav(true); }
  else await React.act(async () => root.render(null));
  await React.act(async () => decision.resolve(true));
  expect(api.marketInstall).not.toHaveBeenCalled();
  if (leave === "revisit") expect(actionButtons()[0].disabled).toBe(false);
});

test("disables incompatible packages and shows inspectable native details", async () => {
  const api = service();
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, plugins: [catalog({ compatible: false, pluginApiVersion: 99 })] });
  await mount(api); await nav(true);
  expect(host.textContent).toContain("不兼容");
  expect(host.textContent).toContain("插件 API：99");
  expect(actionButtons()[0].disabled).toBe(true);
  await click(actionButtons()[0]);
  expect(feedback.confirm).not.toHaveBeenCalled();
  expect(api.marketInstall).not.toHaveBeenCalled();
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, plugins: [catalog({ compatible: true, pluginApiVersion: 1, capabilities: ["network"], source: "remote" })] });
  await click(refresh());
  const details = host.querySelector("details")!;
  expect(details).not.toBeNull();
  expect(details.querySelector("summary")?.textContent).toBe("插件详情");
  for (const text of ["catalog-toolkit", "插件 API：1", "声明的能力：network", "不代表沙箱隔离"]) expect(details.textContent).toContain(text);
  expect(host.textContent).toContain("兼容当前应用");
});

test.each(["bundled", "offline-fallback"] as const)("presents an honest %s catalog without fictitious downloads", async (mode) => {
  const api = service();
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, mode, plugins: [catalog({ source: "bundled", downloads: 0 })],
    sources: [...(mode === "offline-fallback" ? [{ url: "https://unavailable.invalid/index.json", ok: false, used: false }] : []),
      { url: "bundled:registry", ok: true, used: true }] });
  await mount(api); await nav(true);
  expect(host.textContent).not.toContain("0 次下载");
  if (mode === "bundled") {
    expect(host.textContent).toContain("随应用提供的离线目录");
    expect(host.textContent).toContain("尚未发布在线市场");
  } else {
    expect(host.textContent).toContain("在线目录不可用，正在显示随附离线目录");
    expect(host.querySelector<HTMLButtonElement>(".plugin-panel__source-chip.is-dead")?.title).toContain("不可用");
  }
  const offline = buttons(".plugin-panel__source-chip").find(node => node.textContent === "随附离线目录");
  expect(offline).toBeDefined(); expect(offline!.disabled).toBe(true);
});

test("uses actual hostnames for sources and passes the selected URL to the catalog service", async () => {
  const api = service();
  const urls = ["https://catalog.invalid/github/registry.json", "https://gitee.com.catalog.invalid/registry.json"];
  vi.mocked(api.marketList).mockResolvedValue({ ok: true, plugins: [], sources: urls.map((url, index) => ({ url, ok: true, used: index === 0 })) });
  await mount(api); await nav(true);
  expect(api.marketList).toHaveBeenCalledWith(undefined);
  const sources = buttons(".plugin-panel__source-chip");
  expect(sources).toHaveLength(2);
  expect(sources.map(node => node.textContent)).toStrictEqual(["catalog.invalid", "gitee.com.catalog.invalid"]);
  await click(sources[1]);
  expect(api.marketList).toHaveBeenLastCalledWith(urls[1]);
  expect(api.marketList).toHaveBeenCalledTimes(2);
});

test("refreshes market content without rescanning installed packages", async () => {
  const api = service();
  vi.mocked(api.marketList).mockResolvedValueOnce({ ok: true, plugins: [catalog({ name: "Initial catalog" })] })
    .mockResolvedValueOnce({ ok: true, plugins: [catalog({ name: "Refreshed catalog" })] });
  await mount(api); await nav(true); await click(refresh());
  expect(host.textContent).toContain("Refreshed catalog");
  expect(host.textContent).not.toContain("Initial catalog");
  expect(api.rescan).not.toHaveBeenCalled();
});

test.each([false, true])("shows catalog failure and permits retry; rejected=%s", async (rejected) => {
  const api = service();
  if (rejected) vi.mocked(api.marketList).mockRejectedValueOnce(new Error("Catalog offline"));
  else vi.mocked(api.marketList).mockResolvedValueOnce({ ok: false, error: "Catalog offline", plugins: [] });
  vi.mocked(api.marketList).mockResolvedValueOnce({ ok: true, plugins: [catalog()] });
  await mount(api); await nav(true);
  expect(host.textContent).toContain("获取插件列表失败：Catalog offline");
  const retry = buttons().find(node => node.textContent === "重试");
  expect(retry).toBeDefined(); await click(retry!);
  expect(host.textContent).toContain("Catalog toolkit");
  expect(host.textContent).not.toContain("获取插件列表失败");
});

test.each(["success", "error", "revisit"] as const)("ignores obsolete catalog completion after %s", async (outcome) => {
  const earlier = latch<MarketListResult>(), api = service();
  vi.mocked(api.marketList).mockReturnValueOnce(earlier.promise).mockResolvedValueOnce({ ok: true, plugins: [catalog({ name: "Current catalog" })] });
  await mount(api); await nav(true);
  if (outcome === "revisit") { await nav(false); await nav(true); } else await click(refresh());
  expect(host.textContent).toContain("Current catalog");
  await React.act(async () => {
    if (outcome === "error") earlier.reject(new Error("Obsolete failure"));
    else earlier.resolve({ ok: true, plugins: [catalog({ name: "Obsolete catalog" })] });
  });
  expect(host.textContent).toContain("Current catalog");
  expect(host.textContent).not.toContain("Obsolete catalog");
  expect(host.textContent).not.toContain("Obsolete failure");
});

test.each([false, true])("suppresses feedback from an install completed on a previous market visit; success=%s", async (success) => {
  const completion = latch<MarketInstallResult>(), api = service();
  vi.mocked(api.marketInstall).mockReturnValue(completion.promise);
  await mount(api); await nav(true); await click(actionButtons()[0]);
  expect(api.marketInstall).toHaveBeenCalledTimes(1);
  await nav(false); await nav(true);
  await React.act(async () => completion.resolve(success
    ? { ok: true, plugin: { id: "catalog-toolkit", name: "Previous installation", version: "4.6.0" } }
    : { ok: false, error: "Previous installation failed" }));
  expect(host.textContent).not.toContain("Previous installation");
  expect(actionButtons()[0].disabled).toBe(false);
  if (success) expect(api.list).toHaveBeenCalledTimes(2);
});

test("reports an installation rejection with the service error intact", async () => {
  const api = service();
  await mount(api); await nav(true); await click(actionButtons()[0]);
  expect(host.textContent).toContain("安装失败：Package rejected");
});
