import { channelsState } from "./state";
import * as fields from "./dom";
import {
  CHANNEL_CARD_IDS, type ChannelCardId, type ChannelStatusMap,
  getAppChannelCard, pickInitiallyExpandedChannel, summarizeChannelOverview,
} from "./view-model";
import { t } from "../i18n";
import { proactiveDeliverySelect } from "../general/dom";
import { normalizeProactiveDeliveryTarget } from "../../../shared/preferences";
import { isProactiveDeliveryTargetSelectable } from "../../../shared/proactive-delivery";
import type { QqListenAuthRequirement } from "../../../shared/qq-listen";
import { showConfirm } from "../shared/modal";
import { initSenderPanels } from "./sender-panel";

type SettingsBridge = NonNullable<Window["settings"]>;
type FeedbackKind = "info" | "ok" | "err";
type ChannelSnapshot = Record<string, { phase: string; message?: string; detail?: Record<string, unknown> }>;
type ContextBindingSnapshot = Awaited<ReturnType<SettingsBridge["channelsContextBindingsGet"]>>;

export function renderProactiveDeliveryAvailability(statuses: Record<string, { phase?: string }>): void {
  const options = proactiveDeliverySelect.querySelectorAll<HTMLButtonElement>(".option-block");
  options.forEach(option => {
    const destination = normalizeProactiveDeliveryTarget(option.dataset.value);
    const state = destination === "local" ? undefined : statuses[destination];
    option.disabled = !isProactiveDeliveryTargetSelectable(destination, state);
  });
}

function renderChannelStatus(el: HTMLElement | null, phase: string, message?: string): void {
  if (!el) return;
  const indicator = el.querySelector(".channels-status__dot");
  const caption = el.querySelector(".channels-status__text");
  if (indicator) {
    indicator.className = "channels-status__dot";
    const modifier = phase === "running" || phase === "starting" || phase === "error" || phase === "config_missing"
      ? phase : "offline";
    indicator.classList.add(`channels-status__dot--${modifier}`);
  }
  if (caption) caption.textContent = message ?? (phase === "running" ? "运行中" : phase === "starting" ? "启动中" : phase === "config_missing" ? "配置缺失" : phase === "error" ? "错误" : "未启用");
}

function renderOverview(statuses: ChannelStatusMap): void {
  if (!fields.channelsOverviewSummaryEl) return;
  const counts = summarizeChannelOverview(statuses);
  fields.channelsOverviewSummaryEl.textContent = counts.running === 0
    ? t("settings.panel.channels.overviewNone")
    : t("settings.panel.channels.overviewCount", { running: counts.running, total: counts.total });
}

const channelCardEls: Record<ChannelCardId, HTMLElement | null> = {
  wechat: fields.channelsWechatCardEl, feishu: fields.channelsFeishuCardEl,
  qq: fields.channelsQqCardEl, qqbot: fields.channelsQqBotCardEl,
};
function setChannelCardOpen(id: ChannelCardId, open: boolean): void {
  const card = channelCardEls[id];
  if (!card) return;
  if (open) card.setAttribute("open", "");
  else card.removeAttribute("open");
}
function expandInitialChannelCard(statuses: ChannelStatusMap): void {
  const initiallyOpen = pickInitiallyExpandedChannel(statuses);
  for (const cardId of CHANNEL_CARD_IDS) setChannelCardOpen(cardId, cardId === initiallyOpen);
}
function applyAppChannelCard(): void {
  const presentation = getAppChannelCard();
  if (fields.channelsAppStatusEl) {
    fields.channelsAppStatusEl.dataset.status = presentation.status;
    fields.channelsAppStatusEl.setAttribute("data-i18n", presentation.statusKey);
    fields.channelsAppStatusEl.textContent = t(presentation.statusKey);
  }
  if (fields.channelsAppPairBtn) fields.channelsAppPairBtn.disabled = presentation.pairDisabled;
}

