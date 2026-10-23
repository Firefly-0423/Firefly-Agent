import { beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PUBLIC_SCOPE } from "../../shared/manual-browser";

const mocks = vi.hoisted(() => ({
  options: null as any,
  dialog: vi.fn(),
  fromPartition: vi.fn((partition: string) => ({ port: partition })),
  createSessionPort: vi.fn((port: unknown) => ({ sessionPort: port })),
  createGuest: vi.fn(() => ({ guest: true })),
  createProxy: vi.fn((config: unknown) => ({ proxy: config })),
}));
vi.mock("electron", () => ({
  session: { fromPartition: mocks.fromPartition },
  dialog: { showMessageBox: mocks.dialog },
}));
vi.mock("./browser-network-binding", () => ({
  createElectronBrowserSessionPort: (port: unknown) => mocks.createSessionPort(port),
}));
vi.mock("./electron-browser-guest", () => ({ createElectronBrowserGuest: mocks.createGuest }));
vi.mock("./browser-service", () => ({
  createBrowserService: (options: unknown) => {
    mocks.options = options;
    return { service: true };
  },
}));
vi.mock("./trusted-browser-resolver", () => ({
  createTrustedBrowserProxyFactory: (config: unknown) => mocks.createProxy(config),
}));

import { createElectronBrowserService } from "./electron-browser-service";

const owner = (overrides: Record<string, unknown> = {}) =>
  ({
    conversationId: "conversation-1",
    workspaceId: undefined,
    host: { id: "host" },
    signal: undefined,
    ...overrides,
  }) as any;

const scope = (overrides: Record<string, unknown> = {}) =>
  ({
    hosts: ["example.com"],
    actions: ["navigate"],
    mode: "manual",
    ...overrides,
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options = null;
  mocks.dialog.mockResolvedValue({ response: 1 });
});

describe("createElectronBrowserService composition", () => {
  it("enables manual and Agent site selection under the public scope", () => {
    const service = createElectronBrowserService({ profile: { kind: "test" } as any });
    expect(service).toEqual({ service: true });
    expect(mocks.options).toMatchObject({
      manualBrowsing: true,
      agentSiteSelection: true,
      permissionPolicy: BROWSER_PUBLIC_SCOPE,
    });
    expect(mocks.options.profile).toEqual({ kind: "test" });
  });

  it("builds an Electron session port lazily per partition", () => {
    createElectronBrowserService({ profile: {} as any });
    expect(mocks.options.createSession("persist:browser")).toEqual({
      sessionPort: { port: "persist:browser" },
    });
    expect(mocks.fromPartition).toHaveBeenCalledWith("persist:browser", { cache: false });
  });

  it("uses the Electron guest factory", () => {
    createElectronBrowserService({ profile: {} as any });
    expect(mocks.options.createView).toBe(mocks.createGuest);
  });

  it("only attaches a proxy factory when a trusted resolver is configured", () => {
    createElectronBrowserService({ profile: {} as any });
    expect(mocks.options.proxyFactory).toBeUndefined();
    const resolver = { hosts: [] } as any;
    createElectronBrowserService({ profile: {} as any, trustedResolver: resolver });
    expect(mocks.createProxy).toHaveBeenCalledWith(resolver);
    expect(mocks.options.proxyFactory).toEqual({ proxy: resolver });
  });

  it("forwards onChanged and acceptDownload unchanged", () => {
    const onChanged = vi.fn();
    const acceptDownload = vi.fn();
    createElectronBrowserService({ profile: {} as any, onChanged, acceptDownload });
    expect(mocks.options.onChanged).toBe(onChanged);
    expect(mocks.options.acceptDownload).toBe(acceptDownload);
  });
});

describe("ordinary web browsing grant", () => {
  it("allows manual web scope inside a workspace without prompting", async () => {
    createElectronBrowserService({ profile: {} as any });
    await expect(
      mocks.options.confirmPermission(owner({ workspaceId: "workspace-1" }), scope({ web: true }), undefined),
    ).resolves.toBe(true);
    expect(mocks.dialog).not.toHaveBeenCalled();
  });

  it("refuses web scope outside a workspace or outside manual mode", async () => {
    createElectronBrowserService({ profile: {} as any });
    await expect(mocks.options.confirmPermission(owner(), scope({ web: true }), undefined)).resolves.toBe(false);
    await expect(
      mocks.options.confirmPermission(owner({ workspaceId: "w" }), scope({ web: true, mode: "agent" }), undefined),
    ).resolves.toBe(false);
    expect(mocks.dialog).not.toHaveBeenCalled();
  });
});

