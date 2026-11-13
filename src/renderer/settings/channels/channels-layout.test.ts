// @vitest-environment jsdom
/**
 * 连接手机页的结构守则：
 *   - 顶部是「连接概览」（公共设置都在里面），其后是 Firefly 手机 App 接入位，再是「其它渠道」分组
 *   - 每个第三方渠道是一张折叠卡，状态与开关在标题行（summary）里，默认收起
 *   - dom.ts / panel.ts 通过 id 取元素，这些 id 在 index.html 中必须唯一且存在
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const html = fs.readFileSync(path.join(repoRoot, "src/renderer/settings/index.html"), "utf8");
const domSource = fs.readFileSync(path.join(repoRoot, "src/renderer/settings/channels/dom.ts"), "utf8");
const panelSource = fs.readFileSync(path.join(repoRoot, "src/renderer/settings/channels/panel.ts"), "utf8");

const CHANNEL_CARD_IDS = ["wechat", "feishu", "qq", "qqbot"] as const;

function channelsPanel(): HTMLElement {
  const panel = document.getElementById("channels-panel");
  if (!panel) throw new Error("缺少 #channels-panel");
  return panel;
}

describe("连接手机页结构", () => {
  beforeEach(() => {
    document.body.innerHTML = html;
  });

  it("puts the overview card first, with every shared setting inside it", () => {
    const first = channelsPanel().querySelector<HTMLElement>(".channels-card");
    expect(first?.classList.contains("channels-overview")).toBe(true);
    for (const id of ["channels-rate-user", "channels-rate-channel", "channels-sticker-enabled", "channels-mirror-desktop", "channels-tool-sandbox-off", "channels-tool-sandbox-all"]) {
      expect(first!.querySelector(`#${id}`), id).not.toBeNull();
    }
    expect(first!.querySelector("#channels-context-source")).toBeNull();
  });

  it("shows the Firefly mobile app card right after the overview, as coming soon with pairing disabled", () => {
    const app = document.getElementById("channels-app-card");
    expect(app).not.toBeNull();
    expect(app!.previousElementSibling?.classList.contains("channels-overview")).toBe(true);
    expect(app!.querySelector("#channels-app-status")?.getAttribute("data-i18n")).toBe("panel.channels.appStatusComingSoon");
    expect((document.getElementById("channels-app-pair") as HTMLButtonElement).disabled).toBe(true);
  });

  it("groups the third-party channels under an 其它渠道 heading after the app card", () => {
    const heading = channelsPanel().querySelector<HTMLElement>(".settings-group-title");
    expect(heading?.textContent?.trim()).toBe("其它渠道");
    expect(heading!.nextElementSibling?.id).toBe("channels-wechat-card");
  });

  it.each(CHANNEL_CARD_IDS)("renders %s as a collapsed fold card with its status and switch in the title row", (id) => {
    const card = document.getElementById(`channels-${id}-card`);
    expect(card?.tagName).toBe("DETAILS");
    expect(card!.hasAttribute("open")).toBe(false);
    const summary = card!.querySelector(":scope > summary");
    expect(summary).not.toBeNull();
    expect(summary!.querySelector(`#channels-${id}-status`)).not.toBeNull();
    expect(summary!.querySelector(".switch input[type=checkbox]")).not.toBeNull();
    // 凭据 / 配对区域只在展开后可见，因此必须位于 summary 之外
    expect(card!.querySelector(`:scope > .channels-card__body #channels-${id}-status`)).toBeNull();
  });

  it("keeps the WeChat QR modal inside the WeChat card so the card can be opened for scanning", () => {
    const qr = document.getElementById("channels-wechat-qr");
    expect(document.getElementById("channels-wechat-card")!.contains(qr)).toBe(true);
  });
});

describe("连接手机页的 id 契约", () => {
  it("every element id that dom.ts queries exists exactly once in index.html", () => {
    const queried = [...domSource.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(queried.length).toBeGreaterThan(0);
    for (const id of queried) {
      const count = html.split(`id="${id}"`).length - 1;
      expect(count, `id ${id}`).toBe(1);
    }
  });

  it("panel.ts gets every card and overview element it toggles through dom.ts", () => {
    for (const name of ["channelsOverviewSummaryEl", "channelsAppStatusEl", "channelsAppPairBtn", "channelsWechatCardEl", "channelsFeishuCardEl", "channelsQqCardEl", "channelsQqBotCardEl"]) {
      expect(panelSource, name).toContain(name);
      expect(domSource, name).toContain(`export const ${name}`);
    }
  });
});


describe("channel guidance rendered in the settings page", () => {
  const hints = [
    ["toolPermissionAllDesc", "已准入的私聊开启后使用 Work，工具直接执行，可读写文件、运行命令；渠道无法交互审批。QQ 和官方 QQ 群聊始终禁用工具。请仅对可信身份开启。"],
    ["qqToken", "Access Token（非回环监听必填）"],
    ["qqHint2", "群聊仅响应白名单群中的 @，并强制禁用工具；记忆按账号、发送者、群和线程隔离。请只添加可信群。"],
    ["qqBotHint1", "在 q.qq.com 创建机器人后填入 AppID / AppSecret。请遵守平台账号与内容规则。"],
    ["qqBotHint2", "当前仅文本被动回复，本地限制为单聊 60 分钟内 4 次、群聊 5 分钟内 5 次；群消息按 openid 白名单准入，实际事件受平台权限影响，群聊强制禁用工具。"],
    ["qqBotHint3", "请根据开放平台当前环境配置测试用户、群和权限，发布前核对平台规则。"],
    ["feishuHint4", "创建自建应用并开启机器人能力，配置消息事件、所需权限与版本发布，再填入 App ID/Secret 连接；首次陌生发送者需批准。"],
  ];
  it.each(hints)("renders %s with the current channel boundary in fallback HTML and Chinese translations", async (key, expected) => {
    document.body.innerHTML = html;
    const { t } = await import("../i18n");
    const node = channelsPanel().querySelector(`[data-i18n="panel.channels.${key}"]`);
    expect(node).not.toBeNull();
    expect(node!.textContent).toEqual(expected);
    expect(t(`settings.panel.channels.${key}`)).toEqual(expected);
  });
});
