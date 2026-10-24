import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeFileSymlink } from "../../../scripts/verify/file-symlink-probe";
import { resolvePluginPanelRequest, installPluginPanelProtocol, registerPluginPanelScheme } from "./plugin-panel-protocol";
import { protocol } from "electron";
vi.mock("electron", () => ({ protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }));

let root: string, pluginRoot: string, assets: string;
const access = (id: string) => id === "garden" ? pluginRoot : undefined;
const request = (url: string) => resolvePluginPanelRequest(url, access, assets);
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ff-panel-contract-"));
  pluginRoot = join(root, "plugins", "garden"); assets = join(root, "host-assets");
  const files: Array<[string, string]> = [
    [join(pluginRoot, "panel.html"), "<!doctype html><p>Garden controls</p>"],
    [join(pluginRoot, "garden.js"), "window.garden = true"], [join(pluginRoot, "garden.css"), "p { color: green; }"],
    [join(pluginRoot, "leaf.svg"), "<svg></svg>"], [join(pluginRoot, "private.bin"), "private"],
    [join(pluginRoot, "plugin-assets", "panel-bridge.js"), "GARDEN-OWNED-BRIDGE"],
    [join(pluginRoot, ".firefly", "panel-bridge.js"), "PLUGIN-SHADOW-ATTEMPT"],
    [join(root, "plugins", "disabled-garden", "panel.html"), "Disabled controls"],
    [join(assets, "panel-bridge.js"), "FIREFLY-HOST-BRIDGE"],
  ];
  for (const [filename, text] of files) { mkdirSync(join(filename, ".."), { recursive: true }); writeFileSync(filename, text); }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.clearAllMocks());
it.each([
  ["panel.html", "text/html; charset=utf-8"], ["garden.js", "text/javascript; charset=utf-8"],
  ["garden.css", "text/css; charset=utf-8"], ["leaf.svg", "image/svg+xml"],
])("serves an enabled plugin's %s with its MIME type", async (filename, contentType) => {
  const response = await request(`firefly-plugin://garden/${filename}`);
  expect(response).toMatchObject({ status: 200, contentType });
  if (filename === "panel.html") expect((response as { body: Buffer }).body.toString("utf8")).toContain("Garden controls");
});
it("distinguishes nested plugin assets from host-reserved bridge resources", async () => {
  const own = await request("firefly-plugin://garden/plugin-assets/panel-bridge.js");
  expect(own.status).toBe(200);
  if (own.status === 200) expect(own.body.toString()).toBe("GARDEN-OWNED-BRIDGE");
  expect((await request("firefly-plugin://disabled-garden/plugin-assets/panel-bridge.js")).status).toBe(404);
  const host = await request("firefly-plugin://garden/.firefly/panel-bridge.js");
  expect(host).toMatchObject({ status: 200, contentType: "text/javascript; charset=utf-8" });
  if (host.status === 200) expect(host.body.toString()).toBe("FIREFLY-HOST-BRIDGE");
});
it.each([
  "firefly-plugin://garden/private.bin", "firefly-plugin://unknown-garden/panel.html", "firefly-plugin://disabled-garden/panel.html",
  "firefly-plugin://garden/", "firefly-plugin://garden//panel.html", "firefly-plugin://garden/panel%2fhtml",
  "firefly-plugin://garden/panel%5chtml", "firefly-plugin://garden/..%5cprivate", "firefly-plugin://garden/panel%00.html",
  "firefly-plugin://garden/%252e%252e%252fpanel.html", "firefly-plugin://garden/D:/private",
  "firefly-plugin://GARDEN/panel.html", "firefly-plugin://gar_den/panel.html", "firefly-plugin:garden/panel.html",
  "https://garden/panel.html", "invalid panel URL", "firefly-plugin://garden/.firefly/absent.js", "firefly-plugin://garden/.firefly/private.txt",
])("returns 404 for unsupported or invalid request %s", async url => { expect((await request(url)).status).toBe(404); });
it.each(["panel.html?revision=4#section", "nested/../panel.html"])("retains valid URL normalization for %s", async suffix => {
  expect((await request(`firefly-plugin://garden/${suffix}`)).status).toBe(200);
});
it("prevents symlinks from exposing a file outside the plugin root", async ({ skip }) => {
  const outside = join(root, "outside-controls.html");
  writeFileSync(outside, "Outside panel secret");
  const probe = probeFileSymlink(outside, join(root, "symlink-capability-probe"));
  if (!probe.supported) skip(probe.reason);
  symlinkSync(outside, join(pluginRoot, "escaped.html"));
  expect((await request("firefly-plugin://garden/escaped.html")).status).toBe(404);
});
it("registers precisely the standard and secure privileges", () => {
  registerPluginPanelScheme();
  expect(vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0][0])
    .toEqual([{ scheme: "firefly-plugin", privileges: { standard: true, secure: true } }]);
});
it("installs the protocol handler with no-sniff and no-store response headers", async () => {
  installPluginPanelProtocol(access);
  expect(protocol.handle).toHaveBeenCalledWith("firefly-plugin", expect.any(Function));
  const handler = vi.mocked(protocol.handle).mock.calls[0][1];
  const response = await handler({ url: "firefly-plugin://garden/panel.html" } as never);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toContain("Garden controls");
  expect((await handler({ url: "firefly-plugin://disabled-garden/panel.html" } as never)).status).toBe(404);
});
it("keeps the panel scheme structurally separate from settings origins", () => {
  const panel = new URL("firefly-plugin://garden/panel.html");
  expect(panel.protocol).toBe("firefly-plugin:");
  for (const settings of ["file://", "http://localhost:5173", "https://garden-settings.invalid"])
    expect(settings.startsWith(panel.protocol)).toBe(false);
});
