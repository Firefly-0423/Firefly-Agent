// 插件面板桥在渲染端使用的消息格式。
export const PANEL_PROTOCOL = "firefly-panel/1";
type PanelProtocol = typeof PANEL_PROTOCOL;
export const PANEL_MIN_HEIGHT = 120, PANEL_MAX_HEIGHT = 800;
export const PANEL_SCHEME = "firefly-plugin";

export interface PanelInvokeMessage {
  protocol: PanelProtocol; kind: "invoke";
  seq: number; channel: string; args: unknown[];
}
export interface PanelHeightMessage {
  protocol: PanelProtocol; kind: "height"; height: number;
}
export type PanelInboundMessage = PanelInvokeMessage | PanelHeightMessage;
export interface PanelTheme { name: string; tokens: Record<string, string> }

export function panelOriginFor(pluginId: string): string {
  return PANEL_SCHEME + "://" + pluginId;
}

export function clampPanelHeight(height: number): number {
  if (!Number.isFinite(height)) { return PANEL_MIN_HEIGHT; }
  const rounded = Math.round(height);
  const lowerBounded = Math.max(PANEL_MIN_HEIGHT, rounded);
  return Math.min(PANEL_MAX_HEIGHT, lowerBounded);
}

// 只向后续处理传递协议声明的字段。
export function parsePanelMessage(data: unknown): PanelInboundMessage | null {
  if (data === null || typeof data !== "object") { return null; }
  const candidate = data as Record<string, unknown>;
  if (candidate.protocol !== PANEL_PROTOCOL) { return null; }
  switch (candidate.kind) {
    case "invoke":
      if (typeof candidate.seq !== "number") { return null; }
      if (typeof candidate.channel !== "string") { return null; }
      if (!Array.isArray(candidate.args)) { return null; }
      return {
        protocol: candidate.protocol, kind: "invoke", seq: candidate.seq,
        channel: candidate.channel, args: candidate.args,
      };
    case "height":
      if (typeof candidate.height !== "number") { return null; }
      return { protocol: candidate.protocol, kind: "height", height: candidate.height };
    default: return null;
  }
}

export function collectThemeTokens(computedStyle: CSSStyleDeclaration): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const cssName of Array.from(computedStyle)) {
    if (!cssName.startsWith("--")) continue;
    collected[cssName] = computedStyle.getPropertyValue(cssName).trim();
  }
  return collected;
}

export function buildPanelTheme(themeName: string, computedStyle: CSSStyleDeclaration): PanelTheme {
  const theme: PanelTheme = { name: themeName, tokens: collectThemeTokens(computedStyle) };
  return theme;
}