function feedback(element: HTMLElement | null, kind: FeedbackKind, text: string): void {
  if (!element) return;
  element.textContent = text;
  element.className = "channels-feedback";
  element.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}
function setFeishuFeedback(kind: FeedbackKind, msg: string): void { feedback(fields.channelsFeishuFeedbackEl, kind, msg); }
function setQqFeedback(kind: FeedbackKind, msg: string): void { feedback(fields.channelsQqFeedbackEl, kind, msg); }
function setQqBotFeedback(kind: FeedbackKind, msg: string): void { feedback(fields.channelsQqBotFeedbackEl, kind, msg); }
function setContextFeedback(kind: FeedbackKind, message: string): void { feedback(fields.channelsContextFeedbackEl, kind, message); }
function errorText(failure: unknown): string { return failure instanceof Error ? failure.message : String(failure); }

function parseIdList(value: string): string[] {
  const candidates = value.split(/[\s,，]+/u).map(part => part.trim());
  return Array.from(new Set(candidates.filter(part => /^\d+$/u.test(part))));
}
function parseOpenidList(value: string): string[] {
  const candidates = value.split(/[\s,，]+/u).map(part => part.trim());
  return Array.from(new Set(candidates.filter(part => /^[A-Za-z0-9_-]{8,64}$/u.test(part))));
}
async function copyInputValue(input: HTMLInputElement | null, label: string): Promise<void> {
  const content = input?.value ?? "";
  if (!content) throw new Error(`${label}为空`);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  input!.select();
  if (!document.execCommand("copy")) throw new Error(`无法复制${label}`);
}
function renderQqDetail(status?: { detail?: Record<string, unknown> }): void {
  const address = status?.detail?.listenUrl;
  if (fields.channelsQqUrlEl) fields.channelsQqUrlEl.value = typeof address === "string" ? address : "";
}
function renderQqBotDetail(status?: { detail?: Record<string, unknown> }): void {
  const blockedSender = status?.detail?.lastRejectedOpenid;
  if (typeof blockedSender === "string" && blockedSender) {
    setQqBotFeedback("info", `最近一条被白名单拒绝的消息来自 openid：${blockedSender}（复制到上方白名单可放行）`);
  }
}

