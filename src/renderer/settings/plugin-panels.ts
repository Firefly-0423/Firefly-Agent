import {
  PANEL_MIN_HEIGHT, PANEL_PROTOCOL, PANEL_SCHEME,
  buildPanelTheme, panelOriginFor, parsePanelMessage, clampPanelHeight,
} from "./panel-bridge-protocol";
import type { PluginListEntry, PluginOverview } from "../../shared/plugin-management";

type PanelDescriptor = { id: string; name: string; version: string; settingsPanel: string };
type MountedPanel = { signature: string; remove(): void };

// 加载后登记窗口归属，消息不能自报插件身份。
const panelRegistry = new Map<Window, string>();
const panelProtocols = new WeakMap<Window, string>();
const mountedPanels = new Map<string, MountedPanel>();
let subscribed = false;
let revision = 0;

function postToPanel(contentWindow: Window, pluginId: string, payload: Record<string, unknown>): void {
  const packet = { protocol: panelProtocols.get(contentWindow) ?? PANEL_PROTOCOL, ...payload };
  contentWindow.postMessage(packet, panelOriginFor(pluginId));
}

function findContentWindow(pluginId: string): Window | undefined {
  for (const registration of panelRegistry) {
    if (registration[1] === pluginId) return registration[0];
  }
  return undefined;
}

function findIframeByContentWindow(contentWindow: Window): HTMLIFrameElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLIFrameElement>(".plugin-panels iframe"));
  for (const candidate of candidates) {
    if (candidate.contentWindow === contentWindow) return candidate;
  }
  return null;
}

window.addEventListener("message", (incoming: MessageEvent) => {
  const owner = panelRegistry.get(incoming.source as Window);
  if (!owner) return;
  if (incoming.origin !== panelOriginFor(owner)) return;
  const packet = parsePanelMessage(incoming.data);
  if (!packet) return;
  const sourceWindow = incoming.source as Window;
  panelProtocols.set(sourceWindow, packet.protocol);
  if (packet.kind === "invoke") {
    void window.pluginPanel?.invoke(owner, packet.channel, packet.args).then((reply) => {
      const response = reply && typeof reply === "object" && "ok" in reply
        ? reply as { ok: boolean; data?: unknown; error?: string } : null;
      // 异步结果只交给发起请求的面板。
      const recipient = findContentWindow(owner);
      if (!recipient || recipient !== sourceWindow) return;
      if (response?.ok) {
        postToPanel(recipient, owner, { kind: "invoke-result", seq: packet.seq, ok: true, data: response.data });
      } else {
        postToPanel(recipient, owner, { kind: "invoke-result", seq: packet.seq, ok: false, error: response?.error ?? "面板调用失败" });
      }
    });
    return;
  }
  const frame = findIframeByContentWindow(sourceWindow);
  if (frame) frame.style.height = `${clampPanelHeight(packet.height)}px`;
});

function mountPanel(container: HTMLElement, plugin: PanelDescriptor): void {
  const shell = document.createElement("article");
  shell.className = "plugin-panel-card";
  const heading = document.createElement("div");
  heading.className = "plugin-panel-card__header";
  const name = document.createElement("h2");
  name.textContent = plugin.name;
  const release = document.createElement("span");
  release.className = "plugin-panel-card__version";
  release.textContent = `v${plugin.version}`;
  heading.append(name, release);

  const frame = document.createElement("iframe");
  // 独立插件源保留来源校验。
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute("src", `${PANEL_SCHEME}://${plugin.id}/${plugin.settingsPanel}`);
  frame.className = "plugin-panel-card__frame";
  frame.style.height = `${PANEL_MIN_HEIGHT}px`;
  shell.append(heading, frame);
  container.append(shell);
  mountedPanels.set(plugin.id, {
    signature: JSON.stringify(plugin),
    remove: () => {
      if (frame.contentWindow) {
        panelRegistry.delete(frame.contentWindow);
        panelProtocols.delete(frame.contentWindow);
      }
      shell.remove();
    },
  });
  frame.addEventListener("load", () => {
    if (!frame.isConnected || !frame.contentWindow) return;
    panelRegistry.set(frame.contentWindow, plugin.id);
    const initialTheme = buildPanelTheme(
      document.documentElement.dataset.uiTheme || "default", getComputedStyle(document.documentElement),
    );
    postToPanel(frame.contentWindow, plugin.id, { kind: "init", theme: initialTheme });
  });
}

export async function mountPluginPanels(): Promise<void> {
  if (!subscribed) {
    subscribed = true;
    const stopListening = window.plugins?.onChanged?.((snapshot) => {
      revision++;
      reconcilePanels(snapshot);
    });
    window.addEventListener("beforeunload", () => {
      stopListening?.();
      for (const mounted of mountedPanels.values()) mounted.remove();
      mountedPanels.clear();
    }, { once: true });
    observePanelTheme();
  }
  const loadRevision = revision;
  const snapshot = await window.plugins?.list();
  if (!snapshot || loadRevision !== revision) return;
  reconcilePanels(snapshot);
}

function reconcilePanels(overview: PluginOverview | PluginListEntry[]): void {
  const available = Array.isArray(overview) ? overview : overview.plugins;
  if (!Array.isArray(available)) return;
  const visibleIds = new Set(available.filter(entry => entry.enabled && entry.settingsPanel).map(entry => entry.id));
  for (const [pluginId, mounted] of mountedPanels) {
    if (visibleIds.has(pluginId)) continue;
    mounted.remove();
    mountedPanels.delete(pluginId);
  }
  const destinations: Record<string, HTMLElement | null> = {
    channels: document.getElementById("plugin-panels-channels"),
    plugins: document.getElementById("plugin-panels-plugins"),
  };
  for (const entry of available) {
    const file = entry.settingsPanel;
    if (!file || !entry.enabled) continue;
    const destination = destinations[entry.settingsSection === "channels" ? "channels" : "plugins"];
    if (!destination) continue;
    const descriptor = { id: entry.id, name: entry.name, version: entry.version, settingsPanel: file };
    const mounted = mountedPanels.get(entry.id);
    if (mounted?.signature === JSON.stringify(descriptor)) continue;
    mounted?.remove();
    mountPanel(destination, descriptor);
  }
}

function observePanelTheme(): void {
  const observer = new MutationObserver(() => {
    const current = buildPanelTheme(
      document.documentElement.dataset.uiTheme || "default", getComputedStyle(document.documentElement),
    );
    for (const [recipient, owner] of panelRegistry) {
      postToPanel(recipient, owner, { kind: "theme-changed", theme: current });
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-theme", "data-ui-colors"] });
}
