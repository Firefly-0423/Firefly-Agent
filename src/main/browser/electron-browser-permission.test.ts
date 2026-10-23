import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ create: vi.fn((options: any) => options), dialog: vi.fn() }));
vi.mock("electron", () => ({ session: {}, dialog: { showMessageBox: state.dialog } }));
vi.mock("./browser-service", () => ({ createBrowserService: state.create }));
vi.mock("./electron-browser-guest", () => ({ createElectronBrowserGuest: vi.fn() }));
import { createElectronBrowserService } from "./electron-browser-service";
import { BROWSER_PUBLIC_SCOPE } from "../../shared/manual-browser";
describe("native bounded browser consent", () => {
  it("enables only a consent path and asks the trusted host about exact hosts/actions with deny selected", async () => {
    const service = createElectronBrowserService({ profile: {} as any }) as any;
    expect(service.permissionPolicy).toEqual(BROWSER_PUBLIC_SCOPE);
    expect(service.gateOpen).not.toBe(true);
    expect(service.confirmPermission).toBeTypeOf("function");
    const host = {}, owner = { host, conversationId: "synthetic-session", signal: new AbortController().signal };
    state.dialog.mockResolvedValueOnce({ response: 0 });
    expect(await service.confirmPermission(owner, BROWSER_PUBLIC_SCOPE)).toBe(false);
    expect(state.dialog).toHaveBeenLastCalledWith(host, expect.objectContaining({ defaultId: 0, cancelId: 0, noLink: true }));
    const prompt = state.dialog.mock.calls.at(-1)![1];
    for (const domain of BROWSER_PUBLIC_SCOPE.hosts) expect(prompt.detail).toContain(domain);
    expect(prompt.detail).toContain("synthetic-session");
    state.dialog.mockResolvedValueOnce({ response: 1 });
    expect(await service.confirmPermission(owner, BROWSER_PUBLIC_SCOPE)).toBe(true);
  });
});

const scope = { mode: "manual", hosts: ["public.example"], resourceHosts: ["cdn.example"], actions: ["navigate"] };
describe("native exact-site manual browser consent", () => {
  it("describes the native window scope without claiming a nonexistent chat session", async () => {
    const service = createElectronBrowserService({ profile: {} as any }) as any;
    const owner = { host: {}, conversationId: null, workspaceId: "native-window-epoch", signal: new AbortController().signal };
    const cancellation = new AbortController(); state.dialog.mockResolvedValueOnce({ response: 1 });
    expect(await service.confirmPermission(owner, scope, cancellation.signal)).toBe(true);
    const prompt = state.dialog.mock.calls.at(-1)![1];
    expect(prompt.message).toContain("窗口"); expect(prompt.detail).toContain("当前窗口");
    expect(prompt.detail).not.toContain("当前会话：null"); expect(prompt.detail).not.toContain("切换会话");
    expect(prompt.detail).toContain("HTTPS:443 GET/HEAD"); expect(prompt.buttons).toContain("允许此窗口");
  });
  it("keeps separate Agent policy while describing manual primary/resource scopes and history reset", async () => {
    const service = createElectronBrowserService({ profile: {} as any }) as any;
    expect(service.manualBrowsing).toBe(true);
    expect(service.permissionPolicy).toEqual(BROWSER_PUBLIC_SCOPE);
    expect(service.gateOpen).not.toBe(true);
    const host = {}, owner = { host, conversationId: "synthetic-session", signal: new AbortController().signal };
    const cancellation = new AbortController();
    state.dialog.mockResolvedValueOnce({ response: 0 });
    expect(await service.confirmPermission(owner, scope, cancellation.signal)).toBe(false);
    expect(state.dialog).toHaveBeenLastCalledWith(host, expect.objectContaining({ signal: cancellation.signal, defaultId: 0, cancelId: 0, noLink: true }));
    const prompt = state.dialog.mock.calls.at(-1)![1];
    for (const domain of [...scope.hosts, ...scope.resourceHosts]) expect(prompt.detail).toContain(domain);
    expect(prompt.detail).toContain("synthetic-session");
    expect(prompt.detail).toContain("主站"); expect(prompt.detail).toContain("资源域");
    expect(prompt.detail).toContain("脚本"); expect(prompt.detail).toContain("历史");
    expect(prompt.detail).toContain("不会授权代理");
    state.dialog.mockResolvedValueOnce({ response: 1 });
    expect(await service.confirmPermission(owner, scope, cancellation.signal)).toBe(true);
  });
  it("ignores an accepted native dialog after cancellation or owner revocation", async () => {
    const service = createElectronBrowserService({ profile: {} as any }) as any;
    for (const reason of ["request", "owner"]) {
      const request = new AbortController(), abort = new AbortController();
      state.dialog.mockImplementationOnce(async () => { (reason === "request" ? request : abort).abort(); return { response: 1 }; });
      expect(await service.confirmPermission({ host: {}, conversationId: "synthetic", signal: abort.signal }, scope, request.signal)).toBe(false);
    }
  });
});

it("shows separately selected Agent navigation and resource domains in the native consent", async () => {
  const service = createElectronBrowserService({profile:{} as any}) as any;
  expect(service.agentSiteSelection).toBe(true);
  state.dialog.mockResolvedValueOnce({response:0});
  const scope = {mode:'agent',site:true,hosts:['developer.mozilla.org'],resourceHosts:['static.example.org'],actions:['navigate','observe']};
  expect(await service.confirmPermission({host:{},conversationId:'site-consent',signal:new AbortController().signal},scope,new AbortController().signal)).toBe(false);
  const prompt = state.dialog.mock.calls.at(-1)![1];
  expect(prompt.detail).toContain('developer.mozilla.org'); expect(prompt.detail).toContain('static.example.org');
  expect(prompt.detail).toContain('不能导航'); expect(prompt.detail).toContain('GET 请求也可能有服务端副作用');
});