export interface LogEntry {
  at: string; dir: "incoming" | "outgoing";
  channel: string; senderId: string; senderName?: string;
  chatId: string; text: string; hasAttachments?: boolean;
}
export function renderChannelsLog(entries: LogEntry[]): void {
  if (!fields.channelsLogListEl) return;
  if (!entries.length) {
    fields.channelsLogListEl.innerHTML = '<p class="empty-hint">暂无消息。</p>';
    return;
  }
  const rendered = entries.map(entry => {
    const instant = new Date(entry.at);
    const hours = String(instant.getHours()).padStart(2, "0");
    const minutes = String(instant.getMinutes()).padStart(2, "0");
    const seconds = String(instant.getSeconds()).padStart(2, "0");
    const direction = entry.dir === "incoming" ? "← 收到" : "→ 回复";
    const sender = entry.senderName ? `${entry.senderName} (${entry.senderId})` : entry.senderId;
    const escape = (raw: string): string => raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const body = entry.text.length > 280 ? escape(entry.text.slice(0, 280)) + "…" : escape(entry.text);
    return `<div class="channels-log__entry channels-log__entry--${entry.dir}">
        <div class="channels-log__meta">${hours}:${minutes}:${seconds} · ${direction} · ${escape(entry.channel)} · ${escape(sender)}</div>
        <div class="channels-log__text">${body}</div>
      </div>`;
  }).join("");
  fields.channelsLogListEl.innerHTML = rendered;
}
export async function refreshChannelsLog(): Promise<void> {
  const bridge = window.settings;
  if (!bridge) return;
  try {
    const fetched = await bridge.channelsLogGet(100) as LogEntry[];
    renderChannelsLog(fetched);
  } catch (failure) {
    console.warn("[Channels] refreshChannelsLog 失败:", failure);
  }
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const choice = document.createElement("option");
  choice.value = value;
  choice.textContent = label;
  select.append(choice);
}
function renderContextBindingOptions(snapshot: ContextBindingSnapshot): void {
  const sources = fields.channelsContextSourceEl;
  if (sources) {
    sources.replaceChildren();
    if (!snapshot.externalChats.length) appendOption(sources, "", "暂无最近聊天");
    else for (const external of snapshot.externalChats) {
      const category = external.chatType === "group" ? "群聊" : "私聊";
      const displayName = external.senderName || external.chatId;
      appendOption(sources, external.sessionId, `${external.channel} · ${category} · ${displayName} (${external.chatId})`);
    }
  }
  const targets = fields.channelsContextTargetEl;
  if (targets) {
    targets.replaceChildren();
    if (!snapshot.conversations.length) appendOption(targets, "", "暂无可用对话");
    else for (const desktop of snapshot.conversations) {
      appendOption(targets, desktop.id, `${desktop.title || "新对话"} · ${desktop.mode}`);
    }
  }
}
function renderContextBindings(snapshot: ContextBindingSnapshot): void {
  const list = fields.channelsContextBindingsListEl;
  if (!list) return;
  list.replaceChildren();
  if (!snapshot.bindings.length) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent = "暂无绑定。";
    list.append(hint);
    return;
  }
  const bySession = new Map(snapshot.externalChats.map(external => [external.sessionId, external]));
  const byConversation = new Map(snapshot.conversations.map(desktop => [desktop.id, desktop]));
  for (const link of snapshot.bindings) {
    const external = bySession.get(link.sessionId);
    const desktop = byConversation.get(link.conversationId);
    const item = document.createElement("div");
    item.className = "channels-context-binding";
    const description = document.createElement("span");
    description.textContent = `${external?.channel ?? "外部聊天"} · ${external?.senderName || external?.chatId || link.sessionId} → ${desktop?.title || link.conversationId}`;
    item.append(description);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-secondary";
    remove.textContent = "解除";
    remove.addEventListener("click", async () => {
      setContextFeedback("info", "解除中...");
      try {
        const response = await window.settings!.channelsContextUnbind(link.sessionId);
        if (!response.ok) throw new Error(response.error ?? "解除失败");
        setContextFeedback("ok", "已解除上下文绑定");
        await refreshContextBindings();
      } catch (failure) { setContextFeedback("err", errorText(failure)); }
    });
    item.append(remove);
    list.append(item);
  }
}
export async function refreshContextBindings(): Promise<void> {
  try {
    const current = await window.settings!.channelsContextBindingsGet();
    renderContextBindingOptions(current);
    renderContextBindings(current);
  } catch (failure) { setContextFeedback("err", errorText(failure)); }
}

function renderStatusSnapshot(status: ChannelSnapshot, senders: ReturnType<typeof initSenderPanels>): void {
  renderProactiveDeliveryAvailability(status);
  senders.renderStatus(status);
  renderChannelStatus(fields.channelsWechatStatusEl, status.wechat?.phase ?? "offline", status.wechat?.message);
  renderChannelStatus(fields.channelsFeishuStatusEl, status.feishu?.phase ?? "offline", status.feishu?.message);
  renderChannelStatus(fields.channelsQqStatusEl, status.qq?.phase ?? "offline", status.qq?.message);
  renderQqDetail(status.qq);
  renderChannelStatus(fields.channelsQqBotStatusEl, status.qqbot?.phase ?? "offline", status.qqbot?.message);
  renderQqBotDetail(status.qqbot);
  renderOverview(status);
}