describe("Agent scopes", () => {
  it("shows the exact agent grant dialog and allows on response 1", async () => {
    createElectronBrowserService({ profile: {} as any });
    const signal = new AbortController().signal;
    const grantOwner = owner();
    await expect(
      mocks.options.confirmPermission(
        grantOwner,
        {
          hosts: ["example.com"],
          actions: ["navigate", "observe", "click", "type"],
          resourceHosts: ["cdn.example.com"],
          mode: "agent",
        },
        signal,
      ),
    ).resolves.toBe(true);
    const [host, options] = mocks.dialog.mock.calls[0]!;
    expect(host).toBe(grantOwner.host);
    expect(options).toMatchObject({ type: "question", title: "授权代理浏览", signal, cancelId: 0 });
    expect(options.detail).toContain("example.com");
    expect(options.detail).toContain("cdn.example.com");
    expect(options.detail).toContain("在非敏感文本框输入");
    expect(options.buttons).toEqual(["拒绝", "允许本会话"]);
  });

  it("treats a missing mode as an Agent scope", async () => {
    createElectronBrowserService({ profile: {} as any });
    mocks.dialog.mockResolvedValue({ response: 0 });
    await expect(mocks.options.confirmPermission(owner(), scope({ mode: undefined }), undefined)).resolves.toBe(false);
    expect(mocks.dialog.mock.calls[0]![1].title).toBe("授权代理浏览");
  });

  it("reports resource host absence explicitly", async () => {
    createElectronBrowserService({ profile: {} as any });
    await mocks.options.confirmPermission(owner(), scope({ mode: "agent" }), undefined);
    expect(mocks.dialog.mock.calls[0]![1].detail).toContain("仅资源域（不能导航）：\n无");
  });

  it("denies when either signal is already aborted before showing a dialog", async () => {
    createElectronBrowserService({ profile: {} as any });
    const aborted = new AbortController();
    aborted.abort();
    await expect(mocks.options.confirmPermission(owner({ signal: aborted.signal }), scope({ mode: "agent" }), undefined)).resolves.toBe(false);
    await expect(mocks.options.confirmPermission(owner(), scope({ mode: "agent" }), aborted.signal)).resolves.toBe(false);
    expect(mocks.dialog).not.toHaveBeenCalled();
  });

  it("denies when the owner aborts while the dialog is open", async () => {
    createElectronBrowserService({ profile: {} as any });
    const controller = new AbortController();
    mocks.dialog.mockImplementation(async () => {
      controller.abort();
      return { response: 1 };
    });
    await expect(
      mocks.options.confirmPermission(owner({ signal: controller.signal }), scope({ mode: "agent" }), undefined),
    ).resolves.toBe(false);
  });
});

describe("local network scopes", () => {
  it("shows the warning dialog for a private authority and allows on response 1", async () => {
    createElectronBrowserService({ profile: {} as any });
    await expect(
      mocks.options.confirmPermission(
        owner(),
        scope({ hosts: ["127.0.0.1:5173"], resourceHosts: ["127.0.0.1:8080"] }),
        undefined,
      ),
    ).resolves.toBe(true);
    const options = mocks.dialog.mock.calls[0]![1];
    expect(options.title).toBe("授权访问本机或内网地址");
    expect(options.type).toBe("warning");
    expect(options.detail).toContain("127.0.0.1:5173");
    expect(options.detail).toContain("127.0.0.1:8080");
    expect(options.buttons).toEqual(["拒绝", "允许此窗口"]);
  });

  it("omits the extra-port section when only one port is granted", async () => {
    createElectronBrowserService({ profile: {} as any });
    await mocks.options.confirmPermission(owner(), scope({ hosts: ["localhost:3000"] }), undefined);
    expect(mocks.dialog.mock.calls[0]![1].detail).not.toContain("同一主机上额外允许的端口");
    await expect(
      mocks.options.confirmPermission(owner(), scope({ hosts: ["localhost:3000"] }), new AbortController().signal),
    ).resolves.toBe(true);
  });
});

describe("public manual site scopes", () => {
  it("asks per conversation when no workspace owns the window", async () => {
    createElectronBrowserService({ profile: {} as any });
    await expect(
      mocks.options.confirmPermission(owner(), scope({ resourceHosts: ["cdn.example.com"] }), undefined),
    ).resolves.toBe(true);
    const options = mocks.dialog.mock.calls[0]![1];
    expect(options.title).toBe("授权手动浏览站点");
    expect(options.message).toBe("允许当前会话手动访问这些精确 HTTPS 域名吗？");
    expect(options.detail).toContain("当前会话：conversation-1");
    expect(options.buttons).toEqual(["拒绝", "允许本会话"]);
  });

  it("asks for the window when a workspace owns it", async () => {
    createElectronBrowserService({ profile: {} as any });
    expect(
      await mocks.options.confirmPermission(owner({ workspaceId: "workspace-1" }), scope(), undefined),
    ).toBe(true);
    const options = mocks.dialog.mock.calls[0]![1];
    expect(options.message).toBe("允许此窗口手动访问这些精确 HTTPS 域名吗？");
    expect(options.detail).toContain("当前窗口：Firefly 主窗口");
    expect(options.buttons).toEqual(["拒绝", "允许此窗口"]);
  });

  it("denies when the user cancels", async () => {
    createElectronBrowserService({ profile: {} as any });
    mocks.dialog.mockResolvedValue({ response: 0 });
    await expect(mocks.options.confirmPermission(owner(), scope(), undefined)).resolves.toBe(false);
  });
});
