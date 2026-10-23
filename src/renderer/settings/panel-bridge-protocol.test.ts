import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { test, expect } from "vitest";
import * as protocol from "./panel-bridge-protocol";

const bridgeAsset = () => readFileSync(resolve(__dirname, "../../main/plugin-panel/panel-bridge.js"), "utf8");

test.each(["weather-desk", "quiet-radio"])("plugin %s supplies the host part of its private origin", id => {
  expect(protocol.panelOriginFor(id)).toEqual(`firefly-plugin://${id}`);
});

test.each([
  [463.7, 464], [0, protocol.PANEL_MIN_HEIGHT], [-23, protocol.PANEL_MIN_HEIGHT],
  [50_321, protocol.PANEL_MAX_HEIGHT], [NaN, protocol.PANEL_MIN_HEIGHT], [Infinity, protocol.PANEL_MIN_HEIGHT],
])("requested height %s rounds and clamps to %s", (height, expected) => {
  expect(protocol.clampPanelHeight(height)).toEqual(expected);
});

test("incoming invocations and height reports keep all their protocol fields", () => {
  const envelope = protocol.PANEL_PROTOCOL;
  const request = { channel: "weather.read", args: ["tomorrow", 7], seq: 29, kind: "invoke", protocol: envelope };
  const resize = { height: 486, kind: "height", protocol: envelope };
  expect(protocol.parsePanelMessage(request)).toEqual(request);
  expect(protocol.parsePanelMessage(resize)).toEqual(resize);
});

test.each([
  { label: "null", message: null }, { label: "primitive", message: "string" },
  { label: "missing envelope", message: { kind: "invoke" } },
  { label: "foreign protocol", message: { protocol: "other/1", kind: "invoke" } },
  { label: "text sequence", message: { protocol: protocol.PANEL_PROTOCOL, kind: "invoke", seq: "29", args: [], channel: "weather.read" } },
  { label: "numeric channel", message: { protocol: protocol.PANEL_PROTOCOL, kind: "invoke", seq: 29, args: [], channel: 82 } },
  { label: "non-array arguments", message: { protocol: protocol.PANEL_PROTOCOL, kind: "invoke", seq: 29, args: "invalid", channel: "weather.read" } },
  { label: "text height", message: { protocol: protocol.PANEL_PROTOCOL, kind: "height", height: "wide" } },
  { label: "outgoing-only init", message: { protocol: protocol.PANEL_PROTOCOL, kind: "init", theme: {} } },
])("incoming parser discards $label", ({ message }) => {
  expect(protocol.parsePanelMessage(message)).toBeNull();
});

test("theme collection strips whitespace and excludes ordinary CSS properties", () => {
  const declaration = Object.assign(["--surface", "--outline", "display"], {
    getPropertyValue: (key: string) => key === "--surface" ? " #263c51 " : "2px dotted teal",
  }) as unknown as CSSStyleDeclaration;
  expect(protocol.collectThemeTokens(declaration)).toStrictEqual({ "--outline": "2px dotted teal", "--surface": "#263c51" });
});

test("the shipped bridge sends the shared envelope and only accepts the parent response", async () => {
  const sent: Array<{ seq: number; protocol: string }> = [];
  const events: Record<string, (event: unknown) => void> = {};
  const parentWindow = { postMessage: (payload: typeof sent[number]) => sent.push(payload) };
  const child = { parent: parentWindow, addEventListener: (type: string, handler: (event: unknown) => void) => { events[type] = handler; } } as {
    parent: typeof parentWindow;
    addEventListener: (type: string, handler: (event: unknown) => void) => void;
    FireflyPanel?: { invoke: (channel: string) => Promise<unknown> };
  };
  const script = bridgeAsset();
  runInNewContext(script, { window: child });
  const invocation = child.FireflyPanel!.invoke("weather.read");
  expect(sent[0].protocol).toEqual("firefly-panel/1");
  let completed = false;
  void invocation.then(() => { completed = true; });
  const reply = { protocol: "firefly-panel/1", kind: "invoke-result", seq: sent[0].seq, ok: true, data: "forecast accepted" };
  events.message({ data: reply, source: {} });
  await Promise.resolve();
  expect(completed).toEqual(false);
  events.message({ data: reply, source: parentWindow });
  await expect(invocation).resolves.toEqual("forecast accepted");
});