export async function loadChannelsPanel(): Promise<void> {
  const bridge = window.settings;
  if (!bridge) return;
  if (channelsState.initialized) {
    await refreshContextBindings();
    return;
  }
  channelsState.initialized = true;
  applyAppChannelCard();
  const senders = initSenderPanels(bridge);
  let hadQqToken = false;
  try {
    const config = await bridge.channelsGetConfig();
    if (fields.channelsWechatEnabledEl) fields.channelsWechatEnabledEl.checked = !!config.wechat.enabled;
    if (fields.channelsFeishuEnabledEl) fields.channelsFeishuEnabledEl.checked = !!config.feishu.enabled;
    senders.fillConfig(config);
    if (fields.channelsQqEnabledEl) fields.channelsQqEnabledEl.checked = !!config.qq?.enabled;
    if (fields.channelsRateUserEl) fields.channelsRateUserEl.value = String(config.rateLimitPerUser ?? 10);
    if (fields.channelsRateChannelEl) fields.channelsRateChannelEl.value = String(config.rateLimitPerChannel ?? 100);
    if (fields.channelsStickerEl) fields.channelsStickerEl.checked = config.stickerEnabled !== false;
    if (fields.channelsMirrorEl) fields.channelsMirrorEl.checked = config.mirrorToDesktop !== false;
    if (fields.channelsToolSandboxOffEl) fields.channelsToolSandboxOffEl.checked = config.toolSandbox === "off";
    if (fields.channelsToolSandboxAllEl) fields.channelsToolSandboxAllEl.checked = config.toolSandbox === "all";
    if (fields.channelsFeishuAppIdEl) fields.channelsFeishuAppIdEl.value = config.feishu.appId ?? "";
    if (fields.channelsFeishuAppSecretEl) {
      fields.channelsFeishuAppSecretEl.value = "";
      fields.channelsFeishuAppSecretEl.placeholder = config.feishu.appSecret ? "已保存（输入新值会覆盖）" : "点击保存配置时加密保存";
    }
    if (fields.channelsQqListenModeEl) fields.channelsQqListenModeEl.value = config.qq?.listenMode ?? "auto";
    if (fields.channelsQqCustomHostEl) fields.channelsQqCustomHostEl.value = config.qq?.customHost ?? "";
    if (fields.channelsQqPortEl) fields.channelsQqPortEl.value = String(config.qq?.port ?? 6200);
    if (fields.channelsQqPrivateAllowlistEl) fields.channelsQqPrivateAllowlistEl.value = (config.qq?.allowedPrivateUserIds ?? []).join("\n");
    if (fields.channelsQqGroupAllowlistEl) fields.channelsQqGroupAllowlistEl.value = (config.qq?.allowedGroupIds ?? []).join("\n");
    if (fields.channelsQqTokenEl) fields.channelsQqTokenEl.placeholder = config.qq?.hasAccessToken
      ? "已保存（输入新值会覆盖）" : "留空仅允许本机 127.0.0.1 监听；WSL/跨网卡请先生成";
    hadQqToken = !!config.qq?.hasAccessToken;
    if (fields.channelsQqBotEnabledEl) fields.channelsQqBotEnabledEl.checked = !!config.qqbot?.enabled;
    if (fields.channelsQqBotAppIdEl) fields.channelsQqBotAppIdEl.value = config.qqbot?.appId ?? "";
    if (fields.channelsQqBotAppSecretEl) {
      fields.channelsQqBotAppSecretEl.value = "";
      fields.channelsQqBotAppSecretEl.placeholder = config.qqbot?.hasAppSecret ? "已保存（输入新值会覆盖）" : "点击保存配置时加密保存";
    }
    if (fields.channelsQqBotAllowAnyPrivateEl) fields.channelsQqBotAllowAnyPrivateEl.checked = !!config.qqbot?.allowAnyPrivate;
    if (fields.channelsQqBotUserAllowlistEl) fields.channelsQqBotUserAllowlistEl.value = (config.qqbot?.allowedUserOpenids ?? []).join("\n");
    if (fields.channelsQqBotGroupAllowlistEl) fields.channelsQqBotGroupAllowlistEl.value = (config.qqbot?.allowedGroupOpenids ?? []).join("\n");
    const current = await bridge.channelsGetStatus() as ChannelSnapshot;
    renderStatusSnapshot(current, senders);
    expandInitialChannelCard(current);
    void refreshChannelsLog();
    void refreshContextBindings();
  } catch (failure) { console.warn("[Channels] loadChannelsPanel 失败:", failure); }

  // 按初始化顺序登记各组控件与订阅。
  bindSharedControls(bridge);
  bridge.onChannelsInstallProgress(progress => {
    const indicator = progress.channel === "wechat" ? fields.channelsWechatStatusEl
      : progress.channel === "feishu" ? fields.channelsFeishuStatusEl
        : progress.channel === "qq" ? fields.channelsQqStatusEl : null;
    if (indicator) renderChannelStatus(indicator, "starting", `${progress.phase} ${progress.pct}%`);
  });
  bridge.onChannelsStatusChanged(current => renderStatusSnapshot(current as ChannelSnapshot, senders));
  bindFeishuControls(bridge);
  bindWechatControls(bridge);
  bindQqControls(bridge, hadQqToken);
  bindQqBotControls(bridge);
  fields.channelsLogRefreshBtn?.addEventListener("click", () => void refreshChannelsLog());
  fields.channelsLogClearBtn?.addEventListener("click", async () => {
    const authorized = await showConfirm({
      title: "清空消息日志", message: "确认清空所有 bot 消息日志？", confirmText: "清空", dangerous: true,
    });
    if (!authorized) return;
    await bridge.channelsLogClear();
    await refreshChannelsLog();
  });
}

