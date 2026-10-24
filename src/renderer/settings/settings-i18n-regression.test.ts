import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { test, expect } from "vitest";
import { t as translate } from "./i18n";
import { getAppChannelCard } from "./channels/view-model";

function settingsWindow() {
  const dom = new JSDOM(readFileSync(resolve(__dirname, "index.html"), "utf8"), { pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const rules = dom.window.document.createElement("style");
  rules.textContent = readFileSync(resolve(__dirname, "settings.css"), "utf8");
  dom.window.document.head.append(rules);
  return dom.window;
}

test("shared ASR copy describes full transcription and its common Mossland credential", () => {
  const copy = [translate("settings.panel.asr.subheading"), translate("settings.panel.asr.mosslandHint")];
  expect(copy).toEqual(["语音识别服务配置", "与 Mossland TTS 共用同一 API Key。上传音频后返回完整转写文本，不提供实时中间字幕。"]);
});

test("history deletion is absent and translated navigation text remains outside the icon's fixed width", () => {
  const browser = settingsWindow();
  const doc = browser.document;
  expect(doc.querySelector("#clear-chat-history-btn")).toBeNull();
  expect([...doc.querySelectorAll("button")].filter(button => button.textContent?.includes("清空记录"))).toHaveLength(0);
  const userLabel = doc.querySelector<HTMLElement>('.nav-item[data-section="user"] > [data-i18n]');
  expect(userLabel).not.toBeNull();
  const computed = browser.getComputedStyle(userLabel!);
  expect(computed.width === "18px").toBe(false);
  expect(computed.whiteSpace).toEqual("nowrap");
  browser.close();
});

test("phone overview, app availability and third-party grouping resolve to translated labels", () => {
  const none = "settings.panel.channels.overviewNone";
  const appKey = getAppChannelCard().statusKey;
  expect(translate(none)).toEqual("尚未连接任何渠道");
  expect(translate(none) === none).toBe(false);
  expect(translate(appKey)).toEqual("即将推出");
  expect(translate(appKey) === appKey).toBe(false);
  expect(translate("settings.panel.channels.appStatusComingSoon")).toEqual("即将推出");
  expect(translate("settings.panel.channels.thirdPartyTitle")).toEqual("其它渠道");
  expect(translate("settings.panel.channels.overviewCount", { total: 4, running: 1 })).toEqual("已连接 1 / 4 个渠道");
});

test.each([
  { key: "settings.profile.count", values: { count: 6 }, copy: "6 个档案" },
  { key: "settings.preset.websiteTitle", values: { shortName: "Qwen" }, copy: "前往 Qwen 官网" },
  { key: "settings.profile.editing", values: { name: "北辰" }, copy: "正在编辑「北辰」" },
  { key: "settings.profile.deleted", values: { name: "北辰" }, copy: "已删除「北辰」" },
  { key: "settings.api.endpointPreview.default", values: { defaultSuffix: "/v1/messages" }, copy: "程序会按所选协议自动追加请求路径（默认 /v1/messages）。" },
  { key: "settings.api.endpointPreview.suffix", values: { url: "https://relay.invalid/chat/completions", appendedSuffix: "/chat/completions" }, copy: "程序会自动追加 /chat/completions；最终请求地址：https://relay.invalid/chat/completions" },
  { key: "settings.api.endpointPreview.full", values: { url: "https://relay.invalid/v1/responses" }, copy: "已填写完整接口地址，不再追加后缀；最终请求地址：https://relay.invalid/v1/responses" },
  { key: "settings.api.testOk", values: { sample: "READY", latency: 73 }, copy: "连接成功 73ms · READY" },
  { key: "settings.api.testFailed", values: { error: "连接中断" }, copy: "连接失败：连接中断" },
  { key: "settings.importDoc.deleteMessage", values: { fileName: "手册.txt" }, copy: "确定删除导入知识？\n\n文件：\n《手册.txt》\n\n删除后不可恢复，如需使用请重新导入。" },
])("dynamic translation $key retains the full interpolated copy", ({ key, values, copy }) => {
  expect(translate(key, values)).toEqual(copy);
});
