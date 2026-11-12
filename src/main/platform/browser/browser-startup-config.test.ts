import { afterEach, expect, it, vi } from "vitest";
const factory = vi.hoisted(() => vi.fn((_options: unknown) => ({ isEnabled: () => false })));
vi.mock("./electron-browser-service", () => ({ createElectronBrowserService: factory }));
import { createStartupBrowserService, readBrowserStartupResolver } from "./browser-startup-config";
const profile = Object.freeze({ kind: "smoke" }) as any;
afterEach(() => vi.clearAllMocks());
it("leaves unconfigured users without a trusted resolver and keeps the startup gate closed", () => {
  expect(readBrowserStartupResolver({})).toBeUndefined();
  const service = createStartupBrowserService({ profile }, {});
  expect(service.isEnabled()).toBe(false);
  expect(factory.mock.calls[0][0]).toEqual({ profile, onChanged: undefined, trustedResolver: undefined });
});
it("injects the explicit process selection and snapshots it before later mutation", () => {
  const env = { FIREFLY_BROWSER_DNS_SERVER: "192.168.31.1", FIREFLY_BROWSER_DNS_PORT: "53" };
  const changed = vi.fn();createStartupBrowserService({ profile, onChanged: changed }, env);
  env.FIREFLY_BROWSER_DNS_SERVER = "8.8.8.8";env.FIREFLY_BROWSER_DNS_PORT = "5353";
  const options = factory.mock.calls[0][0] as any;
  expect(options.trustedResolver).toEqual({ server: "192.168.31.1", port: 53 });
  expect(Object.isFrozen(options.trustedResolver)).toBe(true);expect(options.onChanged).toBe(changed);
  expect(options).not.toHaveProperty("gateOpen");
});
it("uses DNS port53 only after an explicit server selection, including numeric IPv6", () => {
  expect(readBrowserStartupResolver({ FIREFLY_BROWSER_DNS_SERVER: "2001:4860:4860::8888" })).toEqual({ server: "2001:4860:4860::8888", port: 53 });
});
it.each([
  {},
  { FIREFLY_BROWSER_GATE_OPEN: "true", trustedResolver: "192.168.31.1:53" },
])("extra environment and startup fields cannot grant browsing or select DNS", env => {
  createStartupBrowserService({ profile, gateOpen: true, trustedResolver: { server: "10.0.0.1", port: 53 } } as any, env);
  expect(factory.mock.calls[0][0]).toEqual({ profile, onChanged: undefined, trustedResolver: undefined });
});
it.each([
  { FIREFLY_BROWSER_DNS_PORT: "53" },
  ...["", " example.com", "example.com", "http://192.168.31.1", "192.168.31.1:53", "192.168.31.1 "].map(server => ({ FIREFLY_BROWSER_DNS_SERVER: server })),
  ...["", "0", "-1", "65536", "53.5", "053", "53x"].map(port => ({ FIREFLY_BROWSER_DNS_SERVER: "192.168.31.1", FIREFLY_BROWSER_DNS_PORT: port })),
])("malformed explicit process configuration fails before constructing the service", env => {
  expect(() => createStartupBrowserService({ profile }, env)).toThrow("browser DNS configuration unavailable");
  expect(factory).not.toHaveBeenCalled();
});