function bindSharedControls(bridge: SettingsBridge): void {
  const scheduleSave = (): void => {
    if (channelsState.saveTimer != null) window.clearTimeout(channelsState.saveTimer);
    channelsState.saveTimer = window.setTimeout(() => {
      void bridge.channelsSaveConfig({
        wechat: { enabled: fields.channelsWechatEnabledEl?.checked ?? false },
        feishu: { enabled: fields.channelsFeishuEnabledEl?.checked ?? false },
        qq: { enabled: fields.channelsQqEnabledEl?.checked ?? false },
        qqbot: { enabled: fields.channelsQqBotEnabledEl?.checked ?? false },
        rateLimitPerUser: Number(fields.channelsRateUserEl?.value) || 10,
        rateLimitPerChannel: Number(fields.channelsRateChannelEl?.value) || 100,
        stickerEnabled: fields.channelsStickerEl?.checked ?? true,
        mirrorToDesktop: fields.channelsMirrorEl?.checked ?? true,
        toolSandbox: fields.channelsToolSandboxOffEl?.checked ? "off" : "all",
      });
    }, 200);
  };
  const watched = [
    fields.channelsWechatEnabledEl, fields.channelsFeishuEnabledEl, fields.channelsQqEnabledEl,
    fields.channelsQqBotEnabledEl, fields.channelsRateUserEl, fields.channelsRateChannelEl,
    fields.channelsStickerEl, fields.channelsMirrorEl, fields.channelsToolSandboxOffEl, fields.channelsToolSandboxAllEl,
  ];
  for (const input of watched) input?.addEventListener("change", scheduleSave);
  fields.channelsContextBindBtn?.addEventListener("click", async () => {
    const externalId = fields.channelsContextSourceEl?.value ?? "";
    const desktopId = fields.channelsContextTargetEl?.value ?? "";
    if (!externalId || !desktopId) {
      setContextFeedback("err", "请先选择外部聊天和桌面对话");
      return;
    }
    setContextFeedback("info", "绑定中...");
    try {
      const response = await bridge.channelsContextBind({ sessionId: externalId, conversationId: desktopId });
      if (!response.ok) throw new Error(response.error ?? "绑定失败");
      setContextFeedback("ok", "上下文绑定已保存");
      await refreshContextBindings();
    } catch (failure) { setContextFeedback("err", errorText(failure)); }
  });
}

function bindFeishuControls(bridge: SettingsBridge): void {
  fields.channelsFeishuAppSecretRevealBtn?.addEventListener("click", () => {
    if (!fields.channelsFeishuAppSecretEl) return;
    fields.channelsFeishuAppSecretEl.type = fields.channelsFeishuAppSecretEl.type === "password" ? "text" : "password";
  });
  fields.channelsFeishuSaveBtn?.addEventListener("click", async () => {
    setFeishuFeedback("info", "保存并连接中...");
    const update: Record<string, unknown> = {
      feishu: { enabled: fields.channelsFeishuEnabledEl?.checked ?? false, appId: fields.channelsFeishuAppIdEl?.value.trim() || undefined },
    };
    if (fields.channelsFeishuAppSecretEl?.value) (update.feishu as Record<string, unknown>).appSecret = fields.channelsFeishuAppSecretEl.value;
    try {
      await bridge.channelsSaveConfig(update);
      await bridge.channelsRestart();
      setFeishuFeedback("ok", "已保存，飞书长连接正在建立…");
      if (fields.channelsFeishuAppSecretEl) {
        fields.channelsFeishuAppSecretEl.value = "";
        fields.channelsFeishuAppSecretEl.placeholder = "已保存（输入新值会覆盖）";
      }
    } catch (failure) { setFeishuFeedback("err", errorText(failure)); }
  });
}

function bindWechatControls(bridge: SettingsBridge): void {
  function setWechatFeedback(kind: FeedbackKind, msg: string): void { feedback(fields.channelsWechatFeedbackEl, kind, msg); }
  const qrOverlay = document.getElementById("channels-wechat-qr");
  const qrImage = document.getElementById("channels-wechat-qr-img") as HTMLImageElement | null;
  const qrClose = document.getElementById("channels-wechat-qr-close");
  const qrBackdrop = document.getElementById("channels-wechat-qr-backdrop");
  function showWechatQr(dataUrl: string): void {
    setChannelCardOpen("wechat", true);
    if (qrImage) {
      qrImage.src = dataUrl;
      qrImage.classList.remove("is-empty");
    }
    qrOverlay?.removeAttribute("hidden");
  }
  function hideWechatQr(): void {
    qrOverlay?.setAttribute("hidden", "");
    if (qrImage) {
      qrImage.src = "";
      qrImage.classList.add("is-empty");
    }
  }
  qrClose?.addEventListener("click", hideWechatQr);
  qrBackdrop?.addEventListener("click", hideWechatQr);
  document.addEventListener("keydown", key => {
    if (key.key === "Escape" && qrOverlay && !qrOverlay.hasAttribute("hidden")) hideWechatQr();
  });
  bridge.onChannelsWechatQrcode(dataUrl => {
    console.log("[WechatSettings] QR event received, dataUrl prefix:", dataUrl?.slice(0, 40), "len:", dataUrl?.length);
    showWechatQr(dataUrl);
    setWechatFeedback("info", "请用微信扫描二维码");
  });
  bridge.onChannelsWechatLoginDone(result => {
    hideWechatQr();
    if (result.ok) setWechatFeedback("ok", `已登录（botId=${result.botId ?? "?"}）`);
    else setWechatFeedback("err", `登录失败：${result.error ?? "未知错误"}`);
  });
  fields.channelsWechatLoginBtn?.addEventListener("click", async () => {
    hideWechatQr();
    setWechatFeedback("info", "正在启动扫码…");
    try {
      const started = await bridge.channelsWechatLoginStart();
      if (started.ok) setWechatFeedback("info", "等待二维码推送…");
      else setWechatFeedback("err", started.error ?? "启动失败");
    } catch (failure) { setWechatFeedback("err", errorText(failure)); }
  });
  fields.channelsWechatRestartBtn?.addEventListener("click", async () => {
    setWechatFeedback("info", "重启连接中…");
    try {
      await bridge.channelsRestart();
      setWechatFeedback("ok", "已重启");
    } catch (failure) { setWechatFeedback("err", errorText(failure)); }
  });
}

function bindQqControls(bridge: SettingsBridge, hadQqToken: boolean): void {
  fields.channelsQqListenModeEl?.addEventListener("change", function () {
    if (fields.channelsQqCustomHostEl) fields.channelsQqCustomHostEl.disabled = this.value !== "custom";
  });
  if (fields.channelsQqCustomHostEl && fields.channelsQqListenModeEl) fields.channelsQqCustomHostEl.disabled = fields.channelsQqListenModeEl.value !== "custom";
  fields.channelsQqTokenGenerateBtn?.addEventListener("click", () => {
    if (!fields.channelsQqTokenEl) return;
    const random = crypto.getRandomValues(new Uint8Array(32));
    fields.channelsQqTokenEl.value = Array.from(random, item => item.toString(16).padStart(2, "0")).join("");
    fields.channelsQqTokenEl.type = "text";
    fields.channelsQqTokenEl.select();
    setQqFeedback("info", "已生成 Token，请复制到 NapCat WebSocket Client 配置后再保存。");
  });
  fields.channelsQqUrlCopyBtn?.addEventListener("click", () => {
    void copyInputValue(fields.channelsQqUrlEl, "连接 URL")
      .then(() => setQqFeedback("ok", "连接 URL 已复制。"))
      .catch(failure => setQqFeedback("err", errorText(failure)));
  });
  fields.channelsQqTokenCopyBtn?.addEventListener("click", () => {
    void copyInputValue(fields.channelsQqTokenEl, "Token")
      .then(() => setQqFeedback("ok", "Token 已复制；保存后将无法从设置页读取明文。"))
      .catch(failure => setQqFeedback("err", errorText(failure)));
  });
  fields.channelsQqSaveBtn?.addEventListener("click", async () => {
    const mode = fields.channelsQqListenModeEl?.value ?? "auto";
    const host = fields.channelsQqCustomHostEl?.value ?? "";
    const enabled = fields.channelsQqEnabledEl?.checked ?? false;
    // 监听地址依赖主进程可见的网卡信息。
    if (enabled) {
      let auth: QqListenAuthRequirement;
      try { auth = await bridge.channelsQqResolveAuthRequirement({ listenMode: mode, customHost: host }); }
      catch (failure) { setQqFeedback("err", errorText(failure)); return; }
      if (!auth.ok) {
        setQqFeedback("err", auth.error ?? "无法解析监听地址，请检查监听模式与自定义地址。");
        return;
      }
      if (fields.channelsQqTokenEl && auth.requiresAccessToken && !fields.channelsQqTokenEl.value && !hadQqToken) {
        const random = crypto.getRandomValues(new Uint8Array(32));
        fields.channelsQqTokenEl.value = Array.from(random, item => item.toString(16).padStart(2, "0")).join("");
        fields.channelsQqTokenEl.type = "text";
        fields.channelsQqTokenEl.select();
        setQqFeedback("info", `监听地址 ${auth.resolvedHost} 非回环，需要 Access Token：已自动生成，请先复制到 NapCat WebSocket Client 的 Token 字段，再回来点击保存。`);
        return;
      }
    }
    setQqFeedback("info", "正在保存并启动 QQ 监听…");
    const update: Record<string, unknown> = {
      enabled: fields.channelsQqEnabledEl?.checked ?? false,
      listenMode: mode,
      customHost: fields.channelsQqCustomHostEl?.value.trim() || undefined,
      port: Number(fields.channelsQqPortEl?.value) || 6200,
      allowedPrivateUserIds: parseIdList(fields.channelsQqPrivateAllowlistEl?.value ?? ""),
      allowedGroupIds: parseIdList(fields.channelsQqGroupAllowlistEl?.value ?? ""),
    };
    if (fields.channelsQqTokenEl?.value) update.accessToken = fields.channelsQqTokenEl.value;
    try {
      await bridge.channelsSaveConfig({ qq: update });
      if (update.accessToken) hadQqToken = true;
      await bridge.channelsRestart();
      const current = await bridge.channelsGetStatus() as Record<string, { phase?: string; message?: string; detail?: Record<string, unknown> }>;
      renderQqDetail(current.qq);
      if (fields.channelsQqTokenEl) {
        fields.channelsQqTokenEl.value = "";
        fields.channelsQqTokenEl.type = "password";
        fields.channelsQqTokenEl.placeholder = "已保存（输入新值会覆盖）";
      }
      setQqFeedback("ok", "已启动监听；请在 NapCat 中新增 WebSocket Client，并使用上方 URL。");
    } catch (failure) { setQqFeedback("err", errorText(failure)); }
  });
  fields.channelsQqTestBtn?.addEventListener("click", async () => {
    setQqFeedback("info", "正在检查 NapCat 连接…");
    try {
      const response = await bridge.channelsQqTestConnection();
      setQqFeedback(response.ok ? "ok" : "err", response.ok
        ? `连接正常：${response.detail?.nickname ? `${String(response.detail.nickname)} (` : "QQ "}${String(response.detail?.selfId ?? "")}${response.detail?.nickname ? ")" : ""}${response.detail?.appVersion ? ` · NapCat ${String(response.detail.appVersion)}` : ""} · Stream ${response.detail?.supportsStream ? "可用" : "不可用"}`
        : response.error ?? "连接失败");
    } catch (failure) { setQqFeedback("err", errorText(failure)); }
  });
}

function bindQqBotControls(bridge: SettingsBridge): void {
  fields.channelsQqBotSaveBtn?.addEventListener("click", async () => {
    const applicationId = fields.channelsQqBotAppIdEl?.value.trim() ?? "";
    if (!applicationId) {
      setQqBotFeedback("err", "请先填写 AppID（q.qq.com → 机器人开发设置里获取）。");
      return;
    }
    setQqBotFeedback("info", "正在保存并连接 QQ 开放平台网关…");
    const update: Record<string, unknown> = {
      enabled: fields.channelsQqBotEnabledEl?.checked ?? false,
      appId: applicationId,
      allowAnyPrivate: fields.channelsQqBotAllowAnyPrivateEl?.checked ?? false,
      allowedUserOpenids: parseOpenidList(fields.channelsQqBotUserAllowlistEl?.value ?? ""),
      allowedGroupOpenids: parseOpenidList(fields.channelsQqBotGroupAllowlistEl?.value ?? ""),
    };
    if (fields.channelsQqBotAppSecretEl?.value) update.appSecret = fields.channelsQqBotAppSecretEl.value;
    try {
      await bridge.channelsSaveConfig({ qqbot: update });
      await bridge.channelsRestart();
      const current = await bridge.channelsGetStatus() as Record<string, { phase?: string; message?: string }>;
      if (fields.channelsQqBotAppSecretEl) {
        fields.channelsQqBotAppSecretEl.value = "";
        fields.channelsQqBotAppSecretEl.placeholder = "已保存（输入新值会覆盖）";
      }
      setQqBotFeedback(current.qqbot?.phase === "running" ? "ok" : "info", current.qqbot?.phase === "running"
        ? "网关已连接，机器人已上线。" : `已保存（当前状态：${current.qqbot?.message ?? current.qqbot?.phase ?? "未知"}）`);
    } catch (failure) { setQqBotFeedback("err", errorText(failure)); }
  });
  fields.channelsQqBotTestBtn?.addEventListener("click", async () => {
    setQqBotFeedback("info", "正在校验 AppID / AppSecret…");
    try {
      const response = await bridge.channelsQqBotTestConnection();
      setQqBotFeedback(response.ok ? "ok" : "err", response.ok ? "凭证有效，可以正常连接 QQ 开放平台。" : response.error ?? "连接失败");
    } catch (failure) { setQqBotFeedback("err", errorText(failure)); }
  });
}
